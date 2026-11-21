// One mouse and keyboard for two PCs (like Mouse without Borders): push the pointer off the edge
// of this screen and it carries on on the other PC; the keyboard follows; what you copied comes too.
//
// Each PC runs native/kvm/dwkvm.exe (hooks and SendInput) while sharing is on. The two PCs talk over
// one long-lived DropWave channel (engine.openKvm: X25519 + AES-256-GCM, identity pinned):
//   {t:'layout', side}        from the PC that set it up: "you are on my <side>"
//   {t:'enter', y}            my mouse is coming to you at height y (0..1)
//   {t:'i', l}                one input line for your dwkvm ("m dx dy", "k ...", "b ...", "w ...")
//   {t:'leave', y}            the mouse went back (or was taken back)
//   {t:'clip', tl, hl, il}    clipboard follows: then tl + hl + il bytes of data (text, HTML, PNG)
// Files copied in Explorer (Ctrl+C) go on a second channel (role 'files'), so a big file never slows
// the mouse: {t:'files', id, tops, total}, then per file {t:'file', rel, size} + its bytes, then
// {t:'end'}; the receiver answers {t:'ok'} once they are on its clipboard, ready for Ctrl+V.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const INPUT_LINE = /^(m -?\d{1,5} -?\d{1,5}|b [1-5] [du]|w -?\d{1,6}|hw -?\d{1,6}|k \d{1,3} \d{1,4} [01] [du])$/;
const MAX_CLIP = 16 * 1024 * 1024;
const MAX_FILES = 8 * 1024 * 1024 * 1024; // bigger than this: use Send files
const CLIP_DIR = path.join(os.tmpdir(), 'DropWave Clipboard');
const opposite = (s) => (s === 'right' ? 'left' : 'right');

class Flow extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./engine.cjs').Engine} o.engine
   * @param {() => string|string[]|null} o.helper   path of dwkvm.exe (null if missing)
   * @param {() => {on:boolean, peer:string, side:'left'|'right'}} o.config   this PC's own setup
   * @param {(from) => Promise<boolean>} o.allow   may this PC be controlled by `from`? (asks once)
   * @param {object} o.clipboard   { read(): {text, html, png:Buffer|null}, write({text, html, png}) }
   */
  constructor(o) {
    super();
    this.o = o;
    this.ch = null;          // the channel to the other PC
    this.peer = null;        // { id, name }
    this.edge = null;        // which edge of this screen leads to the other PC
    this.mode = 'idle';      // idle | controlling (my mouse is there) | controlled (theirs is here)
    this.kvm = null;         // dwkvm process
    this.retry = null;
    this.clipSent = '';      // hash of the clipboard last sent / received, so we only send changes
    this.incoming = null;    // clipboard bytes still arriving
    this.filesSent = '';     // copied files already sent (paths + sizes + times)
    this.filesPut = '';      // files we put on this clipboard (don't send them back)
    this.sending = false;
    this.waiters = [];       // helper answers we are waiting for
    o.engine.on('kvm', (x) => this.#incoming(x));
    // Files pasted from the other PC live here; tidy anything older than a day.
    fsp.readdir(CLIP_DIR).then((ds) => ds.forEach((d) => fsp.stat(path.join(CLIP_DIR, d)).then((s) => { if (Date.now() - s.mtimeMs > 86400000) fsp.rm(path.join(CLIP_DIR, d), { recursive: true, force: true }); }).catch(() => {}))).catch(() => {});
  }

  state() {
    return { on: !!this.o.config().on, connected: !!this.ch, peer: this.peer, edge: this.edge, mode: this.mode, helper: !!this.o.helper(), lastCopy: this.lastCopy || null };
  }
  #push() { this.emit('state', this.state()); }
  /** What crossed last (shown in Settings): { dir: 'out' | 'in', what, at }. */
  #copied(dir, what) { this.lastCopy = { dir, what, at: Date.now() }; this.#push(); }

  /** Settings changed (on/off, which PC, which side): connect, re-layout or stop. */
  sync() {
    const c = this.o.config();
    if (!c.on || !c.peer) { if (this.ch && this.outgoing) this.#close(); clearTimeout(this.retry); this.#push(); return; }
    if (this.ch && this.outgoing && this.peer?.id === c.peer) {
      this.edge = c.side;
      this.#send({ t: 'layout', side: c.side });
      this.#edges();
      this.#push();
      return;
    }
    if (this.ch && this.outgoing) this.#close();
    this.#connect();
  }

  async #connect() {
    clearTimeout(this.retry);
    const c = this.o.config();
    if (!c.on || !c.peer || this.ch) return;
    const peer = this.o.engine.peerList().find((p) => p.id === c.peer);
    const again = () => { this.retry = setTimeout(() => this.#connect(), 4000); };
    if (!peer) { this.#push(); return again(); }
    try {
      const ch = await this.o.engine.openKvm(peer);
      this.outgoing = true;
      this.#attach(ch, { id: peer.id, name: peer.name }, c.side);
      this.#send({ t: 'layout', side: c.side });
    } catch (e) {
      this.emit('log', `mouse sharing: ${e.message}`);
      again();
    }
  }

  async #incoming({ ch, from, role }) {
    if (role === 'files') {
      // Copied files from the PC we are paired with right now; nobody else.
      if (this.ch && this.peer?.id === from.id) this.#receiveFiles(ch, from); else ch.destroy();
      return;
    }
    if (this.ch) { ch.destroy(); return; } // one partner at a time
    ch.pause(); // hold their first messages (layout) until this PC said yes
    let ok = false;
    try { ok = await this.o.allow(from); } catch { ok = false; }
    if (!ok) { ch.destroy(); return; }
    this.outgoing = false;
    this.#attach(ch, from, null); // the edge comes with their 'layout'
    ch.resume();
  }

  #attach(ch, peer, edge) {
    this.ch = ch; this.peer = peer; this.edge = edge; this.mode = 'idle'; this.clipSent = '';
    ch.on('control', (m) => this.#message(m));
    ch.on('data', (b) => this.#clipData(b));
    ch.on('error', () => {});
    ch.on('close', () => { if (this.ch === ch) { this.#close(); if (this.outgoing) this.retry = setTimeout(() => this.#connect(), 2000); } });
    this.#startHelper();
    this.#edges();
    this.#push();
  }

  #close() {
    const ch = this.ch;
    this.ch = null;
    if (this.mode === 'controlling') this.#cmd(`release ${this.edge || 'right'} 0.5`);
    if (this.mode === 'controlled') this.#cmd('leave');
    this.mode = 'idle';
    try { ch?.destroy(); } catch {}
    this.#stopHelper();
    this.#push();
  }

  stop() { clearTimeout(this.retry); this.outgoing = true; this.#close(); }

  #send(m) { try { this.ch?.control(m); } catch {} }

  // ---------- the helper ----------
  #startHelper() {
    if (this.kvm) return;
    const exe = this.o.helper();
    if (!exe) { this.emit('log', 'mouse sharing: dwkvm.exe is missing'); return; }
    const [cmd, ...args] = Array.isArray(exe) ? exe : [exe]; // tests pass [node, fake-helper.js]
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.kvm = p;
    let buf = '';
    p.stdout.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this.#helperLine(line); }
    });
    p.on('exit', () => { if (this.kvm === p) { this.kvm = null; if (this.mode !== 'idle') { this.mode = 'idle'; this.#send({ t: 'leave', y: 0.5 }); } this.#push(); } });
    p.stdin.on('error', () => {});
  }
  #stopHelper() { const p = this.kvm; this.kvm = null; try { p?.stdin.write('quit\n'); } catch {} setTimeout(() => { try { p?.kill(); } catch {} }, 800); }
  #cmd(line) { try { this.kvm?.stdin.write(line + '\n'); } catch {} }
  #edges() { this.#cmd(`edges ${this.edge === 'left' ? 1 : 0} ${this.edge === 'right' ? 1 : 0}`); }

  /** Ask the helper something; resolves with its next line that starts with `prefix` (or null). */
  #ask(cmd, prefix, ms = 800) {
    return new Promise((resolve) => {
      if (!this.kvm) return resolve(null);
      const w = { prefix, resolve, timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(null); }, ms) };
      this.waiters.push(w);
      this.#cmd(cmd);
    });
  }

  #helperLine(line) {
    const w = this.waiters.find((x) => line.startsWith(x.prefix));
    if (w) { this.waiters = this.waiters.filter((x) => x !== w); clearTimeout(w.timer); w.resolve(line); return; }
    if (line === 'ready') { this.#edges(); return; }
    if (line.startsWith('edge ')) {
      // Pushed against the edge toward the other PC: the mouse goes there.
      const [, side, y] = line.split(' ');
      if (!this.ch || this.mode !== 'idle' || side !== this.edge) return;
      this.mode = 'controlling';
      this.#cmd('capture');
      this.#sendClipboard();
      this.#send({ t: 'enter', y: Number(y) || 0.5 });
      this.#push();
      return;
    }
    if (line === 'takeback') { this.#comeBack(0.5, true); return; }
    if (line.startsWith('leave ')) {
      // Controlled here, and the pointer went back over the edge: hand it back (with our clipboard).
      if (this.mode !== 'controlled') return;
      this.mode = 'idle';
      this.#sendClipboard();
      this.#send({ t: 'leave', y: Number(line.split(' ')[1]) || 0.5 });
      this.#push();
      return;
    }
    if (this.mode === 'controlling' && INPUT_LINE.test(line)) this.#send({ t: 'i', l: line });
  }

  #comeBack(y, tell) {
    if (this.mode !== 'controlling') return;
    this.mode = 'idle';
    this.#cmd(`release ${this.edge} ${Math.min(1, Math.max(0, y))}`);
    if (tell) this.#send({ t: 'leave', y });
    this.#push();
  }

  // ---------- messages from the other PC ----------
  #message(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'layout':
        if (!this.outgoing && (m.side === 'left' || m.side === 'right')) { this.edge = opposite(m.side); this.#edges(); this.#push(); }
        break;
      case 'enter':
        if (this.mode !== 'idle' || !this.edge) return;
        this.mode = 'controlled';
        this.#cmd(`enter ${this.edge} ${Math.min(1, Math.max(0, Number(m.y) || 0.5))}`);
        this.emit('controlled', this.peer);
        this.#push();
        break;
      case 'i':
        if (this.mode === 'controlled' && typeof m.l === 'string' && INPUT_LINE.test(m.l)) this.#cmd(m.l);
        break;
      case 'leave':
        if (this.mode === 'controlling') this.#comeBack(Number(m.y) || 0.5, false);
        else if (this.mode === 'controlled') { this.mode = 'idle'; this.#cmd('leave'); this.#push(); }
        break;
      case 'clip': {
        const tl = Number(m.tl) || 0, hl = Number(m.hl) || 0, il = Number(m.il) || 0;
        if (tl < 0 || hl < 0 || il < 0 || tl + hl + il > MAX_CLIP) return;
        this.incoming = { tl, hl, il, need: tl + hl + il, parts: [], got: 0 };
        if (!this.incoming.need) this.#clipDone();
        break;
      }
    }
  }

  // ---------- clipboard follows the mouse ----------
  // Files copied in Explorer win: then only the files go (on their own channel), never text or a
  // picture that would land on the other clipboard on top of them.
  async #sendClipboard() {
    try { await this.#sendClipboardNow(); } catch (e) { this.emit('log', `clipboard: ${e.message}`); }
  }
  async #sendClipboardNow() {
    const line = await this.#ask('getfiles', 'files ');
    let paths = [];
    try { paths = JSON.parse(line?.slice(6) || '[]').filter((p) => typeof p === 'string'); } catch {}
    if (paths.length) {
      this.#sendCopiedFiles(paths).catch((e) => { this.emit('log', `copied files: ${e.message}`); this.emit('files-failed', { error: e.message }); });
      return;
    }
    if (!this.ch) return;
    let c;
    try { c = await this.o.clipboard.read(); } catch (e) { this.emit('log', `clipboard: could not read: ${e.message}`); return; }
    if (!this.ch) return;
    const text = Buffer.from(c.text || '', 'utf8'), html = Buffer.from(c.html || '', 'utf8'), png = c.png && c.png.length < MAX_CLIP ? c.png : Buffer.alloc(0);
    if (!text.length && !png.length) { this.emit('log', 'clipboard: empty, nothing to send'); return; }
    const h = crypto.createHash('sha1').update(text).update(html).update(png).digest('hex');
    if (h === this.clipSent) { this.emit('log', 'clipboard: unchanged since it last crossed, not sent'); return; }
    this.emit('log', `clipboard: sending text ${text.length} B, html ${html.length} B, picture ${png.length} B`);
    this.#copied('out', png.length ? 'a picture' : `text (${c.text.length} characters)`);
    this.clipSent = h;
    this.#send({ t: 'clip', tl: text.length, hl: html.length, il: png.length });
    const all = Buffer.concat([text, html, png]);
    if (all.length) this.ch.write(all);
  }
  // ---------- files copied in Explorer ----------
  async #sendCopiedFiles(paths) {
    if (this.sending) return;
    const key = JSON.stringify(paths);
    if (key === this.filesPut) return; // the very files the other PC sent us
    // Every file under what was copied (folders too), with paths relative to the copied items.
    const files = [];
    const walk = async (abs, rel) => {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) { files.push({ dir: true, rel }); for (const n of await fsp.readdir(abs)) await walk(path.join(abs, n), `${rel}/${n}`); }
      else if (st.isFile()) files.push({ abs, rel, size: st.size, mtime: st.mtimeMs });
    };
    for (const p of paths) await walk(p, path.basename(p));
    const total = files.reduce((a, f) => a + (f.size || 0), 0);
    const stamp = crypto.createHash('sha1').update(JSON.stringify(files.map((f) => [f.rel, f.size, f.mtime]))).digest('hex');
    if (stamp === this.filesSent) return;
    this.emit('log', `copied files: sending ${paths.length} item(s), ${total} bytes to ${this.peer?.name}`);
    this.#copied('out', paths.length === 1 ? path.basename(paths[0]) : `${paths.length} files`);
    if (total > MAX_FILES) { this.emit('files-too-big', { total }); return; }
    const peer = this.o.engine.peerList().find((p) => p.id === this.peer?.id);
    if (!peer) return;
    this.sending = true;
    this.filesSent = stamp;
    let ch;
    try {
      ch = await this.o.engine.openKvm(peer, 'files');
      const done = new Promise((resolve, reject) => {
        ch.on('control', (m) => { if (m?.t === 'ok') resolve(); });
        ch.on('close', () => reject(new Error('the other PC closed the copy')));
        ch.on('error', reject);
      });
      done.catch(() => {}); // awaited below; a close mid-stream shouldn't be an unhandled rejection
      ch.control({ t: 'files', id: crypto.randomUUID(), tops: paths.map((p) => path.basename(p)), total, count: files.filter((f) => !f.dir).length });
      for (const f of files) {
        if (f.dir) { ch.control({ t: 'dir', rel: f.rel }); continue; }
        ch.control({ t: 'file', rel: f.rel, size: f.size });
        for await (const chunk of fs.createReadStream(f.abs, { highWaterMark: 256 * 1024 })) {
          if (!ch.write(chunk)) await new Promise((r) => ch.once('drain', r));
        }
      }
      ch.control({ t: 'end' });
      // The other PC answers once the files are on its clipboard; don't wait forever (that blocked every later copy).
      await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('the other PC did not confirm the copy')), 60000))]);
      this.emit('log', 'copied files: the other PC has them on its clipboard');
    } catch (e) {
      this.filesSent = '';
      throw e;
    } finally {
      this.sending = false;
      try { ch?.end(); } catch {}
    }
  }

  #receiveFiles(ch, from) {
    let dir = null, tops = [], cur = null, pending = [], total = 0;
    const safe = (rel) => String(rel || '').split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..').map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_')).join(path.sep);
    ch.on('error', () => {});
    ch.on('close', () => { this.receivingFiles = false; });
    ch.on('control', async (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'files' && !dir) {
        total = Math.max(0, Number(m.total) || 0);
        if (total > MAX_FILES) { ch.destroy(); return; }
        dir = path.join(CLIP_DIR, crypto.randomUUID());
        fs.mkdirSync(dir, { recursive: true });
        tops = (Array.isArray(m.tops) ? m.tops : []).map(safe).filter(Boolean).slice(0, 1000);
        this.receivingFiles = true;
        this.emit('files-in', { from, names: tops, total });
      } else if (m.t === 'dir' && dir) {
        const rel = safe(m.rel); if (rel) fs.mkdirSync(path.join(dir, rel), { recursive: true });
      } else if (m.t === 'file' && dir) {
        const rel = safe(m.rel);
        if (!rel) { ch.destroy(); return; }
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const ws = fs.createWriteStream(abs);
        pending.push(new Promise((r) => ws.on('close', r)));
        cur = { ws, left: Math.max(0, Number(m.size) || 0) };
        if (!cur.left) { ws.end(); cur = null; }
      } else if (m.t === 'end' && dir) {
        await Promise.all(pending);
        const abs = tops.map((t) => path.join(dir, t)).filter((p) => fs.existsSync(p));
        for (const p of abs) this.#cmd(`addfile ${p}`);
        const r = await this.#ask('putfiles', 'putfiles ', 3000);
        this.filesPut = JSON.stringify(abs);
        this.receivingFiles = false;
        this.filesAt = Date.now();
        this.emit('log', `copied files: ${r || 'no answer'} (${abs.length} item(s) from ${from.name})`);
        if (r?.startsWith('putfiles ok')) { this.emit('files-ready', { from, names: tops, total, dir }); this.#copied('in', tops.length === 1 ? tops[0] : `${tops.length} files`); }
        else this.emit('log', 'copied files: could not put them on the clipboard');
        ch.control({ t: 'ok' });
      }
    });
    ch.on('data', (b) => {
      if (!cur) return;
      const part = b.length > cur.left ? b.subarray(0, cur.left) : b;
      cur.left -= part.length;
      const w = cur.ws;
      // Disk slower than the network: wait. 'close' too: after the last chunk end() comes first and
      // 'drain' never fires, which used to leave the channel paused with the 'end' message unread.
      if (!w.write(part)) { ch.pause(); const go = () => ch.resume(); w.once('drain', go); w.once('close', go); }
      if (cur.left <= 0) { w.end(); cur = null; }
    });
  }

  #clipData(b) {
    const x = this.incoming;
    if (!x) return;
    x.parts.push(b); x.got += b.length;
    if (x.got >= x.need) this.#clipDone();
  }
  async #clipDone() {
    const x = this.incoming;
    this.incoming = null;
    const all = Buffer.concat(x.parts).subarray(0, x.need);
    const text = all.subarray(0, x.tl).toString('utf8'), html = all.subarray(x.tl, x.tl + x.hl).toString('utf8'), png = all.subarray(x.tl + x.hl);
    this.clipSent = crypto.createHash('sha1').update(all.subarray(0, x.tl)).update(all.subarray(x.tl, x.tl + x.hl)).update(png).digest('hex');
    // Files from the other PC are on (or about to be on) this clipboard: keep them.
    if (this.receivingFiles) { this.emit('log', 'clipboard: kept the files that just arrived'); return; }
    try { await this.o.clipboard.write({ text, html, png: png.length ? png : null }); this.emit('log', `clipboard: written (text ${text.length} chars, picture ${png.length} B)`); this.#copied('in', png.length ? 'a picture' : `text (${text.length} characters)`); } catch (e) { this.emit('log', `clipboard: could not write: ${e.message}`); }
  }
}

module.exports = { Flow, INPUT_LINE };
