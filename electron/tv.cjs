// TV remote for Android TV / Google TV, from the PC. Same protocol as the phone (TvRemote.kt) and
// Google's own TV remote: pair once with the code on the TV (TLS on 6467), then remote on 6466.
// Messages are length-prefixed protobuf, written by hand. TVs are found on the Wi-Fi with mDNS.

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');

// ---------- tiny protobuf ----------
const varint = (n) => { const b = []; let x = BigInt(n); if (x < 0n) x += 1n << 64n; do { let c = Number(x & 0x7fn); x >>= 7n; if (x) c |= 0x80; b.push(c); } while (x); return Buffer.from(b); };
class Pb {
  constructor() { this.parts = []; }
  int(f, v) { this.parts.push(varint((f << 3) | 0), varint(v)); return this; }
  bytes(f, b) { this.parts.push(varint((f << 3) | 2), varint(b.length), b); return this; }
  str(f, s) { return this.bytes(f, Buffer.from(String(s))); }
  msg(f, m) { return this.bytes(f, m.buf()); }
  buf() { return Buffer.concat(this.parts); }
}
function parse(b) {
  const m = new Map(); let i = 0;
  const rv = () => { let r = 0n, s = 0n; for (;;) { const x = b[i++]; r |= BigInt(x & 0x7f) << s; if (!(x & 0x80)) return r; s += 7n; } };
  while (i < b.length) {
    const key = Number(rv()); const f = key >> 3; const t = key & 7;
    if (!m.has(f)) m.set(f, []);
    if (t === 0) m.get(f).push(Number(rv()));
    else if (t === 2) { const n = Number(rv()); m.get(f).push(b.subarray(i, i + n)); i += n; }
    else if (t === 1) i += 8; else if (t === 5) i += 4; else break;
  }
  return m;
}
const sub = (m, f) => (Buffer.isBuffer(m.get(f)?.[0]) ? parse(m.get(f)[0]) : null);
const num = (m, f) => (typeof m?.get(f)?.[0] === 'number' ? m.get(f)[0] : 0);
const text = (m, f) => (Buffer.isBuffer(m?.get(f)?.[0]) ? m.get(f)[0].toString() : null);
const frame = (b) => Buffer.concat([varint(b.length), b]);

// Reads length-prefixed messages from a stream.
function reader(sock, onMsg) {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      let i = 0, n = 0, s = 0, ok = false;
      while (i < buf.length) { const x = buf[i++]; n |= (x & 0x7f) << s; if (!(x & 0x80)) { ok = true; break; } s += 7; }
      if (!ok || buf.length < i + n) return;
      const msg = buf.subarray(i, i + n); buf = buf.subarray(i + n);
      try { onMsg(parse(msg)); } catch (e) { console.warn('[tv]', e.message); }
    }
  });
}

// ---------- this PC's certificate (RSA, self-signed, kept with the app's data) ----------
const derLen = (n) => { if (n < 128) return Buffer.from([n]); const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); };
const tlv = (tag, ...p) => { const v = Buffer.concat(p); return Buffer.concat([Buffer.from([tag]), derLen(v.length), v]); };
const oid = (s) => { const a = s.split('.').map(Number); const out = [40 * a[0] + a[1]]; for (const n of a.slice(2)) { const b = [n & 127]; for (let x = n >> 7; x; x >>= 7) b.unshift((x & 127) | 128); out.push(...b); } return tlv(0x06, Buffer.from(out)); };
const time = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
function makeCert() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = tlv(0x30, oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const nm = tlv(0x30, tlv(0x31, tlv(0x30, oid('2.5.4.3'), tlv(0x0c, Buffer.from('DropWave Remote')))));
  const serial = crypto.randomBytes(12); serial[0] &= 0x7f;
  const now = Date.now();
  const tbs = tlv(0x30, tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), alg, nm,
    tlv(0x30, time(new Date(now - 86400e3)), time(new Date(now + 15 * 365 * 86400e3))), nm, publicKey.export({ type: 'spki', format: 'der' }));
  const sig = crypto.sign('sha256', tbs, privateKey);
  const cert = tlv(0x30, tbs, alg, tlv(0x03, Buffer.from([0]), sig));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', cert) };
}

// ---------- mDNS: find "_androidtvremote2._tcp" on the Wi-Fi ----------
const SERVICE = '_androidtvremote2._tcp.local';
function dnsName(b, off) {
  const labels = []; let jumped = false, end = off;
  for (let i = off, guard = 0; guard < 64; guard++) {
    const len = b[i];
    if (len === 0) { if (!jumped) end = i + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = i + 2; i = ((len & 0x3f) << 8) | b[i + 1]; jumped = true; continue; }
    labels.push(b.toString('utf8', i + 1, i + 1 + len)); i += len + 1;
  }
  return { name: labels.join('.'), end };
}
function query() {
  const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...SERVICE.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 0x0c, 0x80, 0x01])]); // PTR, QU
  return q;
}
function parseAnswers(b) {
  const out = { ptr: [], srv: {}, a: {}, txt: {} };
  const qd = b.readUInt16BE(4); const rrs = b.readUInt16BE(6) + b.readUInt16BE(8) + b.readUInt16BE(10);
  let i = 12;
  for (let k = 0; k < qd; k++) i = dnsName(b, i).end + 4;
  for (let k = 0; k < rrs && i < b.length; k++) {
    const n = dnsName(b, i); i = n.end;
    const type = b.readUInt16BE(i); const len = b.readUInt16BE(i + 8); const d = i + 10; i = d + len;
    if (type === 12) out.ptr.push({ from: n.name, to: dnsName(b, d).name });
    if (type === 33) out.srv[n.name] = { port: b.readUInt16BE(d + 4), target: dnsName(b, d + 6).name };
    if (type === 1) out.a[n.name] = `${b[d]}.${b[d + 1]}.${b[d + 2]}.${b[d + 3]}`;
  }
  return out;
}

class TvHub extends EventEmitter {
  /** store: { get(), set(v) } for { key, cert, tvs: [{ host, name, at }] } */
  constructor(file) {
    super();
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    if (!this.data.key || !this.data.cert) Object.assign(this.data, makeCert());
    this.data.tvs ||= [];
    this.save();
    this.found = new Map();
    this.sock = null; this.host = null; this.ime = [0, 0]; this.state = {};
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (e) { console.warn('[tv] save', e.message); } }
  saved() { return this.data.tvs.map((t) => ({ ...t, on: this.found.has(t.host), active: t.host === this.host && !!this.sock })); }
  list() { return { saved: this.saved(), found: [...this.found.values()].filter((f) => !this.data.tvs.some((t) => t.host === f.host)), active: this.sock ? this.host : null, state: this.state }; }

  // ----- discovery -----
  find(on) {
    clearInterval(this.findTimer);
    for (const s of this.mdns || []) try { s.close(); } catch {}
    this.mdns = [];
    if (!on) return;
    const handle = (msg, rinfo) => {
      let r; try { r = parseAnswers(msg); } catch { return; }
      for (const p of r.ptr.filter((x) => x.from === SERVICE)) {
        const srv = r.srv[p.to];
        const host = (srv && r.a[srv.target]) || rinfo.address;
        const name = p.to.replace('.' + SERVICE, '');
        if (!this.found.has(host)) { this.found.set(host, { host, name, port: srv?.port || 6466, at: Date.now() }); this.emit('changed'); }
        else this.found.get(host).at = Date.now();
      }
    };
    // One socket per network card (Wi-Fi + Ethernet), unicast answers come back to it.
    const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
    for (const addr of addrs) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('message', handle); s.on('error', () => {});
      s.bind(0, addr, () => { try { s.setMulticastInterface(addr); } catch {} });
      this.mdns.push(s);
    }
    // Also listen on 5353 for multicast answers.
    const m = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    m.on('message', handle); m.on('error', () => {});
    m.bind(5353, () => { for (const a of addrs) try { m.addMembership('224.0.0.251', a); } catch {} });
    this.mdns.push(m);
    const ask = () => {
      for (const s of this.mdns.slice(0, -1)) try { s.send(query(), 5353, '224.0.0.251'); } catch {}
      // forget TVs not heard from for a minute
      for (const [h, t] of this.found) if (Date.now() - t.at > 60000) { this.found.delete(h); this.emit('changed'); }
    };
    setTimeout(ask, 200);
    this.findTimer = setInterval(ask, 4000);
  }

  // ----- pairing -----
  connect(host, port) {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host, port, key: this.data.key, cert: this.data.cert, rejectUnauthorized: false, timeout: 8000 }, () => resolve(s));
      s.once('error', reject);
      s.setTimeout(8000, () => { s.destroy(); reject(new Error('The TV didn’t answer. Is it on and on this Wi-Fi?')); });
    });
  }
  pairMsg(fill) { const p = new Pb().int(1, 2).int(2, 200); fill(p); return frame(p.buf()); }
  async pairStart(host, name) {
    try { this.pairing?.destroy(); } catch {}
    const s = await this.connect(host, 6467);
    s.setTimeout(0);
    this.pairing = s; this.pairHost = host; this.pairName = name || 'TV';
    const queue = []; let waiter = null;
    reader(s, (m) => { if (waiter) { const w = waiter; waiter = null; w(m); } else queue.push(m); });
    this.pairNext = () => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('The TV stopped answering')), 15000);
      const done = (m) => { clearTimeout(t); const st = num(m, 2); if (st !== 200) rej(new Error(st === 402 ? 'Wrong code. Try again.' : `The TV said no (${st})`)); else res(m); };
      if (queue.length) done(queue.shift()); else waiter = done;
      s.once('close', () => { clearTimeout(t); rej(new Error('The TV closed the connection')); });
    });
    s.write(this.pairMsg((p) => p.msg(10, new Pb().str(1, 'atvremote').str(2, `DropWave on ${os.hostname()}`))));
    await this.pairNext();
    s.write(this.pairMsg((p) => p.msg(20, new Pb().msg(1, new Pb().int(1, 3).int(2, 6)).int(3, 1))));
    await this.pairNext();
    s.write(this.pairMsg((p) => p.msg(30, new Pb().msg(1, new Pb().int(1, 3).int(2, 6)).int(2, 1))));
    await this.pairNext(); // the code is on the TV now
  }
  async pairCode(code) {
    const s = this.pairing; if (!s) throw new Error('Start pairing again');
    const c = String(code).toUpperCase().replace(/[^0-9A-F]/g, '');
    if (c.length !== 6) throw new Error('The code has 6 letters and numbers');
    const hexBuf = (h) => Buffer.from(h.length % 2 ? '0' + h : h, 'hex');
    const strip = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };
    const jwk = crypto.createPublicKey(this.data.cert).export({ format: 'jwk' });
    const peer = s.getPeerCertificate();
    const h = crypto.createHash('sha256');
    h.update(strip(Buffer.from(jwk.n, 'base64url'))); h.update(strip(Buffer.from(jwk.e, 'base64url')));
    h.update(strip(hexBuf(peer.modulus))); h.update(strip(hexBuf(peer.exponent.replace(/^0x/, ''))));
    h.update(Buffer.from(c.slice(2), 'hex'));
    const hash = h.digest();
    if (hash[0] !== parseInt(c.slice(0, 2), 16)) throw new Error('Wrong code. Check the code on the TV.');
    s.write(this.pairMsg((p) => p.msg(40, new Pb().bytes(1, hash))));
    await this.pairNext();
    this.data.tvs = this.data.tvs.filter((t) => t.host !== this.pairHost);
    this.data.tvs.push({ host: this.pairHost, name: this.pairName, at: Date.now() });
    this.save();
    try { s.destroy(); } catch {}
    this.pairing = null;
    this.emit('changed');
  }

  // ----- the remote -----
  async open(host) {
    this.close();
    let s;
    try { s = await this.connect(host, 6466); }
    catch (e) { const err = new Error(this.data.tvs.some((t) => t.host === host) ? (e.message || 'Couldn’t reach the TV') : 'pair'); err.code = /certificate|alert|handshake|ECONNRESET/i.test(e.message) || !this.data.tvs.some((t) => t.host === host) ? 'pair' : 'net'; throw err; }
    s.setTimeout(0);
    this.sock = s; this.host = host; this.state = {};
    const t = this.data.tvs.find((x) => x.host === host); if (t) { t.at = Date.now(); this.save(); }
    reader(s, (m) => {
      if (m.has(1)) s.write(frame(new Pb().msg(1, new Pb().int(1, 622).msg(2, new Pb().str(1, os.hostname()).str(2, 'DropWave').int(3, 1).str(4, '1').str(5, 'atvremote').str(6, '1.0.0'))).buf()));
      else if (m.has(2)) s.write(frame(new Pb().msg(2, new Pb().int(1, 622)).buf()));
      else if (m.has(8)) s.write(frame(new Pb().msg(9, new Pb().int(1, num(sub(m, 8), 1))).buf()));
      else if (m.has(40)) { this.state.on = num(sub(m, 40), 1) === 1; this.emit('state', this.state); }
      else if (m.has(50)) { const v = sub(m, 50); this.state.volume = { level: num(v, 7), max: num(v, 6), muted: num(v, 8) === 1 }; this.emit('state', this.state); }
      else if (m.has(20)) { const a = text(sub(sub(m, 20), 1), 12); if (a) { this.state.app = a; this.emit('state', this.state); } }
      else if (m.has(21)) { const e = sub(m, 21); this.ime = [num(e, 1), num(e, 2)]; this.state.imeAt = Date.now(); this.emit('state', this.state); }
      else if (m.has(22)) { this.state.imeAt = Date.now(); this.emit('state', this.state); }
    });
    s.on('close', () => {
      if (this.sock !== s) return; // closed on purpose
      this.sock = null; this.emit('changed');
      // The TV dropped us (some actions do that): come back by itself, a few times.
      const now = Date.now(); this.drops = (this.drops || []).filter((t) => now - t < 20000).concat(now);
      if (this.drops.length <= 3) setTimeout(() => { if (!this.sock && this.host === host) this.open(host).catch(() => this.emit('closed', host)); }, 700);
      else this.emit('closed', host);
    });
    s.on('error', () => {});
    this.emit('changed');
  }
  close() { const s = this.sock; this.sock = null; try { s?.destroy(); } catch {} }
  need() { if (!this.sock) throw new Error('Not connected to a TV'); return this.sock; }
  key(code, dir = 3) { this.need().write(frame(new Pb().msg(10, new Pb().int(1, code).int(2, dir)).buf())); }
  text(str) {
    const n = Math.max(0, String(str).length - 1);
    this.need().write(frame(new Pb().msg(21, new Pb().int(1, this.ime[0]).int(2, this.ime[1]).msg(3, new Pb().int(1, 1).msg(2, new Pb().int(1, n).int(2, n).str(3, str)))).buf()));
  }
  launch(link) { this.need().write(frame(new Pb().msg(90, new Pb().str(1, link)).buf())); }
  rename(host, name) { const t = this.data.tvs.find((x) => x.host === host); if (t) { t.name = String(name).slice(0, 40); this.save(); this.emit('changed'); } }
  forget(host) { if (this.host === host) this.close(); this.data.tvs = this.data.tvs.filter((t) => t.host !== host); this.save(); this.emit('changed'); }
}

module.exports = { TvHub, _test: { Pb, parse, frame, makeCert, parseAnswers, query } };
