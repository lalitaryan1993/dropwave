// DropWave transfer engine — pure Node (no Electron imports) so it can be tested headless.
//
// Discovery: UDP broadcast on DISCOVERY_PORT every 2 s.
// Transfer protocol over TCP (one connection per batch):
//   sender  -> {"type":"offer", from, files:[{path,size}], total}\n
//   receiver-> {"type":"accept"}\n | {"type":"reject","reason"}\n
//   sender  -> raw bytes of every file, back to back, in offer order
//   sender  -> {"type":"checksums","sha256":[...]}\n
//   receiver-> {"type":"done","ok":true|false}\n
// Info probe (manual "add by IP"):
//   client  -> {"type":"info"}\n   server -> {"type":"info", ...device}\n

const dgram = require('node:dgram');
const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DISCOVERY_PORT = 47821;
const DEFAULT_TCP_PORT = 47822;
const ANNOUNCE_MS = 2000;
const PEER_TTL_MS = 7000;
const DECISION_TIMEOUT_MS = 60000;
const PROGRESS_EVERY_MS = 150;

const VIRTUAL_IF = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|vmnet|docker|Loopback|Bluetooth|tailscale|ZeroTier|Npcap/i;

// Real LAN adapters first (Wi-Fi / Ethernet), virtual ones last.
function localIPv4s() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      const bcast = ip.map((o, i) => (o | (~mask[i] & 255))).join('.');
      out.push({ address: a.address, broadcast: bcast, ifname, virtual: VIRTUAL_IF.test(ifname) });
    }
  }
  return out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
}

// Keep only safe relative path segments: no drive letters, no "..", no absolute paths.
function safeRelPath(p) {
  const parts = String(p)
    .split(/[\\/]+/)
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return parts.length ? parts.join(path.sep) : 'file';
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// "photo.jpg" -> "photo (1).jpg" if taken.
async function uniquePath(p) {
  if (!(await exists(p))) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 1; ; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(c))) return c;
  }
}

// Expand dropped paths (files and folders) into a flat list with relative names.
async function collectFiles(paths) {
  const files = [];
  async function walk(abs, rel) {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      for (const name of await fsp.readdir(abs)) {
        await walk(path.join(abs, name), path.join(rel, name));
      }
    } else if (st.isFile()) {
      files.push({ abs, path: rel.split(path.sep).join('/'), size: st.size });
    }
  }
  for (const p of paths) await walk(p, path.basename(p));
  return files;
}

// Reads newline-terminated JSON messages from a socket and hands back leftover bytes.
class LineReader {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; }
  nextLine() {
    const i = this.buf.indexOf(10);
    if (i < 0) {
      if (this.buf.length > 4 * 1024 * 1024) throw new Error('Header too large');
      return null;
    }
    const line = this.buf.subarray(0, i).toString('utf8');
    this.buf = this.buf.subarray(i + 1);
    return JSON.parse(line);
  }
  take() { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
}

const send = (sock, obj) => sock.write(JSON.stringify(obj) + '\n');

class Engine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.name
   * @param {string} opts.saveDir
   * @param {number} [opts.port]
   * @param {number} [opts.discoveryPort]
   * @param {(offer)=>Promise<boolean>} opts.decide  resolve true to accept an incoming offer
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    this.saveDir = opts.saveDir;
    this.port = opts.port || DEFAULT_TCP_PORT;
    this.discoveryPort = opts.discoveryPort || DISCOVERY_PORT;
    this.decide = opts.decide || (async () => true);
    this.peers = new Map(); // id -> peer
    this.transfers = new Map(); // id -> { socket, cancel() }
    this.udp = null;
    this.server = null;
    this.timers = [];
  }

  info() {
    return { app: 'dropwave', v: 1, id: this.id, name: this.name, port: this.port, platform: process.platform };
  }

  async start() {
    await this.#startServer();
    this.#startDiscovery();
  }

  async stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const t of this.transfers.values()) t.cancel('App closed');
    if (this.udp) {
      try { this.#broadcast({ ...this.info(), bye: true }); } catch {}
      await new Promise((r) => setTimeout(r, 50));
      try { this.udp.close(); } catch {}
      this.udp = null;
    }
    if (this.server) await new Promise((r) => this.server.close(() => r()));
    this.server = null;
  }

  setName(name) { this.name = name; this.#announce(); }
  setSaveDir(dir) { this.saveDir = dir; }

  peerList() { return [...this.peers.values()]; }

  // ---------- discovery ----------

  #startDiscovery() {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = udp;
    udp.on('error', (err) => this.emit('log', `UDP error: ${err.message}`));
    udp.on('message', (msg, rinfo) => {
      let m;
      try { m = JSON.parse(msg.toString('utf8')); } catch { return; }
      if (m.app !== 'dropwave' || !m.id || m.id === this.id) return;
      if (m.bye) {
        const p = this.peers.get(m.id);
        if (p && !p.manual) { this.peers.delete(m.id); this.emit('peers', this.peerList()); }
        return;
      }
      this.#upsertPeer({ id: m.id, name: String(m.name || 'Unknown').slice(0, 64), ip: rinfo.address, port: Number(m.port) || DEFAULT_TCP_PORT, platform: m.platform });
      // Reply directly so a freshly started peer sees us without waiting a full cycle.
      if (m.hello) this.#sendTo(rinfo.address, this.info());
    });
    udp.bind(this.discoveryPort, () => {
      try { udp.setBroadcast(true); } catch {}
      this.#announce(true);
    });
    this.timers.push(setInterval(() => this.#announce(), ANNOUNCE_MS));
    this.timers.push(setInterval(() => this.#expirePeers(), 1000));
  }

  #upsertPeer(p) {
    const prev = this.peers.get(p.id);
    // A PC with several adapters announces from several IPs; stick to the one we already
    // use while it is still being heard from, so the address doesn't flap.
    if (prev && prev.ip !== p.ip && Date.now() - (prev.ipSeen || 0) < 4000) {
      prev.lastSeen = Date.now();
      return;
    }
    const peer = { ...prev, ...p, lastSeen: Date.now(), ipSeen: Date.now(), manual: prev?.manual || false };
    this.peers.set(p.id, peer);
    if (!prev || prev.name !== peer.name || prev.ip !== peer.ip || prev.port !== peer.port) {
      this.emit('peers', this.peerList());
    }
  }

  #expirePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (!p.manual && now - p.lastSeen > PEER_TTL_MS) { this.peers.delete(id); changed = true; }
    }
    if (changed) this.emit('peers', this.peerList());
  }

  #sendTo(ip, obj) {
    if (!this.udp) return;
    const buf = Buffer.from(JSON.stringify(obj));
    this.udp.send(buf, this.discoveryPort, ip, () => {});
  }

  #broadcast(obj) {
    const targets = new Set(['255.255.255.255', ...localIPv4s().map((i) => i.broadcast)]);
    for (const t of targets) this.#sendTo(t, obj);
  }

  #announce(hello = false) {
    if (!this.udp) return;
    try { this.#broadcast(hello ? { ...this.info(), hello: true } : this.info()); } catch {}
  }

  // Manually add a device by IP (for networks that block broadcast).
  probe(ip, port = DEFAULT_TCP_PORT, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: ip, port });
      const reader = new LineReader();
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('No DropWave device answered at that address')); }, timeoutMs);
      sock.on('connect', () => send(sock, { type: 'info' }));
      sock.on('data', (c) => {
        reader.push(c);
        let m;
        try { m = reader.nextLine(); } catch (e) { return; }
        if (!m) return;
        clearTimeout(timer);
        sock.end();
        if (m.type !== 'info' || m.app !== 'dropwave') return reject(new Error('Not a DropWave device'));
        if (m.id === this.id) return reject(new Error("That's this computer"));
        const peer = { id: m.id, name: m.name, ip, port: m.port || port, platform: m.platform, manual: true, lastSeen: Date.now() };
        this.peers.set(m.id, peer);
        this.emit('peers', this.peerList());
        resolve(peer);
      });
      sock.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ECONNREFUSED' ? 'DropWave is not running on that computer' : e.message)); });
    });
  }

  // ---------- receiving ----------

  #startServer() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.#handleIncoming(sock));
      server.once('error', reject);
      server.listen(this.port, '0.0.0.0', () => {
        server.off('error', reject);
        server.on('error', (e) => this.emit('log', `TCP error: ${e.message}`));
        this.server = server;
        resolve();
      });
    });
  }

  #handleIncoming(sock) {
    sock.setNoDelay(true);
    const reader = new LineReader();
    let state = 'header';
    let transfer = null;

    const onData = async (chunk) => {
      if (state === 'header') {
        reader.push(chunk);
        let m;
        try { m = reader.nextLine(); } catch { sock.destroy(); return; }
        if (!m) return;
        if (m.type === 'info') { send(sock, { type: 'info', ...this.info() }); sock.end(); state = 'closed'; return; }
        if (m.type !== 'offer' || !Array.isArray(m.files)) { sock.destroy(); return; }
        state = 'deciding';
        sock.pause();
        const leftover = reader.take();
        transfer = await this.#onOffer(sock, m);
        if (!transfer) { state = 'closed'; return; }
        state = 'data';
        sock.resume();
        if (leftover.length) transfer.onData(leftover);
        return;
      }
      if (state === 'data') transfer.onData(chunk);
    };

    sock.on('data', (c) => { onData(c).catch((e) => { this.emit('log', e.message); sock.destroy(); }); });
    sock.on('error', () => {});
    sock.on('close', () => { if (transfer && !transfer.finished) transfer.fail('Sender disconnected'); });
  }

  async #onOffer(sock, offer) {
    const files = offer.files.map((f) => ({ path: safeRelPath(f.path), size: Math.max(0, Number(f.size) || 0) }));
    const total = files.reduce((a, f) => a + f.size, 0);
    const from = { id: String(offer.from?.id || ''), name: String(offer.from?.name || sock.remoteAddress).slice(0, 64), ip: sock.remoteAddress?.replace(/^::ffff:/, '') };
    const id = crypto.randomUUID();
    const request = { id, direction: 'in', from, files: files.map((f) => ({ name: f.path, size: f.size })), total, count: files.length };

    let accepted = false;
    try {
      accepted = await Promise.race([
        this.decide(request),
        new Promise((r) => setTimeout(() => r(false), DECISION_TIMEOUT_MS)),
      ]);
    } catch { accepted = false; }
    this.emit('request-closed', id);

    if (!accepted || sock.destroyed) {
      if (!sock.destroyed) { send(sock, { type: 'reject', reason: 'Declined' }); sock.end(); }
      this.emit('transfer', { ...request, status: 'rejected', done: 0, finishedAt: Date.now() });
      return null;
    }

    await fsp.mkdir(this.saveDir, { recursive: true });
    // Rename the top-level item (file or folder) once if it already exists, then keep inner structure.
    const topRenames = new Map();
    for (const f of files) {
      const top = f.path.split(path.sep)[0];
      if (!topRenames.has(top)) {
        const target = await uniquePath(path.join(this.saveDir, top));
        topRenames.set(top, path.basename(target));
      }
      const parts = f.path.split(path.sep);
      parts[0] = topRenames.get(top);
      f.dest = path.join(this.saveDir, ...parts);
    }

    const t = {
      ...request,
      status: 'active', done: 0, startedAt: Date.now(),
      savedTo: [...new Set(files.map((f) => path.join(this.saveDir, f.dest.slice(this.saveDir.length + 1).split(path.sep)[0])))],
    };
    const reader = new LineReader();
    let idx = -1, remaining = 0, out = null, hash = null, waitingTrailer = false;
    const hashes = [];
    const flushed = []; // resolves when each file is fully on disk
    let lastEmit = 0;
    const self = this;
    const closeOut = (stream) => {
      flushed.push(new Promise((r) => stream.once('close', r)));
      stream.end();
    };

    const emitProgress = (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_EVERY_MS) return;
      lastEmit = now;
      self.emit('transfer', { ...t, ...speed(t) });
    };

    const openNext = () => {
      while (true) {
        idx++;
        if (idx >= files.length) { waitingTrailer = true; return; }
        const f = files[idx];
        fs.mkdirSync(path.dirname(f.dest), { recursive: true });
        out = fs.createWriteStream(f.dest);
        out.on('error', (e) => handle.fail(`Can't write file: ${e.message}`));
        hash = crypto.createHash('sha256');
        remaining = f.size;
        if (remaining > 0) return;
        closeOut(out); hashes.push(hash.digest('hex'));
      }
    };

    const handle = {
      finished: false,
      onData(chunk) {
        let off = 0;
        while (off < chunk.length && !handle.finished) {
          if (waitingTrailer) {
            reader.push(chunk.subarray(off));
            off = chunk.length;
            let m;
            try { m = reader.nextLine(); } catch { return handle.fail('Bad checksum message'); }
            if (!m) return;
            const ok = m.type === 'checksums' && Array.isArray(m.sha256) &&
              m.sha256.length === hashes.length && m.sha256.every((h, i) => h === hashes[i]);
            handle.finished = true;
            self.transfers.delete(id);
            Promise.all(flushed).then(() => {
              send(sock, { type: 'done', ok });
              sock.end();
              if (ok) { t.status = 'completed'; t.done = total; }
              else { t.status = 'failed'; t.error = 'Checksum mismatch — file may be corrupted'; }
              t.finishedAt = Date.now();
              self.emit('transfer', { ...t, ...speed(t) });
            });
            return;
          }
          const n = Math.min(remaining, chunk.length - off);
          const part = chunk.subarray(off, off + n);
          off += n;
          remaining -= n;
          t.done += n;
          hash.update(part);
          if (!out.write(part)) {
            // 'drain' never fires once the stream is ended, so also resume on 'close'.
            sock.pause();
            const stream = out;
            const resume = () => {
              stream.off('drain', resume);
              stream.off('close', resume);
              if (!sock.destroyed) sock.resume();
            };
            stream.on('drain', resume);
            stream.on('close', resume);
          }
          if (remaining === 0) {
            closeOut(out);
            hashes.push(hash.digest('hex'));
            openNext();
          }
        }
        emitProgress(false);
      },
      fail(reason) {
        if (handle.finished) return;
        handle.finished = true;
        self.transfers.delete(id);
        try { out?.destroy(); } catch {}
        if (idx >= 0 && idx < files.length && remaining > 0) fsp.rm(files[idx].dest, { force: true }).catch(() => {});
        sock.destroy();
        t.status = t.status === 'cancelled' ? 'cancelled' : 'failed';
        t.error = t.error || reason;
        t.finishedAt = Date.now();
        self.emit('transfer', { ...t, ...speed(t) });
      },
    };

    this.transfers.set(id, { socket: sock, cancel: (r) => { t.status = 'cancelled'; handle.fail(r || 'Cancelled'); } });
    send(sock, { type: 'accept' });
    openNext();
    emitProgress(true);
    return handle;
  }

  // ---------- sending ----------

  async sendPaths(peer, paths) {
    const files = await collectFiles(paths);
    if (!files.length) throw new Error('Nothing to send — the folder is empty');
    const total = files.reduce((a, f) => a + f.size, 0);
    const id = crypto.randomUUID();
    const t = {
      id, direction: 'out', to: { id: peer.id, name: peer.name, ip: peer.ip },
      files: files.map((f) => ({ name: f.path, size: f.size })), count: files.length, total,
      done: 0, status: 'waiting', startedAt: Date.now(),
    };
    const emit = () => this.emit('transfer', { ...t, ...speed(t) });
    emit();

    const sock = net.connect({ host: peer.ip, port: peer.port });
    sock.setNoDelay(true);
    const reader = new LineReader();
    let finished = false;
    let current = null;

    const finish = (status, error) => {
      if (finished) return;
      finished = true;
      this.transfers.delete(id);
      t.status = status;
      if (error) t.error = error;
      t.finishedAt = Date.now();
      try { current?.destroy(); } catch {}
      if (status !== 'completed') sock.destroy(); else sock.end();
      emit();
    };
    this.transfers.set(id, { socket: sock, cancel: (r) => finish('cancelled', r || 'Cancelled') });

    sock.on('error', (e) => finish('failed', e.code === 'ECONNREFUSED' ? 'Device is not reachable' : e.message));
    sock.on('close', () => { if (!finished) finish('failed', 'Connection closed by the other device'); });
    sock.on('connect', () => send(sock, { type: 'offer', from: { id: this.id, name: this.name }, files: files.map((f) => ({ path: f.path, size: f.size })), total }));

    let phase = 'await-accept';
    sock.on('data', (c) => {
      reader.push(c);
      let m;
      try { m = reader.nextLine(); } catch { return finish('failed', 'Bad reply'); }
      if (!m) return;
      if (phase === 'await-accept') {
        if (m.type === 'reject') return finish('rejected', 'Declined by the other device');
        if (m.type !== 'accept') return finish('failed', 'Unexpected reply');
        phase = 'sending';
        t.status = 'active';
        t.startedAt = Date.now();
        emit();
        this.#streamFiles(sock, files, t, emit, (s) => (current = s))
          .then((hashes) => { if (!finished) { phase = 'await-done'; send(sock, { type: 'checksums', sha256: hashes }); } })
          .catch((e) => finish('failed', e.message));
      } else if (phase === 'await-done' && m.type === 'done') {
        if (m.ok) { t.done = total; finish('completed'); }
        else finish('failed', 'Checksum mismatch on the other device');
      }
    });
    return id;
  }

  async #streamFiles(sock, files, t, emit, setCurrent) {
    const hashes = [];
    let lastEmit = 0;
    for (const f of files) {
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(f.abs, { highWaterMark: 1024 * 1024 });
        setCurrent(rs);
        rs.on('data', (chunk) => {
          hash.update(chunk);
          t.done += chunk.length;
          if (!sock.write(chunk)) { rs.pause(); sock.once('drain', () => rs.resume()); }
          const now = Date.now();
          if (now - lastEmit > PROGRESS_EVERY_MS) { lastEmit = now; emit(); }
        });
        rs.on('end', resolve);
        rs.on('error', reject);
        rs.on('close', () => { if (sock.destroyed) reject(new Error('Cancelled')); });
      });
      hashes.push(hash.digest('hex'));
    }
    emit();
    return hashes;
  }

  cancel(id) {
    const t = this.transfers.get(id);
    if (t) t.cancel('Cancelled');
  }
}

function speed(t) {
  const secs = Math.max(0.001, (Date.now() - (t.startedAt || Date.now())) / 1000);
  const bps = t.status === 'active' ? t.done / secs : 0;
  const eta = bps > 0 ? (t.total - t.done) / bps : null;
  return { bps, eta };
}

module.exports = { Engine, collectFiles, localIPv4s, safeRelPath, DEFAULT_TCP_PORT, DISCOVERY_PORT };
