// Browser access for phones, tablets and TVs — no app install needed.
//
// The PC runs a small HTTP server. A phone opens http://<pc-ip>:47823, unlocks it with the
// 6-digit PIN (or the QR code, which carries the PIN), and then:
//   - uploads files to the PC (saved to the receive folder), or to another connected browser
//     (relayed through the PC);
//   - receives files the PC (or another browser) sends it, as download links pushed over
//     Server-Sent Events.
// Connected browsers show up in the desktop app as devices you can drop files on.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DEFAULT_WEB_PORT = 47823;
const COOKIE = 'dropwave_key';
const CLIENT_GRACE_MS = 6000;
const SHARE_TTL_MS = 2 * 60 * 60 * 1000;
const PROGRESS_EVERY_MS = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.heic': 'image/heic', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

function safeName(p) {
  const parts = String(p).split(/[\\/]+/).map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim()).filter((s) => s && s !== '.' && s !== '..');
  return parts.length ? parts.join(path.sep) : 'file';
}

async function uniquePath(p) {
  const exists = async (x) => fsp.access(x).then(() => true, () => false);
  if (!(await exists(p))) return p;
  const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
  for (let i = 1; ; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(c))) return c;
  }
}

function deviceFromUA(ua = '') {
  if (/iPhone/.test(ua)) return { kind: 'phone', name: 'iPhone' };
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return { kind: 'tablet', name: 'iPad' };
  if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|HbbTV|AFT\w|Android TV|GoogleTV|CrKey/i.test(ua)) return { kind: 'tv', name: 'TV' };
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? { kind: 'phone', name: 'Android phone' } : { kind: 'tablet', name: 'Android tablet' };
  if (/Windows/.test(ua)) return { kind: 'computer', name: 'Windows browser' };
  if (/Macintosh/.test(ua)) return { kind: 'computer', name: 'Mac browser' };
  if (/Linux/.test(ua)) return { kind: 'computer', name: 'Linux browser' };
  return { kind: 'phone', name: 'Browser' };
}

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};

class WebShare extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => {id,name}} o.me          this PC's identity
   * @param {() => string} o.saveDir
   * @param {() => string} o.pin            current 6-digit PIN
   * @param {string} o.webRoot              folder with the phone page
   * @param {number} [o.port]
   */
  constructor(o) {
    super();
    this.o = o;
    this.port = o.port || DEFAULT_WEB_PORT;
    this.clients = new Map();  // id -> { id, name, kind, ip, streams:Set<res>, lastSeen }
    this.shares = new Map();   // id -> share (files offered to a browser)
    this.uploads = new Map();  // batchId -> upload batch
    this.failedLogins = new Map(); // ip -> { n, until }
    this.relayDir = path.join(os.tmpdir(), 'dropwave-relay');
    this.server = null;
    this.timer = null;
  }

  // ---------- lifecycle ----------

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.#route(req, res).catch((e) => {
        if (!res.headersSent) json(res, 500, { error: e.message });
        else res.destroy();
      }));
      server.requestTimeout = 0; // big uploads
      server.headersTimeout = 30000;
      server.once('error', reject);
      server.listen(this.port, '0.0.0.0', () => {
        server.off('error', reject);
        this.server = server;
        this.timer = setInterval(() => this.#sweep(), 2000);
        resolve();
      });
    });
  }

  async stop() {
    clearInterval(this.timer);
    for (const c of this.clients.values()) for (const s of c.streams) s.end();
    if (this.server) await new Promise((r) => { this.server.closeAllConnections?.(); this.server.close(() => r()); });
    this.server = null;
  }

  // After a PIN change: drop every connected browser (their cookie no longer matches).
  kickAll() {
    for (const c of this.clients.values()) for (const s of c.streams) s.end();
    this.clients.clear();
    this.emit('clients', this.clientList());
  }

  clientList() {
    return [...this.clients.values()].map((c) => ({ id: c.id, name: c.name, kind: c.kind, ip: c.ip, web: true, platform: c.kind }));
  }

  #sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, c] of this.clients) {
      if (!c.streams.size && now - c.lastSeen > CLIENT_GRACE_MS) { this.clients.delete(id); changed = true; }
    }
    for (const [id, s] of this.shares) {
      if (now - s.created > SHARE_TTL_MS) { this.shares.delete(id); if (s.relayDir) fsp.rm(s.relayDir, { recursive: true, force: true }).catch(() => {}); }
    }
    if (changed) this.emit('clients', this.clientList());
  }

  // ---------- auth ----------

  #authed(req) {
    const k = parseCookies(req.headers.cookie)[COOKIE];
    return !!k && k === this.#cookieValue();
  }
  // Cookie is derived from the PIN, so changing the PIN logs every browser out.
  #cookieValue() { return crypto.createHash('sha256').update(`dropwave:${this.o.pin()}:${this.o.me().id}`).digest('hex').slice(0, 32); }
  #setCookie() { return `${COOKIE}=${this.#cookieValue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`; }

  #tryPin(req, pin) {
    const ip = req.socket.remoteAddress;
    const f = this.failedLogins.get(ip);
    if (f && f.until > Date.now()) return 'locked';
    if (String(pin).replace(/\D/g, '') === this.o.pin()) { this.failedLogins.delete(ip); return 'ok'; }
    const n = (f?.n || 0) + 1;
    this.failedLogins.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
    return 'bad';
  }

  // ---------- routing ----------

  async #route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

    // QR code link: /?k=PIN unlocks and redirects to a clean URL.
    if (p === '/' && url.searchParams.has('k')) {
      const r = this.#tryPin(req, url.searchParams.get('k'));
      res.writeHead(302, { Location: '/', ...(r === 'ok' ? { 'Set-Cookie': this.#setCookie() } : {}) });
      return res.end();
    }

    if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/dl/')) return this.#static(p, res);

    if (p === '/api/hello') {
      const me = this.o.me();
      return json(res, 200, { pc: { id: me.id, name: me.name }, authed: this.#authed(req) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const body = await readJson(req, 1024);
      const r = this.#tryPin(req, body.pin);
      if (r === 'locked') return json(res, 429, { error: 'Too many wrong PINs. Wait a minute and try again.' });
      if (r === 'bad') return json(res, 401, { error: 'Wrong PIN' });
      return json(res, 200, { ok: true }, { 'Set-Cookie': this.#setCookie() });
    }

    if (!this.#authed(req)) return json(res, 401, { error: 'Locked' });

    if (p === '/api/events') return this.#events(req, res, url, ip);
    if (p === '/api/rename' && req.method === 'POST') {
      const b = await readJson(req, 2048);
      const c = this.clients.get(String(b.id));
      if (c) { c.name = String(b.name || '').trim().slice(0, 40) || c.name; this.emit('clients', this.clientList()); this.#broadcastPeers(); }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/batch' && req.method === 'POST') return this.#newBatch(req, res);
    if (p === '/api/upload' && req.method === 'POST') return this.#upload(req, res, url);
    if (p === '/api/cancel' && req.method === 'POST') {
      const b = await readJson(req, 1024);
      this.cancel(String(b.id));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/decline' && req.method === 'POST') {
      const b = await readJson(req, 1024);
      const s = this.shares.get(String(b.id));
      if (s && s.status === 'waiting') { s.status = 'rejected'; s.error = 'Declined'; this.#emitShare(s, true); this.shares.delete(s.id); }
      return json(res, 200, { ok: true });
    }
    const dl = p.match(/^\/dl\/([\w-]+)\/(\d+)(?:\/.*)?$/);
    if (dl && req.method === 'GET') return this.#download(req, res, dl[1], Number(dl[2]), url);
    return json(res, 404, { error: 'Not found' });
  }

  async #static(p, res) {
    const root = this.o.webRoot;
    const file = path.normalize(path.join(root, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': mimeOf(file),
        'Cache-Control': file.endsWith('.html') ? 'no-store' : 'max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        ...(file.endsWith('.html') ? { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:" } : {}),
      });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  }

  // ---------- live connection (SSE) ----------

  #events(req, res, url, ip) {
    const id = String(url.searchParams.get('id') || '').slice(0, 64) || crypto.randomUUID();
    const guess = deviceFromUA(req.headers['user-agent']);
    let c = this.clients.get(id);
    const isNew = !c;
    if (!c) {
      c = { id, name: String(url.searchParams.get('name') || '').slice(0, 40) || guess.name, kind: guess.kind, ip, streams: new Set(), lastSeen: Date.now() };
      this.clients.set(id, c);
    }
    c.ip = ip;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    c.streams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); c.streams.delete(res); c.lastSeen = Date.now(); });

    this.#send(c, 'hello', { you: { id: c.id, name: c.name, kind: c.kind }, pc: this.o.me() });
    // Re-deliver offers that are still waiting for this browser (e.g. after a reload).
    for (const s of this.shares.values()) if (s.toId === c.id && ['waiting', 'active'].includes(s.status)) this.#send(c, 'offer', this.#offerPayload(s));
    if (isNew) this.emit('clients', this.clientList());
    this.#broadcastPeers();
  }

  #send(c, event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of c.streams) s.write(msg);
  }

  // Each browser sees the PC plus every other connected browser as a send target.
  #broadcastPeers() {
    const me = this.o.me();
    for (const c of this.clients.values()) {
      const peers = [{ id: me.id, name: me.name, kind: 'computer', pc: true },
        ...[...this.clients.values()].filter((x) => x.id !== c.id).map((x) => ({ id: x.id, name: x.name, kind: x.kind }))];
      this.#send(c, 'peers', peers);
    }
  }

  // ---------- browser -> PC / browser ----------

  async #newBatch(req, res) {
    const b = await readJson(req, 512 * 1024);
    const from = this.clients.get(String(b.from));
    if (!from) return json(res, 400, { error: 'Reconnect and try again' });
    const files = (Array.isArray(b.files) ? b.files : []).slice(0, 5000).map((f) => ({ name: safeName(f.name), size: Math.max(0, Number(f.size) || 0) }));
    if (!files.length) return json(res, 400, { error: 'No files' });
    const me = this.o.me();
    const toPc = !b.to || b.to === me.id;
    const target = toPc ? null : this.clients.get(String(b.to));
    if (!toPc && !target) return json(res, 400, { error: 'That device is no longer connected' });

    const id = crypto.randomUUID();
    const dir = toPc ? this.o.saveDir() : path.join(this.relayDir, id);
    await fsp.mkdir(dir, { recursive: true });
    const batch = {
      id, from, toPc, target, dir, files, received: new Array(files.length).fill(false), paths: [],
      t: {
        id, direction: 'in', web: true,
        from: { id: from.id, name: from.name, kind: from.kind },
        files: files.map((f) => ({ name: f.name.split(path.sep).join('/'), size: f.size })),
        count: files.length, total: files.reduce((a, f) => a + f.size, 0), done: 0,
        status: 'active', startedAt: Date.now(), savedTo: [],
        ...(toPc ? {} : { relayTo: target.name }),
      },
      lastEmit: 0, reqs: new Set(),
    };
    this.uploads.set(id, batch);
    if (toPc) this.emit('transfer', this.#withSpeed(batch.t));
    return json(res, 200, { id });
  }

  async #upload(req, res, url) {
    const batch = this.uploads.get(String(url.searchParams.get('batch')));
    const i = Number(url.searchParams.get('i'));
    if (!batch || !(i >= 0 && i < batch.files.length) || batch.received[i]) { req.resume(); return json(res, 400, { error: 'Unknown upload' }); }
    const f = batch.files[i];
    const dest = await uniquePath(path.join(batch.dir, f.name));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    batch.reqs.add(req);
    let got = 0;
    let failed = false;
    const fail = (msg) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fsp.rm(dest, { force: true }).catch(() => {});
      batch.reqs.delete(req);
      if (batch.t.status === 'active') {
        batch.t.status = batch.t.status === 'cancelled' ? 'cancelled' : 'failed';
        batch.t.error = msg;
        this.#finishBatch(batch);
      }
      if (!res.headersSent) json(res, 400, { error: msg });
    };
    req.on('data', (chunk) => {
      got += chunk.length;
      batch.t.done += chunk.length;
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
      this.#emitBatch(batch, false);
    });
    req.on('aborted', () => fail('Upload interrupted'));
    req.on('error', () => fail('Upload interrupted'));
    out.on('error', (e) => fail(`Can't save file: ${e.message}`));
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        batch.reqs.delete(req);
        if (got !== f.size) return fail('File arrived incomplete');
        batch.received[i] = true;
        batch.paths[i] = dest;
        json(res, 200, { ok: true });
        if (batch.received.every(Boolean)) {
          batch.t.status = 'completed';
          batch.t.done = batch.t.total;
          this.#finishBatch(batch);
        }
      });
    });
  }

  #emitBatch(batch, force) {
    const now = Date.now();
    if (!force && now - batch.lastEmit < PROGRESS_EVERY_MS) return;
    batch.lastEmit = now;
    if (batch.toPc) this.emit('transfer', this.#withSpeed(batch.t));
  }

  #finishBatch(batch) {
    this.uploads.delete(batch.id);
    batch.t.finishedAt = Date.now();
    if (batch.toPc) {
      const tops = new Set(batch.paths.filter(Boolean).map((p) => path.join(batch.dir, path.relative(batch.dir, p).split(path.sep)[0])));
      batch.t.savedTo = [...tops];
      this.emit('transfer', this.#withSpeed(batch.t));
      return;
    }
    if (batch.t.status !== 'completed') { fsp.rm(batch.dir, { recursive: true, force: true }).catch(() => {}); return; }
    // Relay: offer the uploaded files to the target browser.
    this.offer(batch.target.id, batch.paths.map((abs, k) => ({ abs, name: batch.t.files[k].name, size: batch.files[k].size })),
      { id: batch.from.id, name: batch.from.name }, batch.dir);
  }

  // ---------- PC / browser -> browser ----------

  /** Offer files to a connected browser. files: [{abs, name, size}] */
  offer(clientId, files, from = null, relayDir = null) {
    const c = this.clients.get(clientId);
    if (!c) throw new Error('That device is no longer connected');
    const me = this.o.me();
    const id = crypto.randomUUID();
    const s = {
      id, toId: c.id, created: Date.now(), relayDir, status: 'waiting',
      files: files.map((f) => ({ ...f, sent: 0, done: false })),
      fromRelay: !!from,
      t: {
        id, direction: 'out', web: true,
        to: { id: c.id, name: c.name, kind: c.kind },
        files: files.map((f) => ({ name: f.name, size: f.size })), count: files.length,
        total: files.reduce((a, f) => a + f.size, 0), done: 0, status: 'waiting', startedAt: Date.now(),
      },
      from: from || { id: me.id, name: me.name },
      lastEmit: 0,
    };
    this.shares.set(id, s);
    this.#send(c, 'offer', this.#offerPayload(s));
    this.#emitShare(s, true);
    return id;
  }

  #offerPayload(s) {
    return {
      id: s.id, from: s.from, total: s.t.total,
      files: s.files.map((f, i) => ({ name: f.name, size: f.size, type: mimeOf(f.name), url: `/dl/${s.id}/${i}/${encodeURIComponent(path.basename(f.name))}` })),
    };
  }

  #emitShare(s, force) {
    const now = Date.now();
    if (!force && now - s.lastEmit < PROGRESS_EVERY_MS) return;
    s.lastEmit = now;
    s.t.status = s.status;
    s.t.done = s.files.reduce((a, f) => a + (f.done ? f.size : Math.min(f.sent, f.size)), 0);
    if (!s.fromRelay) this.emit('transfer', this.#withSpeed(s.t));
  }

  async #download(req, res, shareId, i, url) {
    const s = this.shares.get(shareId);
    const f = s?.files[i];
    if (!s || !f || s.status === 'rejected' || s.status === 'cancelled') return json(res, 404, { error: 'This file is no longer available' });
    let st;
    try { st = await fsp.stat(f.abs); } catch { return json(res, 410, { error: 'File was moved or deleted on the PC' }); }

    // ?thumb = list thumbnail (never counts as delivered), ?view = opened in the browser
    // (counts as delivered), neither = real download.
    const thumb = url.searchParams.has('thumb');
    const inline = thumb || url.searchParams.has('view');
    const headers = {
      'Content-Type': mimeOf(f.name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(f.name))}`,
    };
    // Range support so TVs/phones can seek in videos.
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    let start = 0, end = st.size - 1;
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
    }
    if (req.method === 'HEAD') return res.end();

    const rs = fs.createReadStream(f.abs, { start, end, highWaterMark: 1024 * 1024 });
    if (thumb) { rs.pipe(res); res.on('close', () => rs.destroy()); return; }

    if (s.status === 'waiting') { s.status = 'active'; s.t.startedAt = Date.now(); }
    const full = !range && !inline;
    let sent = 0;
    rs.on('data', (chunk) => {
      sent += chunk.length;
      if (full) f.sent = Math.max(f.sent, sent);
      this.#emitShare(s, false);
    });
    rs.pipe(res);
    res.on('close', () => {
      rs.destroy();
      // A full download, or playing/viewing it in the browser, counts as delivered.
      if ((full && sent === st.size) || !full) f.done = true;
      if (s.files.every((x) => x.done) && s.status !== 'completed') {
        s.status = 'completed';
        s.t.finishedAt = Date.now();
      }
      this.#emitShare(s, true);
    });
  }

  cancel(id) {
    const b = this.uploads.get(id);
    if (b) {
      b.t.status = 'cancelled';
      b.t.error = 'Cancelled';
      for (const r of b.reqs) r.destroy();
      this.#finishBatch(b);
      return true;
    }
    const s = this.shares.get(id);
    if (s && ['waiting', 'active'].includes(s.status)) {
      s.status = 'cancelled';
      s.t.error = 'Cancelled';
      s.t.finishedAt = Date.now();
      const c = this.clients.get(s.toId);
      if (c) this.#send(c, 'offer-closed', { id });
      this.#emitShare(s, true);
      this.shares.delete(id);
      return true;
    }
    return false;
  }

  #withSpeed(t) {
    const secs = Math.max(0.001, (Date.now() - t.startedAt) / 1000);
    const bps = t.status === 'active' ? t.done / secs : 0;
    return { ...t, bps, eta: bps > 0 ? (t.total - t.done) / bps : null };
  }
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

module.exports = { WebShare, DEFAULT_WEB_PORT, deviceFromUA };
