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
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const INPUT_LINE = /^(m -?\d{1,5} -?\d{1,5}|b [1-5] [du]|w -?\d{1,6}|hw -?\d{1,6}|k \d{1,3} \d{1,4} [01] [du])$/;
const MAX_CLIP = 16 * 1024 * 1024;
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
    o.engine.on('kvm', (x) => this.#incoming(x));
  }

  state() {
    return { on: !!this.o.config().on, connected: !!this.ch, peer: this.peer, edge: this.edge, mode: this.mode, helper: !!this.o.helper() };
  }
  #push() { this.emit('state', this.state()); }

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

  async #incoming({ ch, from }) {
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

  #helperLine(line) {
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
  #sendClipboard() {
    let c;
    try { c = this.o.clipboard.read(); } catch { return; }
    const text = Buffer.from(c.text || '', 'utf8'), html = Buffer.from(c.html || '', 'utf8'), png = c.png && c.png.length < MAX_CLIP ? c.png : Buffer.alloc(0);
    if (!text.length && !png.length) return;
    const h = crypto.createHash('sha1').update(text).update(html).update(png).digest('hex');
    if (h === this.clipSent) return; // unchanged since it last crossed
    this.clipSent = h;
    this.#send({ t: 'clip', tl: text.length, hl: html.length, il: png.length });
    const all = Buffer.concat([text, html, png]);
    if (all.length) this.ch.write(all);
  }
  #clipData(b) {
    const x = this.incoming;
    if (!x) return;
    x.parts.push(b); x.got += b.length;
    if (x.got >= x.need) this.#clipDone();
  }
  #clipDone() {
    const x = this.incoming;
    this.incoming = null;
    const all = Buffer.concat(x.parts).subarray(0, x.need);
    const text = all.subarray(0, x.tl).toString('utf8'), html = all.subarray(x.tl, x.tl + x.hl).toString('utf8'), png = all.subarray(x.tl + x.hl);
    this.clipSent = crypto.createHash('sha1').update(all.subarray(0, x.tl)).update(all.subarray(x.tl, x.tl + x.hl)).update(png).digest('hex');
    try { this.o.clipboard.write({ text, html, png: png.length ? png : null }); } catch {}
  }
}

module.exports = { Flow, INPUT_LINE };
