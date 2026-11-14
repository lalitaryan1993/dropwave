// DropWave transfer engine — pure Node (no Electron imports) so it can be tested headless.
//
// Discovery: UDP broadcast on DISCOVERY_PORT every 2 s ({app, v, id, name, port, idKey}).
//
// Every TCP connection starts with an authenticated key exchange, then everything is encrypted:
//   client -> {"type":"hello", v, id, idKey, eph, sig}\n        (plaintext)
//   server -> {"type":"hello", v, id, idKey, eph, sig}\n        (plaintext)
//   ...then AES-256-GCM frames: [u32 length][ciphertext + 16-byte tag], counter nonces per direction.
// eph = fresh X25519 key per connection; idKey = the device's long-term Ed25519 key, which signs
// the handshake. Keys are pinned per device id on first contact (trust on first use).
//
// Inside the encrypted channel (one connection per batch):
//   sender  -> {"type":"offer", from, files:[{path,size}], total, tid, resume?, stream?}\n
//   receiver-> {"type":"accept", resumeAt?:{index,offset}}\n | {"type":"reject"}\n
//   sender  -> raw bytes of every file from resumeAt on, back to back
//   sender  -> {"type":"checksums","sha256":[...]}\n
//   receiver-> {"type":"done","ok":true|false}\n
// If the connection drops mid-transfer, the sender reconnects and re-offers with resume:true and
// the same tid; the receiver (which kept the partial file) answers with where to continue.
// Other requests: {"type":"info"} (add by IP) and {"type":"text", text} (clipboard sharing).

const dgram = require('node:dgram');
const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const PROTOCOL = 2;
const DISCOVERY_PORT = 47821;
const DEFAULT_TCP_PORT = 47822;
const ANNOUNCE_MS = 2000;
const PEER_TTL_MS = 7000;
const DECISION_TIMEOUT_MS = 60000;
const HANDSHAKE_TIMEOUT_MS = 8000;
const PROGRESS_EVERY_MS = 150;
const MAX_TEXT = 100 * 1024;
const FRAME_MAX = 64 * 1024;
const RETRY_DELAYS_MS = [1500, 3000, 6000, 12000, 20000, 30000];
const RESUME_WINDOW_MS = 2 * 60 * 1000;

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

// Feed bytes [start, end) of a file into a hash (used when resuming).
function hashRange(file, start, end, hash, setCurrent) {
  if (end <= start) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { start, end: end - 1, highWaterMark: 1024 * 1024 });
    setCurrent?.(rs);
    rs.on('data', (c) => hash.update(c));
    rs.on('end', resolve);
    rs.on('error', reject);
  });
}

// Reads newline-terminated JSON messages from a stream and hands back leftover bytes.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- encryption ----------

// Socket-like wrapper: what's written is AES-256-GCM encrypted in frames, what's read is
// decrypted and authenticated. Exposes the small socket API the engine uses.
class SecureChannel extends EventEmitter {
  constructor(raw, sendKey, recvKey) {
    super();
    this.raw = raw;
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendCtr = 0n;
    this.recvCtr = 0n;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.paused = false;
    this.remoteAddress = raw.remoteAddress;
    raw.on('data', (c) => this.feed(c));
    raw.on('drain', () => this.emit('drain'));
    // Deliver everything already received (data and control messages like "cancel")
    // before reporting the close, even if the reader is paused right now.
    raw.on('close', () => { this.closePending = true; this.#flush(); });
    raw.on('error', (e) => this.emit('error', e));
  }
  get destroyed() { return this.raw.destroyed; }
  setNoDelay(v) { this.raw.setNoDelay(v); }
  static nonce(ctr) { const n = Buffer.alloc(12); n.writeBigUInt64BE(ctr, 4); return n; }
  // Each frame's plaintext starts with a type byte: 0 = stream data, 1 = control message (JSON).
  #frame(type, payload) {
    const c = crypto.createCipheriv('aes-256-gcm', this.sendKey, SecureChannel.nonce(this.sendCtr++));
    const enc = Buffer.concat([c.update(Buffer.from([type])), c.update(payload), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(enc.length);
    return this.raw.write(Buffer.concat([len, enc]));
  }
  write(data) {
    if (typeof data === 'string') data = Buffer.from(data);
    let ok = true;
    for (let off = 0; off < data.length; off += FRAME_MAX) ok = this.#frame(0, data.subarray(off, off + FRAME_MAX)) && ok;
    return ok;
  }
  // Out-of-band message that can be sent even in the middle of a file (e.g. "cancel").
  control(msg) { if (!this.destroyed) this.#frame(1, Buffer.from(JSON.stringify(msg))); }
  feed(chunk) {
    if (!chunk.length) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 17 || len > FRAME_MAX + 17) { this.destroy(); return; }
      if (this.buf.length < 4 + len) break;
      const enc = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', this.recvKey, SecureChannel.nonce(this.recvCtr++));
        d.setAuthTag(enc.subarray(len - 16));
        const plain = Buffer.concat([d.update(enc.subarray(0, len - 16)), d.final()]);
        if (plain[0] === 1) this.queue.push({ control: JSON.parse(plain.subarray(1).toString('utf8')) });
        else this.queue.push(plain.subarray(1));
      } catch {
        this.emit('error', new Error('Integrity check failed — connection tampered with'));
        this.destroy();
        return;
      }
    }
    this.#flush();
  }
  #flush() {
    while (!this.paused && this.queue.length) {
      const item = this.queue.shift();
      if (Buffer.isBuffer(item)) { if (item.length) this.emit('data', item); } else this.emit('control', item.control);
    }
    if (this.closePending && !this.queue.length && !this.closeEmitted) { this.closeEmitted = true; this.emit('close'); }
  }
  pause() { this.paused = true; this.raw.pause(); }
  resume() { this.paused = false; this.#flush(); if (!this.paused) this.raw.resume(); }
  end() { this.raw.end(); }
  destroy() { this.raw.destroy(); }
}

const spkiB64 = (key) => key.export({ type: 'spki', format: 'der' }).toString('base64');
const keyFromB64 = (b64) => crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64'), type: 'spki', format: 'der' });
const fingerprint = (idKeyB64) => crypto.createHash('sha256').update(String(idKeyB64)).digest('hex').slice(0, 16).toUpperCase().match(/.{4}/g).join(' ');

class Engine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.name
   * @param {string} opts.saveDir
   * @param {number} [opts.port]
   * @param {number} [opts.discoveryPort]
   * @param {(offer)=>Promise<boolean>} opts.decide  resolve true to accept an incoming offer
   * @param {string} [opts.identityKey]  PEM Ed25519 private key (generated if missing)
   * @param {Record<string,string>} [opts.knownKeys]  device id -> pinned idKey
   * @param {(id:string, idKey:string)=>void} [opts.onNewKey]  persist a newly pinned key
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    this.saveDir = path.resolve(opts.saveDir);
    this.port = opts.port || DEFAULT_TCP_PORT;
    this.discoveryPort = opts.discoveryPort || DISCOVERY_PORT;
    this.decide = opts.decide || (async () => true);
    this.identity = opts.identityKey
      ? crypto.createPrivateKey(opts.identityKey)
      : crypto.generateKeyPairSync('ed25519').privateKey;
    this.idKey = spkiB64(crypto.createPublicKey(this.identity));
    this.knownKeys = { ...(opts.knownKeys || {}) };
    this.onNewKey = opts.onNewKey || (() => {});
    this.peers = new Map(); // id -> peer
    this.transfers = new Map(); // id -> { socket, cancel() }
    this.partials = new Map(); // tid -> interrupted incoming transfer waiting for its sender
    this.udp = null;
    this.server = null;
    this.timers = [];
  }

  static generateIdentityKey() {
    return crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  }

  get fingerprint() { return fingerprint(this.idKey); }

  info() {
    return { app: 'dropwave', v: PROTOCOL, id: this.id, name: this.name, port: this.port, platform: process.platform, idKey: this.idKey };
  }

  async start() {
    await this.#startServer();
    this.#startDiscovery();
  }

  async stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const t of this.transfers.values()) t.cancel('App closed');
    for (const p of this.partials.values()) clearTimeout(p.timer);
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
  setSaveDir(dir) { this.saveDir = path.resolve(dir); }

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
      this.#upsertPeer({
        id: m.id, name: String(m.name || 'Unknown').slice(0, 64), ip: rinfo.address,
        port: Number(m.port) || DEFAULT_TCP_PORT, platform: m.platform, v: Number(m.v) || 1,
        outdated: (Number(m.v) || 1) < PROTOCOL,
      });
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
    if (!prev || prev.name !== peer.name || prev.ip !== peer.ip || prev.port !== peer.port || prev.v !== peer.v) {
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

  // ---------- secure connections ----------

  // Trust on first use: remember each device's identity key; refuse if it ever changes.
  #checkPeerKey(id, idKey) {
    const known = this.knownKeys[id];
    if (known && known !== idKey) {
      throw Object.assign(new Error('Security warning: this device’s identity changed. Remove it from trusted devices in Settings only if you reinstalled DropWave on it.'), { security: true });
    }
    if (!known) { this.knownKeys[id] = idKey; this.onNewKey(id, idKey); }
  }

  forgetPeerKey(id) { delete this.knownKeys[id]; }

  // Runs the authenticated key exchange on a raw socket and returns an encrypted channel.
  #handshake(raw, isClient, expectId = null) {
    return new Promise((resolve, reject) => {
      const eph = crypto.generateKeyPairSync('x25519');
      const ephB64 = spkiB64(eph.publicKey);
      const reader = new LineReader();
      let theirHello = null;
      let done = false;
      const timer = setTimeout(() => fail(new Error('Device did not answer the secure handshake')), HANDSHAKE_TIMEOUT_MS);
      const fail = (e) => { if (done) return; done = true; clearTimeout(timer); raw.off('data', onData); raw.destroy(); reject(e); };

      const hello = (peerEph) => {
        // The client signs its own key; the server signs both, binding the reply to this session.
        const toSign = isClient ? Buffer.from(`client:${ephB64}`) : Buffer.from(`server:${peerEph}:${ephB64}`);
        return { type: 'hello', v: PROTOCOL, id: this.id, idKey: this.idKey, eph: ephB64, sig: crypto.sign(null, toSign, this.identity).toString('base64') };
      };

      const onData = (chunk) => {
        if (done) return;
        reader.push(chunk);
        let m;
        try { m = reader.nextLine(); } catch { return fail(new Error('Bad handshake')); }
        if (!m) return;
        raw.off('data', onData);
        try {
          if (m.type !== 'hello' || !m.id || !m.idKey || !m.eph || !m.sig) {
            throw new Error((m.type === 'offer' || m.type === 'info') ? 'That device runs an older DropWave — ask them to update' : 'Unexpected handshake');
          }
          if ((Number(m.v) || 1) < PROTOCOL) throw new Error('That device runs an older DropWave — ask them to update');
          const signed = isClient ? Buffer.from(`server:${ephB64}:${m.eph}`) : Buffer.from(`client:${m.eph}`);
          if (!crypto.verify(null, signed, keyFromB64(m.idKey), Buffer.from(m.sig, 'base64'))) throw new Error('Handshake signature invalid');
          if (expectId && m.id !== expectId) throw new Error('A different device answered at that address');
          this.#checkPeerKey(m.id, m.idKey);
          theirHello = m;
        } catch (e) { return fail(e); }

        if (!isClient) send(raw, hello(theirHello.eph));
        const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: keyFromB64(theirHello.eph) });
        const [cEph, sEph] = isClient ? [ephB64, theirHello.eph] : [theirHello.eph, ephB64];
        const okm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(cEph + sEph), Buffer.from('dropwave v2 channel'), 64));
        const c2s = okm.subarray(0, 32), s2c = okm.subarray(32);
        const ch = isClient ? new SecureChannel(raw, c2s, s2c) : new SecureChannel(raw, s2c, c2s);
        done = true;
        clearTimeout(timer);
        resolve({ ch, peerId: theirHello.id, peerKey: theirHello.idKey });
        // Anything that arrived right after the hello already belongs to the encrypted stream.
        const leftover = reader.take();
        if (leftover.length) setImmediate(() => ch.feed(leftover));
      };
      raw.on('data', onData);
      raw.on('error', (e) => fail(e));
      raw.on('close', () => fail(new Error('Connection closed during handshake')));
      if (isClient) send(raw, hello());
    });
  }

  #connect(host, port, expectId = null) {
    return new Promise((resolve, reject) => {
      const raw = net.connect({ host, port });
      raw.setNoDelay(true);
      raw.once('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'Device is not reachable' : e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' ? 'Device is not reachable on this network' : e.message)));
      raw.once('connect', () => this.#handshake(raw, true, expectId).then(resolve, reject));
    });
  }

  // Manually add a device by IP (for networks that block broadcast).
  async probe(ip, port = DEFAULT_TCP_PORT, timeoutMs = 6000) {
    let ch, peerId;
    try {
      ({ ch, peerId } = await Promise.race([
        this.#connect(ip, port),
        sleep(timeoutMs).then(() => { throw new Error('No DropWave device answered at that address'); }),
      ]));
    } catch (e) {
      throw new Error(/not reachable/.test(e.message) ? 'DropWave is not running on that computer' : e.message);
    }
    if (peerId === this.id) { ch.destroy(); throw new Error("That's this computer"); }
    const m = await new Promise((resolve, reject) => {
      const reader = new LineReader();
      ch.on('data', (c) => { reader.push(c); try { const x = reader.nextLine(); if (x) resolve(x); } catch (e) { reject(e); } });
      ch.on('error', reject);
      send(ch, { type: 'info' });
    });
    ch.end();
    if (m.type !== 'info' || m.app !== 'dropwave') throw new Error('Not a DropWave device');
    const peer = { id: peerId, name: m.name, ip, port: m.port || port, platform: m.platform, v: m.v, manual: true, lastSeen: Date.now() };
    this.peers.set(peerId, peer);
    this.emit('peers', this.peerList());
    return peer;
  }

  // Send a piece of text (e.g. the clipboard) to another PC.
  async sendText(peer, text, timeoutMs = 8000) {
    const body = String(text || '').slice(0, MAX_TEXT);
    if (!body) throw new Error('Nothing to send');
    if (peer.outdated) throw new Error(`${peer.name} needs to update DropWave`);
    const { ch } = await this.#connect(peer.ip, peer.port, peer.id);
    await new Promise((resolve, reject) => {
      const reader = new LineReader();
      const timer = setTimeout(() => { ch.destroy(); reject(new Error('Device did not answer')); }, timeoutMs);
      ch.on('data', (c) => {
        reader.push(c);
        let m; try { m = reader.nextLine(); } catch { return; }
        if (!m) return;
        clearTimeout(timer); ch.end();
        m.type === 'ok' ? resolve() : reject(new Error('Unexpected reply'));
      });
      ch.on('error', (e) => { clearTimeout(timer); reject(e); });
      send(ch, { type: 'text', from: { name: this.name }, text: body });
    });
  }

  // Call / screen-sharing signaling (WebRTC offer, answer, ICE…) to another PC, over the same
  // encrypted, identity-checked channel as files and text. Media then flows directly.
  async sendRtc(peer, msg, timeoutMs = 8000) {
    if (peer.outdated) throw new Error(`${peer.name} needs to update DropWave`);
    const body = JSON.stringify(msg || {});
    if (body.length > 64 * 1024) throw new Error('Call message too large');
    const { ch } = await this.#connect(peer.ip, peer.port, peer.id);
    await new Promise((resolve, reject) => {
      const reader = new LineReader();
      const timer = setTimeout(() => { ch.destroy(); reject(new Error('Device did not answer')); }, timeoutMs);
      ch.on('data', (c) => {
        reader.push(c);
        let m; try { m = reader.nextLine(); } catch { return; }
        if (!m) return;
        clearTimeout(timer); ch.end();
        m.type === 'ok' ? resolve() : reject(new Error('Unexpected reply'));
      });
      // An older DropWave closes the connection on a message type it doesn't know.
      ch.on('close', () => { clearTimeout(timer); reject(new Error(`${peer.name} needs a newer DropWave for calls`)); });
      ch.on('error', (e) => { clearTimeout(timer); reject(e); });
      send(ch, { type: 'rtc', from: { name: this.name }, msg });
    });
  }

  // ---------- receiving ----------

  #startServer() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((raw) => {
        raw.setNoDelay(true);
        raw.on('error', () => {});
        this.#handshake(raw, false)
          .then(({ ch, peerId }) => this.#serve(ch, peerId))
          .catch((e) => this.emit('log', `Handshake failed: ${e.message}`));
      });
      server.once('error', reject);
      server.listen(this.port, '0.0.0.0', () => {
        server.off('error', reject);
        server.on('error', (e) => this.emit('log', `TCP error: ${e.message}`));
        this.server = server;
        resolve();
      });
    });
  }

  // Handles one authenticated connection. peerId is proven by the handshake signature.
  #serve(sock, peerId) {
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
        if (m.type === 'text') {
          // Clipboard / text sharing: shown to the user, never acted on automatically.
          const text = String(m.text || '').slice(0, MAX_TEXT);
          const from = { id: peerId, name: String(m.from?.name || this.#nameOf(peerId, sock)).slice(0, 64), ip: sock.remoteAddress?.replace(/^::ffff:/, '') };
          if (text) this.emit('text', { id: crypto.randomUUID(), from, text, at: Date.now() });
          send(sock, { type: 'ok' }); sock.end(); state = 'closed'; return;
        }
        if (m.type === 'rtc') {
          // Call signaling: handed to the window, which asks the user before anything starts.
          const from = { id: peerId, name: String(m.from?.name || this.#nameOf(peerId, sock)).slice(0, 64) };
          if (m.msg && typeof m.msg === 'object' && typeof m.msg.type === 'string') this.emit('rtc', { from, msg: m.msg });
          send(sock, { type: 'ok' }); sock.end(); state = 'closed'; return;
        }
        if (m.type !== 'offer' || !Array.isArray(m.files)) { sock.destroy(); return; }
        state = 'deciding';
        sock.pause();
        const leftover = reader.take();
        transfer = await this.#onOffer(sock, m, peerId);
        if (!transfer) { state = 'closed'; return; }
        state = 'data';
        sock.resume();
        if (leftover.length) transfer.onData(leftover);
        return;
      }
      if (state === 'data') transfer.onData(chunk);
    };

    sock.on('data', (c) => { onData(c).catch((e) => { this.emit('log', e.message); sock.destroy(); }); });
    sock.on('control', (c) => { if (transfer && !transfer.finished) transfer.stoppedByPeer(c); });
    sock.on('error', () => {});
    sock.on('close', () => { if (transfer && !transfer.finished) transfer.fail('Sender disconnected', true); });
  }

  #nameOf(peerId, sock) {
    return this.peers.get(peerId)?.name || sock.remoteAddress?.replace(/^::ffff:/, '') || 'Unknown';
  }

  async #onOffer(sock, offer, peerId) {
    const files = offer.files.map((f) => ({ path: safeRelPath(f.path), size: Math.max(0, Number(f.size) || 0) }));
    const total = files.reduce((a, f) => a + f.size, 0);
    const from = { id: peerId, name: String(offer.from?.name || this.#nameOf(peerId, sock)).slice(0, 64), ip: sock.remoteAddress?.replace(/^::ffff:/, '') };
    const tid = typeof offer.tid === 'string' ? offer.tid.slice(0, 64) : null;

    // Resuming an interrupted transfer from the same device: no new prompt, continue where it stopped.
    const partial = offer.resume && tid ? this.partials.get(tid) : null;
    if (partial && partial.fromId === peerId && partial.files.length === files.length &&
        partial.files.every((f, i) => f.size === files[i].size)) {
      this.partials.delete(tid);
      clearTimeout(partial.timer);
      await partial.ready; // the interrupted file is fully flushed to disk
      return this.#receive(sock, partial.t, partial.files, partial.index, partial.hashes, tid, true);
    }

    const id = crypto.randomUUID();
    const request = { id, direction: 'in', from, files: files.map((f) => ({ name: f.path, size: f.size })), total, count: files.length };
    // Optional "Play now": the sender serves these files over HTTP at a secret token.
    const st = offer.stream;
    if (st && /^[a-f0-9]{32}$/.test(String(st.token)) && Number.isInteger(st.port) && st.port > 0 && st.port < 65536) {
      request.stream = `http://${from.ip}:${st.port}/s/${st.token}`;
    }

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
      savedTo: [...new Set(files.map((f) => path.join(this.saveDir, path.relative(this.saveDir, f.dest).split(path.sep)[0])))],
    };
    return this.#receive(sock, t, files, 0, [], tid);
  }

  // Receives file bytes from `startIndex` on. Files before it are complete (their hashes given);
  // the file at startIndex may be partly on disk already (resume).
  async #receive(sock, t, files, startIndex, prevHashes, tid, resuming = false) {
    const id = t.id;
    const total = t.total;
    const reader = new LineReader();
    let idx = startIndex - 1, remaining = 0, out = null, hash = null, waitingTrailer = false;
    const hashes = prevHashes.slice(0, startIndex);
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

    const openFile = (i, offset) => {
      const f = files[i];
      fs.mkdirSync(path.dirname(f.dest), { recursive: true });
      out = offset > 0 ? fs.createWriteStream(f.dest, { flags: 'r+', start: offset }) : fs.createWriteStream(f.dest);
      out.on('error', (e) => handle.fail(`Can't write file: ${e.message}`));
      remaining = f.size - offset;
    };

    const openNext = () => {
      while (true) {
        idx++;
        if (idx >= files.length) { waitingTrailer = true; return; }
        hash = crypto.createHash('sha256');
        openFile(idx, 0);
        if (remaining > 0) return;
        closeOut(out); hashes.push(hash.digest('hex'));
      }
    };

    // Where to continue: what's actually on disk for the current file.
    let resumeAt = { index: startIndex, offset: 0 };
    if (resuming) {
      t.resumed = true;
      if (startIndex >= files.length) {
        idx = files.length; waitingTrailer = true;
      } else {
        const f = files[startIndex];
        let offset = 0;
        try { offset = Math.min((await fsp.stat(f.dest)).size, f.size); } catch { offset = 0; }
        if (offset > 0) await fsp.truncate(f.dest, offset);
        hash = crypto.createHash('sha256');
        await hashRange(f.dest, 0, offset, hash);
        idx = startIndex;
        openFile(idx, offset);
        resumeAt = { index: startIndex, offset };
        t.done = files.slice(0, startIndex).reduce((a, x) => a + x.size, 0) + offset;
        if (remaining === 0) { closeOut(out); hashes.push(hash.digest('hex')); openNext(); }
      }
      t.status = 'active';
      delete t.error;
      t.startedAt = Date.now();
      t.speedBase = t.done;
    }

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
              if (ok) { t.status = 'completed'; t.done = total; delete t.error; }
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
              // Resume even if the connection is gone: queued messages ("cancel") and the
              // close notification still have to be delivered.
              sock.resume();
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
      // The sender cancelled or hit an error: stop for good (no resume).
      stoppedByPeer(c) {
        handle.peerStopped = true;
        if (c?.type === 'cancel') { t.status = 'cancelled'; t.error = 'Cancelled by the sender'; }
        else t.error = String(c?.reason || 'The sender stopped the transfer').slice(0, 200);
        handle.fail(t.error);
      },
      // disconnected = the sender went away (may come back and resume).
      fail(reason, disconnected = false) {
        if (handle.finished) return;
        handle.finished = true;
        self.transfers.delete(id);
        if (disconnected && tid && t.status !== 'cancelled') { sock.destroy(); return handle.park(); }
        // Tell the sender why we stopped, so it doesn't try to reconnect and resume.
        if (!handle.peerStopped && !sock.destroyed) {
          sock.control?.({ type: t.status === 'cancelled' ? 'cancel' : 'abort', reason });
          sock.end();
        } else sock.destroy();
        try { out?.destroy(); } catch {}
        if (idx >= 0 && idx < files.length && remaining > 0) fsp.rm(files[idx].dest, { force: true }).catch(() => {});
        t.status = t.status === 'cancelled' ? 'cancelled' : 'failed';
        t.error = t.error || reason;
        t.finishedAt = Date.now();
        self.emit('transfer', { ...t, ...speed(t) });
      },
      // Keep the partial file and wait a while for the sender to reconnect.
      park() {
        const partFile = idx >= 0 && idx < files.length ? files[idx].dest : null;
        const stream = out && !waitingTrailer ? out : null;
        const ready = stream ? new Promise((r) => { stream.once('close', r); stream.once('error', r); }) : Promise.resolve();
        try { stream?.end(); } catch {}
        const giveUp = (status, error) => {
          self.partials.delete(tid);
          self.transfers.delete(id);
          if (partFile) fsp.rm(partFile, { force: true }).catch(() => {});
          t.status = status; t.error = error; t.finishedAt = Date.now();
          self.emit('transfer', { ...t, ...speed(t) });
        };
        const state = {
          fromId: t.from.id, files, t, hashes: hashes.slice(), index: Math.min(idx, files.length), ready,
          timer: setTimeout(() => giveUp('failed', 'Connection lost and the sender did not come back'), RESUME_WINDOW_MS),
        };
        self.partials.set(tid, state);
        self.transfers.set(id, { cancel: () => { clearTimeout(state.timer); giveUp('cancelled', 'Cancelled'); } });
        t.status = 'paused';
        t.error = 'Connection lost — waiting for the sender to reconnect…';
        self.emit('transfer', { ...t, ...speed(t) });
      },
    };

    this.transfers.set(id, { socket: sock, cancel: (r) => { t.status = 'cancelled'; handle.fail(r || 'Cancelled'); } });
    send(sock, { type: 'accept', ...(resuming ? { resumeAt } : {}) });
    if (!resuming) openNext();
    emitProgress(true);
    return handle;
  }

  // ---------- sending ----------

  /**
   * @param {object} [opts]
   * @param {(files:{abs,path,size}[]) => ({token:string,port:number}|null)} [opts.streamLink]
   *        lets the receiver play the files before/while they copy
   */
  async sendPaths(peer, paths, opts = {}) {
    if (peer.outdated) throw new Error(`${peer.name} runs an older DropWave — ask them to update`);
    const files = await collectFiles(paths);
    if (!files.length) throw new Error('Nothing to send — the folder is empty');
    let stream = null;
    try { stream = opts.streamLink ? opts.streamLink(files) : null; } catch { stream = null; }
    const total = files.reduce((a, f) => a + f.size, 0);
    const id = crypto.randomUUID();
    const t = {
      id, direction: 'out', to: { id: peer.id, name: peer.name, ip: peer.ip },
      files: files.map((f) => ({ name: f.path, size: f.size })), count: files.length, total,
      done: 0, status: 'waiting', startedAt: Date.now(),
    };
    const emit = () => this.emit('transfer', { ...t, ...speed(t) });
    emit();

    let finished = false;
    let accepted = false; // the receiver said yes at least once → safe to resume silently
    let current = null;   // file read stream, so cancel can stop it
    let sock = null;
    let wake = null;      // cancels a pending retry wait

    let peerStopped = false;
    const finish = (status, error) => {
      if (finished) return;
      finished = true;
      this.transfers.delete(id);
      t.status = status;
      if (error) t.error = error; else delete t.error;
      t.finishedAt = Date.now();
      try { current?.destroy(); } catch {}
      if (sock && !sock.destroyed) {
        // Tell the receiver this is final, so it deletes the partial file instead of waiting.
        if (status !== 'completed' && !peerStopped) sock.control({ type: status === 'cancelled' ? 'cancel' : 'abort', reason: error });
        sock.end();
      }
      wake?.();
      emit();
    };
    this.transfers.set(id, { get socket() { return sock; }, cancel: (r) => finish('cancelled', r || 'Cancelled') });

    // One connection attempt. Resolves when the transfer is finished; rejects with
    // { retryable } when the connection dropped and we may resume.
    const attempt = () => new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg, retryable, status) => {
        if (settled) return;
        settled = true;
        // If finish() already ran (e.g. cancel), it ended the socket gracefully so the
        // "cancel" message gets through — don't cut it off here.
        if (!finished) {
          try { current?.destroy(); } catch {}
          sock?.destroy();
        }
        reject(Object.assign(new Error(msg), { retryable, status }));
      };
      this.#connect(peer.ip, peer.port, peer.id).then(({ ch }) => {
        if (finished) { ch.destroy(); return resolve(); }
        sock = ch;
        const reader = new LineReader();
        let phase = 'await-accept';
        ch.on('error', () => {});
        ch.on('close', () => { if (!finished) fail('Connection closed by the other device', accepted); });
        ch.on('control', (c) => {
          peerStopped = true;
          settled = true;
          try { current?.destroy(); } catch {}
          finish(c?.type === 'cancel' ? 'cancelled' : 'failed', c?.type === 'cancel' ? 'Cancelled by the other device' : String(c?.reason || 'The other device stopped the transfer').slice(0, 200));
          resolve();
        });
        ch.on('data', (c) => {
          reader.push(c);
          let m;
          try { m = reader.nextLine(); } catch { return fail('Bad reply', false); }
          if (!m) return;
          if (phase === 'await-accept') {
            if (m.type === 'reject') return fail('Declined by the other device', false, 'rejected');
            if (m.type !== 'accept') return fail('Unexpected reply', false);
            accepted = true;
            let at = { index: 0, offset: 0 };
            const r = m.resumeAt;
            if (r && Number.isInteger(r.index) && r.index >= 0 && r.index <= files.length &&
                Number.isInteger(r.offset) && r.offset >= 0 && (r.index === files.length ? r.offset === 0 : r.offset <= files[r.index].size)) at = r;
            phase = 'sending';
            t.status = 'active';
            delete t.error;
            t.done = files.slice(0, at.index).reduce((a, f) => a + f.size, 0) + at.offset;
            t.startedAt = Date.now();
            t.speedBase = t.done;
            if (at.index > 0 || at.offset > 0) t.resumed = true;
            emit();
            this.#streamFiles(ch, files, t, emit, (s) => (current = s), at)
              .then((hashes) => { if (!settled && !finished) { phase = 'await-done'; send(ch, { type: 'checksums', sha256: hashes }); } })
              .catch((e) => fail(e.message, accepted));
          } else if (phase === 'await-done' && m.type === 'done') {
            settled = true;
            if (m.ok) { t.done = total; finish('completed'); } else finish('failed', 'Checksum mismatch on the other device');
            resolve();
          }
        });
        send(ch, {
          type: 'offer', from: { id: this.id, name: this.name }, tid: id, resume: accepted,
          files: files.map((f) => ({ path: f.path, size: f.size })), total,
          ...(stream ? { stream } : {}),
        });
      }, (e) => fail(e.message, accepted && !e.security));
    });

    (async () => {
      for (let tries = 0; !finished; tries++) {
        try { await attempt(); return; } catch (e) {
          if (finished) return;
          if (!e.retryable || tries >= RETRY_DELAYS_MS.length) return finish(e.status || 'failed', e.message);
          t.status = 'reconnecting';
          t.error = 'Connection lost — reconnecting…';
          emit();
          await new Promise((r) => { const timer = setTimeout(r, RETRY_DELAYS_MS[tries]); wake = () => { clearTimeout(timer); r(); }; });
          wake = null;
          const fresh = this.peers.get(peer.id);
          if (fresh) peer = fresh; // its IP may have changed
        }
      }
    })();
    return id;
  }

  // Streams files[at.index] from at.offset onwards (earlier bytes are only hashed, not sent).
  async #streamFiles(sock, files, t, emit, setCurrent, at = { index: 0, offset: 0 }) {
    const hashes = [];
    let lastEmit = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const hash = crypto.createHash('sha256');
      const start = i < at.index ? f.size : i === at.index ? at.offset : 0;
      await hashRange(f.abs, 0, start, hash, setCurrent);
      if (start < f.size) {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(f.abs, { start, highWaterMark: 1024 * 1024 });
          setCurrent(rs);
          rs.on('data', (chunk) => {
            hash.update(chunk);
            t.done += chunk.length;
            if (!sock.write(chunk)) { rs.pause(); sock.once('drain', () => rs.resume()); }
            const now = Date.now();
            if (now - lastEmit > PROGRESS_EVERY_MS) { lastEmit = now; emit(); }
          });
          let ended = false;
          rs.on('end', () => { ended = true; resolve(); });
          rs.on('error', reject);
          rs.on('close', () => { if (!ended) reject(new Error('Connection lost')); });
        });
      }
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
  const bps = t.status === 'active' ? (t.done - (t.speedBase || 0)) / secs : 0;
  const eta = bps > 0 ? (t.total - t.done) / bps : null;
  return { bps, eta };
}

module.exports = { Engine, collectFiles, localIPv4s, safeRelPath, fingerprint, DEFAULT_TCP_PORT, DISCOVERY_PORT, PROTOCOL };
