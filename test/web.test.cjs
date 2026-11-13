// Headless test of the phone/TV browser access: login, phone->PC upload, PC->phone offer,
// phone->phone relay, range requests (TV video seeking), cancel.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { WebShare } = require('../electron/webshare.cjs');

const PORT = 48210;
const base = `http://127.0.0.1:${PORT}`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Minimal SSE client on top of fetch.
function sse(cookie, id, name) {
  const events = [];
  const waiters = [];
  const ctrl = new AbortController();
  (async () => {
    const r = await fetch(`${base}/api/events?id=${id}&name=${encodeURIComponent(name)}`, { headers: { cookie }, signal: ctrl.signal });
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (!ev) continue;
          const e = { ev, data: JSON.parse(data) };
          events.push(e);
          const w = waiters.find((x) => x.ev === ev);
          if (w) { waiters.splice(waiters.indexOf(w), 1); e.used = true; w.resolve(e.data); }
        }
      }
    } catch {}
  })();
  return {
    next: (ev) => new Promise((resolve) => {
      const seen = events.find((e) => e.ev === ev && !e.used);
      if (seen) { seen.used = true; return resolve(seen.data); }
      waiters.push({ ev, resolve });
    }),
    close: () => ctrl.abort(),
  };
}

const post = (p, cookie, body, raw = false) => fetch(base + p, {
  method: 'POST', headers: { cookie, ...(raw ? {} : { 'Content-Type': 'application/json' }) }, body: raw ? body : JSON.stringify(body),
});

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dropwave-web-'));
  const saveDir = path.join(root, 'inbox');
  const pcEvents = [];
  const web = new WebShare({
    me: () => ({ id: 'PC', name: 'Test PC' }), saveDir: () => saveDir, pin: () => '123456',
    webRoot: path.join(__dirname, '..', 'electron', 'web'), port: PORT,
  });
  web.on('transfer', (t) => pcEvents.push(t));
  await web.start();

  // 1. Auth
  assert.equal((await post('/api/batch', '', {})).status, 401);
  assert.equal((await post('/api/login', '', { pin: '000000' })).status, 401);
  const login = await post('/api/login', '', { pin: '123456' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page = await fetch(base + '/', { headers: { cookie } });
  assert.match(await page.text(), /DropWave/);
  console.log('ok  PIN login + page served');

  // 2. Two browsers connect
  const phone = sse(cookie, 'phone1', 'Riya iPhone');
  const tv = sse(cookie, 'tv1', 'Living room TV');
  await phone.next('hello'); await tv.next('hello');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(web.clientList().map((c) => c.name).sort(), ['Living room TV', 'Riya iPhone']);
  console.log('ok  phone + TV listed as devices');

  // 3. Phone -> PC
  const data = crypto.randomBytes(5 * 1024 * 1024 + 3);
  let r = await post('/api/batch', cookie, { from: 'phone1', to: 'PC', files: [{ name: 'clip.mp4', size: data.length }] });
  const { id: b1 } = await r.json();
  r = await post(`/api/upload?batch=${b1}&i=0`, cookie, data, true);
  assert.equal(r.status, 200);
  assert.equal(sha(fs.readFileSync(path.join(saveDir, 'clip.mp4'))), sha(data));
  assert.equal(pcEvents.at(-1).status, 'completed');
  console.log('ok  phone -> PC upload (hash match)');

  // 4. Phone -> TV relay
  const photo = crypto.randomBytes(300000);
  r = await post('/api/batch', cookie, { from: 'phone1', to: 'tv1', files: [{ name: 'photo.jpg', size: photo.length }] });
  const { id: b2 } = await r.json();
  await post(`/api/upload?batch=${b2}&i=0`, cookie, photo, true);
  const offer = await tv.next('offer');
  assert.equal(offer.from.name, 'Riya iPhone');
  const got = Buffer.from(await (await fetch(base + offer.files[0].url, { headers: { cookie } })).arrayBuffer());
  assert.equal(sha(got), sha(photo));
  assert.ok(!fs.existsSync(path.join(saveDir, 'photo.jpg')), 'relayed files must not land in the PC inbox');
  console.log('ok  phone -> TV relay (hash match, not saved on PC)');

  // 5. PC -> TV with range request (video seeking)
  const vid = path.join(root, 'movie.mp4');
  fs.writeFileSync(vid, crypto.randomBytes(1024 * 1024));
  web.offer('tv1', [{ abs: vid, name: 'movie.mp4', size: 1024 * 1024 }]);
  const o2 = await tv.next('offer');
  assert.equal(o2.files[0].type, 'video/mp4');
  r = await fetch(base + o2.files[0].url + '?view', { headers: { cookie, range: 'bytes=1000-1999' } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 1000);
  console.log('ok  PC -> TV video with range requests');

  // 6. Cancel an offer
  const sid = web.offer('phone1', [{ abs: vid, name: 'movie.mp4', size: 1024 * 1024 }]);
  const o3 = await phone.next('offer');
  // Loading a list thumbnail must not count as receiving the file.
  await (await fetch(base + o3.files[0].url + '?thumb', { headers: { cookie } })).arrayBuffer();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pcEvents.filter((t) => t.id === sid).at(-1).status, 'waiting');
  console.log('ok  thumbnail preview does not mark the file as delivered');
  web.cancel(sid);
  assert.equal((await phone.next('offer-closed')).id, sid);
  assert.equal((await fetch(`${base}/dl/${sid}/0/movie.mp4`, { headers: { cookie } })).status, 404);
  console.log('ok  cancelled offer is withdrawn');

  // 6b. PC-to-PC "Play now": token link works without the PIN, supports seeking, bad tokens 404
  const { token, port } = web.addStreamLink([{ abs: vid, name: 'movie.mp4' }]);
  assert.equal(port, PORT);
  r = await fetch(`${base}/s/${token}/0/movie.mp4`, { headers: { range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${base}/s/${'0'.repeat(32)}/0/x.mp4`)).status, 404);
  assert.equal((await fetch(`${base}/s/${token}/5/x.mp4`)).status, 404);
  console.log('ok  "Play now" stream link: no PIN needed, range requests, unknown tokens rejected');

  // 7. Path traversal is blocked
  r = await post('/api/batch', cookie, { from: 'phone1', to: 'PC', files: [{ name: '../../evil.txt', size: 4 }] });
  const { id: b3 } = await r.json();
  await post(`/api/upload?batch=${b3}&i=0`, cookie, Buffer.from('evil'), true);
  assert.ok(fs.existsSync(path.join(saveDir, 'evil.txt')) && !fs.existsSync(path.join(root, 'evil.txt')));
  console.log('ok  "../" in file names stays inside the receive folder');

  phone.close(); tv.close();
  await web.stop();
  await fsp.rm(root, { recursive: true, force: true });
  console.log('\nAll web tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
