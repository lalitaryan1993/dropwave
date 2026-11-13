// Headless end-to-end test: two engines in one process talk over localhost.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Engine } = require('../electron/engine.cjs');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function waitFor(engine, id, statuses = ['completed', 'failed', 'rejected', 'cancelled']) {
  return new Promise((resolve) => {
    const on = (t) => { if (t.id === id && statuses.includes(t.status)) { engine.off('transfer', on); resolve(t); } };
    engine.on('transfer', on);
  });
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dropwave-test-'));
  const src = path.join(root, 'src');
  const inboxB = path.join(root, 'inboxB');
  await fsp.mkdir(path.join(src, 'Album', 'Nested'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Album', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(src, 'Album', 'empty.bin'), '');
  fs.writeFileSync(path.join(src, 'Album', 'Nested', 'b.bin'), crypto.randomBytes(3 * 1024 * 1024 + 7));
  fs.writeFileSync(path.join(src, 'big.bin'), crypto.randomBytes(60 * 1024 * 1024));

  let acceptB = true;
  const A = new Engine({ id: 'A', name: 'PC-A', saveDir: path.join(root, 'inboxA'), port: 48001, discoveryPort: 48100 });
  const B = new Engine({ id: 'B', name: 'PC-B', saveDir: inboxB, port: 48002, discoveryPort: 48100, decide: async () => acceptB });
  await A.start();
  await B.start();

  // 1. Add by IP
  const peerB = await A.probe('127.0.0.1', 48002);
  assert.equal(peerB.name, 'PC-B');
  await assert.rejects(A.probe('127.0.0.1', 48001), /this computer/);
  console.log('ok  add by IP');

  // 2. Folder + big file
  let t0 = Date.now();
  let id = await A.sendPaths(peerB, [path.join(src, 'Album'), path.join(src, 'big.bin')]);
  const [sent, recv] = await Promise.all([
    waitFor(A, id),
    new Promise((r) => B.on('transfer', function on(t) { if (t.direction === 'in' && ['completed', 'failed'].includes(t.status)) { B.off('transfer', on); r(t); } })),
  ]);
  assert.equal(sent.status, 'completed', sent.error);
  assert.equal(recv.status, 'completed', recv.error);
  for (const rel of ['Album/a.txt', 'Album/empty.bin', 'Album/Nested/b.bin', 'big.bin']) {
    assert.equal(sha(path.join(inboxB, rel)), sha(path.join(src, rel)), rel);
  }
  const mb = (sent.total / 1048576).toFixed(1);
  console.log(`ok  folder + 60MB file (${mb} MB in ${Date.now() - t0} ms, checksums match)`);

  // 3. Same name again -> renamed, not overwritten
  id = await A.sendPaths(peerB, [path.join(src, 'big.bin')]);
  assert.equal((await waitFor(A, id)).status, 'completed');
  assert.ok(fs.existsSync(path.join(inboxB, 'big (1).bin')));
  console.log('ok  duplicate name saved as "big (1).bin"');

  // 3b. "Play now" stream info reaches the receiver as a URL built from the sender's IP
  let seenRequest = null;
  const prevDecide = B.decide;
  B.decide = async (r) => { seenRequest = r; return true; };
  const token = 'ab'.repeat(16);
  id = await A.sendPaths(peerB, [path.join(src, 'Album', 'a.txt')], { streamLink: () => ({ token, port: 47823 }) });
  assert.equal((await waitFor(A, id)).status, 'completed');
  assert.equal(seenRequest.stream, `http://127.0.0.1:47823/s/${token}`);
  B.decide = prevDecide;
  console.log('ok  "Play now" stream link travels with the offer');

  // 3c. Text / clipboard sharing — and it is encrypted on the wire
  const wire = [];
  const sniff = (raw) => raw.on('data', (c) => wire.push(c));
  B.server.on('connection', sniff);
  const gotText = new Promise((r) => B.once('text', r));
  await A.sendText(peerB, 'https://example.com/doc — see this');
  B.server.off('connection', sniff);
  assert.ok(!Buffer.concat(wire).includes('example.com'), 'text must not travel in plaintext');
  const tm = await gotText;
  assert.equal(tm.text, 'https://example.com/doc — see this');
  assert.equal(tm.from.name, 'PC-A');
  console.log('ok  text / clipboard sharing between PCs (encrypted on the wire)');

  // 4. Rejected
  acceptB = false;
  id = await A.sendPaths(peerB, [path.join(src, 'Album', 'a.txt')]);
  assert.equal((await waitFor(A, id)).status, 'rejected');
  console.log('ok  reject');

  // 5. Cancel mid-transfer
  acceptB = true;
  id = await A.sendPaths(peerB, [path.join(src, 'big.bin')]);
  await new Promise((r) => A.on('transfer', function on(t) { if (t.id === id && t.done > 5 * 1048576) { A.off('transfer', on); r(); } }));
  const cancelled = waitFor(A, id);
  A.cancel(id);
  assert.equal((await cancelled).status, 'cancelled');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.existsSync(path.join(inboxB, 'big (2).bin')), 'partial file should be removed');
  console.log('ok  cancel (partial file cleaned up)');

  // 5b. Receiver cancels: sender stops too (no reconnect / resume)
  id = await A.sendPaths(peerB, [path.join(src, 'big.bin')]);
  await new Promise((r) => B.on('transfer', function on(t) { if (t.direction === 'in' && t.status === 'active' && t.done > 5 * 1048576) { B.off('transfer', on); B.cancel(t.id); r(); } }));
  const senderSide = await waitFor(A, id);
  assert.equal(senderSide.status, 'cancelled');
  assert.match(senderSide.error, /other device/);
  console.log('ok  receiver cancel stops the sender (no silent retry)');

  // 5c. Connection drops mid-transfer -> sender reconnects and resumes where it stopped
  let prompts = 0;
  B.decide = async () => { prompts++; return true; };
  const statuses = new Set();
  t0 = Date.now();
  const recvDone = new Promise((r) => B.on('transfer', function on(t) { if (t.direction === 'in' && t.status === 'completed') { B.off('transfer', on); r(t); } }));
  id = await A.sendPaths(peerB, [path.join(src, 'Album'), path.join(src, 'big.bin')]);
  A.on('transfer', function track(t) { if (t.id === id) statuses.add(t.status); if (t.id === id && ['completed', 'failed', 'cancelled'].includes(t.status)) A.off('transfer', track); });
  await new Promise((r) => A.on('transfer', function on(t) { if (t.id === id && t.done > 30 * 1048576) { A.off('transfer', on); r(); } }));
  A.transfers.get(id).socket.raw.destroy(); // pull the cable
  const resumedSend = await waitFor(A, id);
  assert.equal(resumedSend.status, 'completed', resumedSend.error);
  assert.ok(statuses.has('reconnecting'), 'should show reconnecting');
  assert.ok(resumedSend.resumed, 'sender should have resumed, not restarted');
  assert.equal(prompts, 1, 'resume must not ask the receiver again');
  const recvT = await recvDone;
  assert.ok(recvT.resumed, 'receiver should have continued the partial file');
  const savedBig = recvT.savedTo.find((p) => /big.*\.bin$/.test(p));
  assert.equal(sha(savedBig), sha(path.join(src, 'big.bin')));
  assert.equal(sha(path.join(recvT.savedTo.find((p) => /Album/.test(p)), 'Nested', 'b.bin')), sha(path.join(src, 'Album', 'Nested', 'b.bin')));
  console.log(`ok  dropped connection resumes and finishes (${Date.now() - t0} ms, checksums match)`);
  B.decide = async () => acceptB;

  // 5d. Identity pinning: someone pretending to be PC-A with a different key is refused
  const fakeA = new Engine({ id: 'A', name: 'PC-A', saveDir: path.join(root, 'fake'), port: 48003, discoveryPort: 48101 });
  await fakeA.start();
  await assert.rejects(fakeA.sendText({ id: 'B', name: 'PC-B', ip: '127.0.0.1', port: 48002 }, 'hi'), /closed|identity|handshake/i);
  await fakeA.stop();
  console.log('ok  impostor with a different identity key is refused');

  // 6. Unreachable
  id = await A.sendPaths({ id: 'X', name: 'X', ip: '127.0.0.1', port: 48999 }, [path.join(src, 'Album', 'a.txt')]);
  assert.equal((await waitFor(A, id)).status, 'failed');
  console.log('ok  unreachable device reported');

  await A.stop();
  await B.stop();
  await fsp.rm(root, { recursive: true, force: true });
  console.log('\nAll engine tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
