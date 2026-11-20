// "Phone on PC": what the DropWave Android app shares with this PC (battery, notifications,
// what's playing, clipboard), the commands this PC sends back (ring, media keys, replies), and
// the phone's touchpad / keyboard / Deck, which only work once this PC's user allows that phone.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const isDataImage = (v, max) => typeof v === 'string' && v.length <= max && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v);

// One-time codes in a notification ("Your code is 482913", "G-123456 is your Google code").
function findCode(text) {
  if (!/\b(code|otp|pin|password|passcode|verification|verify|one[- ]time|कोड|ओटीपी)\b/i.test(text)) return null;
  const m = text.match(/(?:^|[^\d])(\d{4,8})(?!\d)/) || text.match(/\b([A-Z0-9]{3,4}-[A-Z0-9]{3,4})\b/);
  return m ? m[1] : null;
}

class PhoneHub {
  /**
   * @param {{ push:Function, notify:Function, web:()=>any, settings:()=>any, saveSettings:Function,
   *   clipboard:any, remoteInput:any, focused:()=>boolean, attention:Function, inputLog?:string }} o
   */
  constructor(o) {
    this.o = o;
    this.phones = new Map();   // client id -> phone state
    this.timeline = [];        // this session's events (clipboard, ring, remote…), newest first
    this.sessionAllowed = new Set(); // phones allowed to control this PC until DropWave restarts
    this.asking = new Map();   // phone id -> { id, name } waiting for Allow / Deny
    this.lastClip = '';
    this.clipTimer = null;
    this.lastRemote = new Map(); // phone id -> time of its last input (for "… is using your mouse")
    this.names = new Map();      // device id -> name, for devices allowed this session
    this.activeTimer = null;
  }

  /** Who may use the mouse and keyboard, and who is using them right now (title-bar "Stop" pill). */
  remoteState() {
    const now = Date.now();
    const ids = new Set([...this.sessionAllowed, ...this.#always().map((d) => d.id)]);
    return [...ids].map((id) => ({
      id, name: this.phones.get(id)?.name || this.names.get(id) || this.#always().find((d) => d.id === id)?.name || 'A device',
      always: this.#always().some((d) => d.id === id), active: now - (this.lastRemote.get(id) || 0) < 5000,
    }));
  }

  #pushRemote() {
    this.o.push('remote-state', this.remoteState());
    // Clear "active" once input stops.
    clearTimeout(this.activeTimer);
    if (this.remoteState().some((r) => r.active)) this.activeTimer = setTimeout(() => this.#pushRemote(), 5200);
  }

  /** Ask the phone something and wait for its one answer. */
  rpc(id, method, args = {}, ms = 20000) {
    const p = this.#need(id);
    this.rpcs ||= new Map();
    const rid = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpcs.delete(rid); reject(new Error(PhoneHub.NO_ANSWER)); }, ms);
      this.rpcs.set(rid, { phone: p.id, resolve, reject, timer });
      if (!this.o.web()?.sendPhone(p.id, { type: 'rpc', rid, method, args })) {
        clearTimeout(timer); this.rpcs.delete(rid);
        reject(new Error('The phone is not connected right now. Open DropWave on the phone.'));
      }
    });
  }

  /** Continuity camera: the phone takes a photo / video and it lands in Downloads\DropWave\Camera. */
  cameraTake(id, mode) {
    const p = this.#need(id);
    const video = mode === 'video';
    const name = video ? 'video.mp4' : 'photo.jpg';
    const r = this.#download(p, [{ id: '0', name, size: 0 }], (token) => { p.cameraToken = token; return { type: 'camera', mode: video ? 'video' : 'photo', token }; }, null, {
      dir: path.join(this.o.settings().saveDir, 'Camera'),
      onDone: (saved) => { p.cameraToken = null; this.o.push('phone-camera', { id: p.id, state: saved['0'] ? 'done' : 'cancelled', path: saved['0'] || null, video, error: '' }); },
    });
    this.o.push('phone-camera', { id: p.id, state: 'asking', video });
    return r;
  }

  /** Copy an app's APK from the phone. */
  appApk(id, pkg, name, size) {
    const p = this.#need(id);
    return this.#download(p, [{ id: '0', name: `${str(name, 120) || 'app'}.apk`, size: num(size) || 0 }], (token) => ({ type: 'app-apk', pkg: str(pkg, 200), token }), null,
      { dir: path.join(this.o.settings().saveDir, 'Phone', 'Apps') });
  }

  start() {
    try { this.lastClip = this.o.clipboard.readText(); } catch {}
    this.clipTimer = setInterval(() => this.#pollClipboard(), 1000);
    this.backupTimer = setInterval(() => { for (const id of this.phones.keys()) this.backupCheck(id); }, 10 * 60 * 1000);
  }

  stop() { clearInterval(this.clipTimer); clearInterval(this.backupTimer); }

  list() { return [...this.phones.values()].map((p) => this.#public(p)); }

  #public(p) {
    const allowed = this.isAllowed(p.id);
    return {
      id: p.id, name: p.name, status: p.status, notifs: p.notifs, media: p.media, icons: p.icons,
      ringing: p.ringing, call: p.call || null, calls: p.calls || null, remote: { allowed, always: this.#always().some((d) => d.id === p.id), active: Date.now() - (this.lastRemote.get(p.id) || 0) < 4000 },
    };
  }

  #emit(p) { this.o.push('phone', this.#public(p)); }

  #event(kind, peer, text) {
    const e = { id: crypto.randomUUID(), at: Date.now(), kind, peer: peer ? { id: peer.id, name: peer.name } : null, text };
    this.timeline = [e, ...this.timeline].slice(0, 100);
    this.o.push('timeline', e);
  }

  /** Devices that are still connected; drop the rest. */
  sync(clients) {
    const live = new Map(clients.map((c) => [c.id, c]));
    for (const [id, p] of this.phones) {
      if (!live.has(id)) { this.phones.delete(id); this.o.push('phone-gone', id); }
      else if (live.get(id).name !== p.name) { p.name = live.get(id).name; this.#emit(p); }
    }
  }

  // ---------- phone -> PC ----------

  handle({ from, type, data }) {
    let p = this.phones.get(from.id);
    if (!p) {
      p = { id: from.id, name: from.name, status: null, notifs: [], media: null, icons: {}, ringing: false, seen: new Set(), primed: false };
      this.phones.set(from.id, p);
    }
    p.name = from.name;
    const d = data && typeof data === 'object' ? data : {};
    switch (type) {
      case 'status': {
        // Connected (again): catch up on photos taken meanwhile.
        if (d.photosAccess === 'all' && Date.now() - (p.lastBackupCheck || 0) > 5 * 60 * 1000) setTimeout(() => this.backupCheck(p.id), 3000);
        p.status = {
          battery: num(d.battery), charging: !!d.charging, model: str(d.model, 60), android: str(d.android, 20),
          notifAccess: !!d.notifAccess, clip: !!d.clip, app: str(d.app, 20),
          photosAccess: ['all', 'partial', 'none'].includes(d.photosAccess) ? d.photosAccess : null,
          callsAccess: ['all', 'partial', 'none'].includes(d.callsAccess) ? d.callsAccess : null,
          smsAccess: ['all', 'partial', 'none'].includes(d.smsAccess) ? d.smsAccess : null,
          filesAccess: ['all', 'none'].includes(d.filesAccess) ? d.filesAccess : null,
          controlAccess: !!d.controlAccess,
          unrestricted: d.unrestricted === undefined ? null : !!d.unrestricted,
          off: (Array.isArray(d.off) ? d.off : []).filter((x) => typeof x === 'string').slice(0, 12),
          volume: num(d.volume), volumeMax: num(d.volumeMax), muted: !!d.muted,
        };
        break;
      }
      case 'notifs': {
        const list = (Array.isArray(d.list) ? d.list : []).slice(0, 60).map((n) => {
          const text = str(n.text, 2000), title = str(n.title, 200);
          return {
            key: str(n.key, 300), pkg: str(n.pkg, 120), app: str(n.app, 60), title, text, time: num(n.time) || Date.now(),
            code: findCode(`${title} ${text}`),
            actions: (Array.isArray(n.actions) ? n.actions : []).slice(0, 3).map((a, i) => ({ i: num(a.i) ?? i, title: str(a.title, 40), reply: !!a.reply })),
          };
        }).filter((n) => n.key && (n.title || n.text));
        // A new notification pops up on the PC too (not the ones already there when the phone connected).
        if (p.primed) {
          for (const n of list) {
            if (p.seen.has(n.key)) continue;
            if (!this.o.focused() && this.o.settings().phoneNotifs !== false) {
              this.o.notify(`${n.app || 'Phone'} · ${n.title || p.name}`, n.code ? `${n.text}\n\nCode: ${n.code}` : n.text, () => this.o.push('open-home', p.id));
            }
          }
        }
        p.seen = new Set(list.map((n) => n.key));
        p.primed = true;
        p.notifs = list;
        break;
      }
      case 'rpc': {
        const w = this.rpcs.get(str(d.rid, 40));
        if (!w || w.phone !== p.id) return;
        this.rpcs.delete(str(d.rid, 40));
        clearTimeout(w.timer);
        if (d.error === 'blocked') w.reject(new Error(`${{ contacts: 'Contacts', apps: 'Apps', controls: 'Phone controls' }[d.what] || 'That'} is switched off on ${p.name} (DropWave › Privacy).`));
        else if (d.error) w.reject(new Error(str(d.error, 200)));
        else w.resolve(d.result && typeof d.result === 'object' ? d.result : {});
        return;
      }
      case 'controls': this.o.push('phone-controls', { id: p.id, state: d }); return;
      case 'webcam': {
        if (d.asked === 'notified') this.o.camState(p.id, { state: 'asking', notified: true });
        else if (d.error) this.o.camState(p.id, { state: 'error', error: str(d.error, 200) });
        else if (d.on === true) this.o.camState(p.id, { state: 'live', front: !!d.front, stage: str(d.stage, 120) });
        else if (d.on === false) this.o.camState(p.id, { state: 'off' });
        return;
      }
      case 'camera': {
        // The phone opened its camera, the user cancelled, or the upload failed.
        if (d.opened) { this.o.push('phone-camera', { id: p.id, state: d.opened === 'notified' ? 'notified' : 'open' }); return; }
        if (d.cancelled || d.sent === false) {
          const tokens = this.o.web()?.photoTokens;
          const t = p.cameraToken && tokens?.get(p.cameraToken);
          if (t) { tokens.delete(p.cameraToken); t.onFile({ id: '0', error: 'cancelled' }); } // ends the transfer (and pushes the result)
          else this.o.push('phone-camera', { id: p.id, state: 'cancelled', error: str(d.error, 200) });
          p.cameraToken = null;
        }
        return;
      }
      case 'apk': if (d.error) this.o.push('phone-error', { id: p.id, error: str(d.error, 200) }); return;
      case 'icon': {
        const pkg = str(d.pkg, 120);
        if (pkg && isDataImage(d.data, 60 * 1024) && Object.keys(p.icons).length < 200) p.icons = { ...p.icons, [pkg]: d.data };
        break;
      }
      case 'media': {
        p.media = d.title || d.artist ? {
          title: str(d.title, 200), artist: str(d.artist, 200), app: str(d.app, 60), playing: !!d.playing,
          canSeek: !!d.canSeek, canSkip: d.canSkip !== false,
          pos: num(d.pos), dur: num(d.dur), at: Date.now(), art: isDataImage(d.art, 300 * 1024) ? d.art : (p.media?.title === d.title ? p.media?.art : null),
        } : null;
        break;
      }
      case 'ring': p.ringing = !!d.on; break;
      case 'photos': if (d.purpose === 'backup') this.#gotBackup(p, d); else this.#gotPhotos(p, d); return;
      case 'call': this.#gotCall(p, d); break;
      case 'appcall': this.#gotAppCall(p, d); break;
      case 'sms-threads': case 'sms-thread': case 'sms': case 'sms-sent': this.#gotSms(p, type, d); return;
      case 'files': this.#gotFiles(p, d); return;
      case 'mirror': {
        if (d.declined) { p.mirror = 'off'; this.o.mirrorState(p.id, { state: 'declined' }); }
        else if (d.error) this.o.mirrorState(p.id, { state: d.on ? 'on' : 'error', error: str(d.error, 200) });
        else if (d.on) { p.mirror = 'on'; this.o.mirrorState(p.id, { state: 'on' }); }
        else { p.mirror = 'off'; this.o.mirrorState(p.id, { state: 'off' }); }
        break;
      }
      case 'blocked': {
        // The phone's owner switched this feature off in DropWave › Privacy.
        const names = { notifs: 'Notifications', clip: 'Clipboard', photos: 'Photos', calls: 'Calls', sms: 'Messages', files: 'Phone files', mirror: 'Screen sharing', ring: 'Find my phone' };
        const msg = `${names[d.what] || 'That'} is switched off on ${p.name} (DropWave › Privacy).`;
        if (p.sms) { this.#answered(p, 'smsThreads'); this.#answered(p, 'smsThread'); if (d.what === 'sms') { p.sms.loading = false; p.sms.error = msg; if (p.sms.open) p.sms.open = { ...p.sms.open, loading: false, error: msg }; this.#smsPush(p); } }
        if (p.files && d.what === 'files') { this.#answered(p, 'files'); p.files.loading = false; p.files.error = msg; this.#filesPush(p); }
        if (p.photos && d.what === 'photos') { clearTimeout(p.photos.timer); p.photos.loading = false; p.photos.error = msg; this.o.push('phone-photos', this.#photosPublic(p)); }
        if (d.what === 'photos' && p.backupRunning) { p.backupRunning = false; p.backupError = msg; this.#backupPush(p.id); }
        if (d.what === 'mirror') this.o.mirrorState(p.id, { state: 'error', error: msg });
        // One toast per feature now and then — the page already shows it, and automatic things
        // (clipboard sync, backup) shouldn't nag at all.
        p.blockedToast ||= {};
        if (!['clip', 'notifs'].includes(d.what) && d.purpose !== 'backup' && Date.now() - (p.blockedToast[d.what] || 0) > 30000) {
          p.blockedToast[d.what] = Date.now();
          this.o.push('phone-error', { id: p.id, error: msg });
        }
        return;
      }
      case 'dial-error': this.o.push('phone-error', { id: p.id, error: str(d.error, 200) }); return;
      case 'calllog': {
        p.calls = (Array.isArray(d.list) ? d.list : []).slice(0, 100).map((c) => ({
          id: num(c.id), number: str(c.number, 40), name: str(c.name, 80), date: num(c.date) || 0, dur: num(c.dur) || 0,
          type: ['in', 'out', 'missed', 'rejected', 'blocked'].includes(c.type) ? c.type : 'in',
        }));
        break;
      }
      case 'clip': {
        const text = str(d.text, 100 * 1024);
        if (!text || this.o.settings().clipSync === false) return;
        this.lastClip = text;
        try { this.o.clipboard.writeText(text); } catch {}
        this.#event('clip-in', p, text.length > 80 ? `${text.slice(0, 77)}…` : text);
        this.o.push('clip-in', { peer: { id: p.id, name: p.name }, text });
        return;
      }
      default: return;
    }
    this.#emit(p);
  }

  // ---------- calls ----------

  #gotCall(p, d) {
    const state = ['ringing', 'offhook', 'idle'].includes(d.state) ? d.state : null;
    if (!state) return;
    const prev = p.call;
    const who = { number: str(d.number, 40) || prev?.number || '', name: str(d.name, 80) || prev?.name || '' };
    const label = who.name || who.number || 'Unknown number';
    if (prev?.key) return; // a WhatsApp/Telegram call is showing; phone-network "idle" says nothing about it
    if (state === 'idle') {
      // Rang and was never answered here or on the phone: a missed call.
      if (prev?.state === 'ringing') {
        this.#event('missed', p, label);
        if (this.o.settings().phoneNotifs !== false) this.o.notify(`Missed call: ${label}`, `On ${p.name}`, () => this.o.push('open-home', p.id));
      }
      p.call = null;
      // Ask for the updated call log.
      setTimeout(() => this.o.web()?.sendPhone(p.id, { type: 'calllog' }), 1500);
      return;
    }
    p.call = { state, ...who, since: state === prev?.state ? prev.since : Date.now(), incoming: state === 'ringing' || !!prev?.incoming };
    if (state === 'ringing' && prev?.state !== 'ringing') {
      this.o.attention(`${label} is calling`, `On ${p.name} · answer or decline in DropWave`);
    }
  }

  /** A call in an app (WhatsApp, Telegram…), from its call notification. */
  #gotAppCall(p, d) {
    const key = str(d.key, 300);
    if (!key) return;
    const prev = p.call;
    const idx = (v) => (Number.isInteger(v) && v >= 0 && v < 3 ? v : -1);
    if (d.state === 'idle') {
      if (prev?.key !== key) return;
      if (prev.state === 'ringing') {
        const label = `${prev.name || 'Someone'} (${prev.app})`;
        this.#event('missed', p, label);
        if (this.o.settings().phoneNotifs !== false) this.o.notify(`Missed ${prev.app} call: ${prev.name || 'Someone'}`, `On ${p.name}`, () => this.o.push('open-home', p.id));
      }
      p.call = null;
      return;
    }
    if (prev && !prev.key && prev.state) return; // a phone-network call is on: it wins
    const state = d.state === 'ringing' ? 'ringing' : 'offhook';
    p.call = {
      state, key, name: str(d.name, 80), number: '', app: str(d.app, 40), pkg: str(d.pkg, 120),
      answer: idx(d.answer), decline: idx(d.decline), end: idx(d.end),
      since: prev?.key === key && prev.state === state ? prev.since : Date.now(), incoming: true,
    };
    if (state === 'ringing' && !(prev?.key === key && prev.state === 'ringing')) {
      this.o.attention(`${p.call.name || 'Someone'} is calling on ${p.call.app}`, `On ${p.name} · answer or decline in DropWave`);
    }
  }

  // ---------- photos ----------

  #photosOf(p) {
    if (!p.photos) p.photos = { kind: 'all', items: [], next: 0, loading: false, access: null, error: null };
    return p.photos;
  }

  /** Ask the phone for the next page (or the first page of another kind). */
  photosLoad(id, { kind = 'all', reset = false } = {}) {
    const p = this.phones.get(id);
    const web = this.o.web();
    if (!p || !web) throw new Error('The phone is no longer connected');
    const ph = this.#photosOf(p);
    if (reset || kind !== ph.kind) Object.assign(ph, { kind, items: [], next: 0, error: null });
    if (ph.next == null || ph.loading) return this.#photosPublic(p);
    ph.loading = true;
    clearTimeout(ph.timer);
    ph.timer = setTimeout(() => { if (ph.loading) { ph.loading = false; ph.error = 'The phone didn’t answer. Open DropWave on the phone and try again.'; this.o.push('phone-photos', this.#photosPublic(p)); } }, 30000);
    if (!web.sendPhone(id, { type: 'photos', offset: ph.next, limit: 60, kind: ph.kind })) { ph.loading = false; throw new Error('The phone is no longer connected'); }
    this.o.push('phone-photos', this.#photosPublic(p));
    return this.#photosPublic(p);
  }

  #photosPublic(p) {
    const ph = this.#photosOf(p);
    return { id: p.id, kind: ph.kind, items: ph.items, hasMore: ph.next != null, loading: ph.loading, access: ph.access ?? p.status?.photosAccess ?? null, error: ph.error };
  }

  photos(id) { const p = this.phones.get(id); return p ? this.#photosPublic(p) : null; }

  #gotPhotos(p, d) {
    const ph = this.#photosOf(p);
    clearTimeout(ph.timer);
    ph.loading = false;
    ph.access = ['all', 'partial', 'none'].includes(d.access) ? d.access : ph.access;
    if (d.error) ph.error = str(d.error, 200);
    else if ((d.kind || 'all') === ph.kind && num(d.offset) === ph.items.length) {
      const items = (Array.isArray(d.items) ? d.items : []).slice(0, 120).map((x) => ({
        id: str(x.id, 40), name: str(x.name, 200), date: num(x.date) || 0, w: num(x.w), h: num(x.h), size: num(x.size) || 0,
        mime: str(x.mime, 60), video: !!x.video, dur: num(x.dur), thumb: isDataImage(x.thumb, 80 * 1024) ? x.thumb : null,
      })).filter((x) => /^[iv]\d+$/.test(x.id));
      ph.items = [...ph.items, ...items];
      ph.next = num(d.next);
      ph.error = null;
    }
    this.o.push('phone-photos', this.#photosPublic(p));
  }

  /**
   * Have the phone upload these items (each { id, name, size }) to <save folder>/Phone. Shows up in
   * Activity like any transfer. makeCmd(token) is the command that tells the phone what to send.
   */
  #download(p, pick, makeCmd, onSaved, opts = {}) {
    const web = this.o.web();
    if (!web) throw new Error('The phone is no longer connected');
    if (!pick.length) throw new Error('Nothing selected');
    const token = crypto.randomBytes(16).toString('hex');
    const dir = opts.dir || path.join(this.o.settings().saveDir, 'Phone');
    const t = {
      id: `ph-${token.slice(0, 12)}`, direction: 'in', web: true, from: { id: p.id, name: p.name }, to: { id: 'me', name: 'This PC' },
      files: pick.map((x) => ({ name: x.name, size: x.size })), count: pick.length, total: pick.reduce((a, x) => a + (x.size || 0), 0),
      done: 0, status: 'active', startedAt: Date.now(), savedTo: [],
    };
    let finished = 0, base = 0, failed = 0;
    const saved = {};
    web.allowPhotoUpload(token, {
      clientId: p.id, dir, count: pick.length,
      onProgress: (bytes) => { t.done = Math.min(t.total, base + bytes); this.o.transfer({ ...t }); },
      onFile: (f) => {
        finished++;
        base += pick.find((x) => x.id === f.id)?.size || f.size || 0;
        if (f.error) failed++; else { t.savedTo.push(f.path); saved[f.id] = f.path; }
        t.done = Math.min(t.total, base);
        if (finished === pick.length) {
          t.status = failed === pick.length ? 'failed' : 'completed';
          if (failed) t.error = `${failed} of ${pick.length} didn’t arrive`;
          t.finishedAt = Date.now();
        }
        this.o.transfer({ ...t });
        onSaved?.({ ...saved });
        if (finished === pick.length) opts.onDone?.({ ...saved });
      },
    });
    if (!web.sendPhone(p.id, makeCmd(token))) throw new Error('The phone is no longer connected');
    this.o.transfer({ ...t });
    return { count: pick.length, dir };
  }

  /** Download the chosen photo/video originals. */
  photosGet(id, ids) {
    const p = this.phones.get(id);
    if (!p) throw new Error('The phone is no longer connected');
    const ph = this.#photosOf(p);
    const pick = [...new Set(ids)].map((x) => ph.items.find((it) => it.id === x)).filter(Boolean).slice(0, 500);
    return this.#download(p, pick, (token) => ({ type: 'photo-get', ids: pick.map((x) => x.id), token }),
      (saved) => this.o.push('photos-saved', { id: p.id, saved }));
  }

  // ---------- phone screen on PC ----------

  /** Ask the phone to show its screen here (the phone shows Android's consent prompt first). */
  mirrorStart(id) {
    const p = this.#need(id);
    const token = crypto.randomBytes(16).toString('hex');
    this.o.web().allowMirror(token, {
      clientId: id,
      onFrame: (type, pts, data) => this.o.mirrorFrame(id, type, pts, data),
      onEnd: () => { p.mirror = 'off'; this.o.mirrorState(id, { state: 'off' }); this.#emit(p); },
    });
    if (!this.o.web().sendPhone(id, { type: 'mirror-start', token })) throw new Error('The phone is not connected right now. Open DropWave on the phone.');
    p.mirror = 'asking';
    this.o.openMirror(p);
    this.o.mirrorState(id, { state: 'asking' });
    this.#emit(p);
    return true;
  }

  /** Phone as webcam: the phone's camera in its own window here (front or back). */
  webcamStart(id, front) {
    const p = this.#need(id);
    const token = crypto.randomBytes(16).toString('hex');
    this.o.web().allowMirror(token, {
      clientId: id,
      onFrame: (type, pts, data) => this.o.camFrame(id, type, pts, data),
      onEnd: () => this.o.camState(id, { state: 'off' }),
    });
    if (!this.o.web().sendPhone(id, { type: 'webcam-start', token, front: !!front })) throw new Error('The phone is not connected right now. Open DropWave on the phone.');
    this.o.openCam(p);
    this.o.camState(id, { state: 'asking' });
    return true;
  }
  webcamStop(id) { this.o.web()?.sendPhone(id, { type: 'webcam-stop' }); }
  webcamSet(id, patch) {
    const c = { type: 'webcam-set' };
    if (patch && 'front' in patch) c.front = !!patch.front;
    if (patch && 'torch' in patch) c.torch = !!patch.torch;
    this.o.web()?.sendPhone(id, c);
  }

  mirrorStop(id) {
    const p = this.phones.get(id);
    this.o.web()?.sendPhone(id, { type: 'mirror-stop' });
    if (p) { p.mirror = 'off'; this.#emit(p); }
  }

  /** A tap / swipe / key from the mirror window. */
  mirrorInput(id, ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.t !== 'string') return;
    const n = (v) => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
    const e = { t: str(ev.t, 20), x: n(ev.x), y: n(ev.y), x2: n(ev.x2), y2: n(ev.y2), ms: Math.min(3000, Math.max(1, Number(ev.ms) || 200)), s: str(ev.s, 500) };
    // Straight to the phone's mirroring service; the page route is only a fallback (it sleeps in the background).
    if (!this.o.web()?.mirrorSend(id, e)) this.o.web()?.sendPhone(id, { type: 'mirror-input', ev: e });
  }

  // ---------- photo auto-backup ----------
  // New photos and videos go to <save folder>/Phone Backup/<year>/<month>, oldest first. Nothing is
  // ever deleted, on the phone or here. Checked when the phone connects and every 10 minutes.

  #backupOf(id) { return (this.o.settings().photoBackup || {})[id] || null; }

  backupState(id) {
    const b = this.#backupOf(id) || {};
    const p = this.phones.get(id);
    return { id, on: !!b.on, since: b.since || 0, count: b.count || 0, last: b.last || 0, running: !!p?.backupRunning, error: p?.backupError || null, dir: path.join(this.o.settings().saveDir, 'Phone Backup') };
  }

  #backupPush(id) { this.o.push('photo-backup', this.backupState(id)); }

  backupSet(id, on) {
    const p = this.phones.get(id);
    const all = { ...(this.o.settings().photoBackup || {}) };
    const cur = all[id] || {};
    // Turning it on backs up from the last 24 hours onwards (not the whole camera roll at once).
    all[id] = on ? { ...cur, on: true, since: cur.since || Date.now() - 24 * 3600 * 1000, name: p?.name || cur.name } : { ...cur, on: false };
    this.o.saveSettings({ photoBackup: all });
    this.#backupPush(id);
    if (on) this.backupCheck(id);
    return this.backupState(id);
  }

  backupCheck(id) {
    const p = this.phones.get(id);
    const b = this.#backupOf(id);
    if (!p || !b?.on || p.backupRunning || p.status?.photosAccess !== 'all' || p.status?.off?.includes('photos')) return;
    p.lastBackupCheck = Date.now();
    if (!this.o.web()?.sendPhone(id, { type: 'photos', offset: 0, limit: 200, kind: 'all', after: b.since || 0, thumbs: false, purpose: 'backup' })) return;
    p.backupRunning = true;
    p.backupError = null;
    clearTimeout(p.backupTimer);
    p.backupTimer = setTimeout(() => { if (p.backupRunning && !p.backupBusy) { p.backupRunning = false; this.#backupPush(id); } }, 60000);
    this.#backupPush(id);
  }

  #gotBackup(p, d) {
    const id = p.id;
    const b = this.#backupOf(id);
    const done = (err) => { p.backupRunning = false; p.backupBusy = false; p.backupError = err || null; this.#backupPush(id); };
    if (!b?.on) return done();
    if (d.error) return done(str(d.error, 200));
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, 300).map((x) => ({
      id: str(x.id, 40), name: str(x.name, 200), size: num(x.size) || 0, date: num(x.date) || 0, added: num(x.added) || 0,
    })).filter((x) => /^[iv]\d+$/.test(x.id) && x.added > (b.since || 0));
    const save = (patch) => {
      const all = { ...(this.o.settings().photoBackup || {}) };
      all[id] = { ...all[id], ...patch };
      this.o.saveSettings({ photoBackup: all });
    };
    if (!items.length) { save({ last: Date.now() }); return done(); }
    const root = path.join(this.o.settings().saveDir, 'Phone Backup');
    const incoming = path.join(root, '.incoming');
    const moved = new Set();
    p.backupBusy = true;
    // As each file lands, file it under its year/month (the photo's own date).
    const sort = async (saved) => {
      for (const [fid, file] of Object.entries(saved)) {
        if (moved.has(fid)) continue;
        moved.add(fid);
        const it = items.find((x) => x.id === fid);
        const when = new Date(it?.date || it?.added || Date.now());
        const dir = path.join(root, String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, '0'));
        try {
          await fsp.mkdir(dir, { recursive: true });
          let dest = path.join(dir, path.basename(file));
          for (let n = 1; await fsp.access(dest).then(() => true, () => false); n++) {
            const ext = path.extname(file);
            dest = path.join(dir, `${path.basename(file, ext)} (${n})${ext}`);
          }
          await fsp.rename(file, dest);
        } catch {}
      }
    };
    try {
      this.#download(p, items, (token) => ({ type: 'photo-get', ids: items.map((x) => x.id), token }), (saved) => { sort(saved); }, {
        dir: incoming,
        onDone: async (saved) => {
          await sort(saved);
          const ok = items.filter((x) => saved[x.id]);
          // Move the mark forward only past what arrived, so a failed file is tried again next time.
          const firstMissing = items.find((x) => !saved[x.id]);
          const since = firstMissing ? Math.max(b.since || 0, ...items.filter((x) => x.added < firstMissing.added && saved[x.id]).map((x) => x.added), 0) : Math.max(...items.map((x) => x.added));
          save({ since, count: (this.#backupOf(id)?.count || 0) + ok.length, last: Date.now() });
          if (ok.length) this.#event('backup', p, `${ok.length} photo${ok.length > 1 ? 's' : ''} backed up`);
          fsp.rmdir(incoming).catch(() => {});
          done(ok.length < items.length ? `${items.length - ok.length} didn’t arrive; they’ll be tried again` : null);
          if (items.length >= 200 && ok.length) setTimeout(() => this.backupCheck(id), 2000); // more waiting
        },
      });
    } catch (e) { done(e.message); }
  }

  // ---------- messages (SMS) ----------

  #smsOf(p) {
    if (!p.sms) p.sms = { access: null, threads: [], loading: false, error: null, open: null };
    return p.sms;
  }

  #smsPush(p) { this.o.push('phone-sms', { id: p.id, ...this.#smsOf(p) }); }
  sms(id) { const p = this.phones.get(id); return p ? { id, ...this.#smsOf(p) } : null; }

  #need(id) {
    const p = this.phones.get(id);
    if (!p || !this.o.web()) throw new Error('The phone is no longer connected');
    return p;
  }

  /** Send a request to the phone; if it doesn't answer in time, onTimeout() clears the "loading" state. */
  #ask(p, cmd, slot, onTimeout) {
    if (!this.o.web()?.sendPhone(p.id, cmd)) throw new Error('The phone is not connected right now. Open DropWave on the phone.');
    p.timers = p.timers || {};
    clearTimeout(p.timers[slot]);
    p.timers[slot] = setTimeout(onTimeout, 15000);
  }
  #answered(p, slot) { if (p.timers) clearTimeout(p.timers[slot]); }
  static NO_ANSWER = 'The phone didn’t answer. Open DropWave on the phone once, and allow “Work when locked” there so it answers while locked.';

  smsLoad(id) {
    const p = this.#need(id);
    const m = this.#smsOf(p);
    m.loading = true;
    this.#ask(p, { type: 'sms-threads' }, 'smsThreads', () => { if (m.loading) { m.loading = false; m.error = PhoneHub.NO_ANSWER; this.#smsPush(p); } });
    this.#smsPush(p);
  }

  smsOpen(id, thread, address) {
    const p = this.#need(id);
    const m = this.#smsOf(p);
    m.open = { thread: num(thread), address: str(address, 40), messages: m.open?.thread === num(thread) ? m.open.messages : [], loading: true };
    const t = m.threads.find((x) => x.thread === num(thread));
    if (t) t.unread = 0; // read on the PC (the phone keeps its own read state)
    if (num(thread) != null) {
      this.#ask(p, { type: 'sms-thread', thread: num(thread) }, 'smsThread', () => {
        if (m.open?.loading) { m.open = { ...m.open, loading: false, error: PhoneHub.NO_ANSWER }; this.#smsPush(p); }
      });
    } else m.open.loading = false;
    this.#smsPush(p);
  }

  smsSend(id, to, text) {
    const p = this.#need(id);
    const m = this.#smsOf(p);
    to = str(to, 40).trim(); text = str(text, 2000);
    if (!to || !text.trim()) throw new Error('Nothing to send');
    const ref = crypto.randomUUID();
    if (!m.open || m.open.address !== to) m.open = { thread: m.threads.find((x) => x.address === to)?.thread ?? null, address: to, messages: [], loading: false };
    m.open.messages = [...m.open.messages, { id: ref, body: text, date: Date.now(), out: true, pending: true }];
    this.o.web().sendPhone(id, { type: 'sms-send', to, text, ref });
    this.#smsPush(p);
  }

  #gotSms(p, type, d) {
    const m = this.#smsOf(p);
    if (type === 'sms-threads') {
      this.#answered(p, 'smsThreads');
      m.loading = false;
      m.access = ['all', 'partial', 'none'].includes(d.access) ? d.access : m.access;
      m.error = d.error ? str(d.error, 200) : null;
      if (Array.isArray(d.list)) {
        m.threads = d.list.slice(0, 200).map((t) => ({
          thread: num(t.thread), address: str(t.address, 40), name: str(t.name, 80), snippet: str(t.snippet, 200),
          date: num(t.date) || 0, out: !!t.out, unread: num(t.unread) || 0, code: findCode(str(t.snippet, 200)),
        }));
      }
    } else if (type === 'sms-thread') {
      this.#answered(p, 'smsThread');
      if (m.open && d.error) m.open = { ...m.open, loading: false, error: str(d.error, 200) };
      else if (m.open && m.open.thread === num(d.thread)) {
        const msgs = (Array.isArray(d.messages) ? d.messages : []).slice(-200).map((x) => ({
          id: num(x.id), body: str(x.body, 5000), date: num(x.date) || 0, out: !!x.out, failed: !!x.failed, pending: !!x.pending, code: x.out ? null : findCode(str(x.body, 5000)),
        }));
        m.open = { ...m.open, messages: msgs, loading: false, error: null };
      }
    } else if (type === 'sms') {
      const address = str(d.address, 40), body = str(d.body, 5000), date = num(d.date) || Date.now();
      const t = m.threads.find((x) => x.address === address);
      const row = { ...(t || { thread: null, address, name: str(d.name, 80) }), snippet: body.slice(0, 200), date, out: false, unread: (t?.unread || 0) + 1, code: findCode(body) };
      m.threads = [row, ...m.threads.filter((x) => x !== t)];
      if (m.open && m.open.address === address) {
        m.open = { ...m.open, messages: [...m.open.messages, { id: `in-${date}`, body, date, out: false, code: findCode(body) }] };
        row.unread = 0;
      }
    } else if (type === 'sms-sent') {
      if (!d.ok) this.o.push('phone-error', { id: p.id, error: str(d.error, 200) || 'Couldn’t send the message' });
      if (m.open) m.open = { ...m.open, messages: m.open.messages.map((x) => (x.id === d.ref ? { ...x, pending: false, failed: !d.ok } : x)) };
      // Pick up the saved message (and a new conversation's thread id) from the phone.
      setTimeout(() => this.o.web()?.sendPhone(p.id, { type: 'sms-threads' }), 1200);
      if (d.ok) setTimeout(() => {
        const t = m.threads.find((x) => x.address === m.open?.address);
        if (t && m.open) { m.open.thread = t.thread; this.o.web()?.sendPhone(p.id, { type: 'sms-thread', thread: t.thread }); }
      }, 2500);
    }
    this.#smsPush(p);
  }

  // ---------- phone files ----------

  #filesOf(p) {
    if (!p.files) p.files = { path: '', items: [], total: null, free: null, loading: false, error: null, access: null };
    return p.files;
  }

  #filesPush(p) { this.o.push('phone-files', { id: p.id, ...this.#filesOf(p) }); }
  files(id) { const p = this.phones.get(id); return p ? { id, ...this.#filesOf(p) } : null; }

  filesList(id, rel, hidden) {
    const p = this.#need(id);
    const f = this.#filesOf(p);
    f.loading = true;
    f.error = null;
    this.#ask(p, { type: 'files-list', path: str(rel, 1000), hidden: !!hidden }, 'files', () => {
      if (f.loading) { f.loading = false; f.error = PhoneHub.NO_ANSWER; this.#filesPush(p); }
    });
    this.#filesPush(p);
  }

  #gotFiles(p, d) {
    this.#answered(p, 'files');
    const f = this.#filesOf(p);
    f.loading = false;
    if (d.access === 'none') { f.access = 'none'; this.#filesPush(p); return; }
    if (d.error) { f.error = str(d.error, 200); this.#filesPush(p); return; }
    f.access = 'all';
    f.path = str(d.path, 1000);
    f.total = num(d.total); f.free = num(d.free);
    f.items = (Array.isArray(d.items) ? d.items : []).slice(0, 2000).map((x) => ({
      name: str(x.name, 255), dir: !!x.dir, size: num(x.size) || 0, mtime: num(x.mtime) || 0, count: num(x.count), mime: str(x.mime, 80),
    })).filter((x) => x.name && !x.name.includes('/'));
    this.#filesPush(p);
  }

  /** Download files (names in the folder on screen). */
  filesGet(id, names) {
    const p = this.#need(id);
    const f = this.#filesOf(p);
    const pick = [...new Set(names)].map((n) => f.items.find((x) => !x.dir && x.name === n)).filter(Boolean).slice(0, 500)
      .map((x, i) => ({ id: String(i), name: x.name, size: x.size, rel: f.path ? `${f.path}/${x.name}` : x.name }));
    return this.#download(p, pick, (token) => ({ type: 'files-get', paths: pick.map((x) => x.rel), token }));
  }

  // ---------- PC -> phone ----------

  command(id, cmd) {
    const p = this.phones.get(id);
    const web = this.o.web();
    if (!p || !web) throw new Error('The phone is no longer connected');
    if (!cmd || typeof cmd.type !== 'string') throw new Error('Unknown command');
    const ok = web.sendPhone(id, cmd);
    if (!ok) throw new Error('The phone is no longer connected');
    if (cmd.type === 'ring') { p.ringing = !!cmd.on; this.#emit(p); if (cmd.on) this.#event('ring', p, 'Ringing the phone'); }
    if (cmd.type === 'notif' && cmd.action === 'dismiss') { p.notifs = p.notifs.filter((n) => n.key !== cmd.key); this.#emit(p); }
    if (cmd.type === 'notif' && cmd.action === 'clear') { p.notifs = []; this.#emit(p); }
    if (cmd.type === 'clip') this.#event('clip-out', p, 'Clipboard sent');
    if (cmd.type === 'dial') this.#event('dial', p, `Calling ${str(cmd.number, 40)}`);
    if (cmd.type === 'call' && cmd.action === 'answer' && p.call) { p.call = { ...p.call, state: 'offhook', since: Date.now() }; this.#emit(p); }
    return true;
  }

  #pollClipboard() {
    let t = '';
    try { t = this.o.clipboard.readText(); } catch { return; }
    if (!t || t === this.lastClip) return;
    this.lastClip = t;
    if (this.o.settings().clipSync === false || t.length > 100 * 1024) return;
    const web = this.o.web();
    for (const p of this.phones.values()) if (p.status?.clip) web?.sendPhone(p.id, { type: 'clip', text: t, auto: true });
  }

  // ---------- phone's touchpad / keyboard / Deck ----------

  #always() { return this.o.settings().remoteAllowed || []; }
  isAllowed(id) { return this.sessionAllowed.has(id) || this.#always().some((d) => d.id === id); }

  /** The answer to an Allow / Deny prompt on this PC. */
  respond(id, allow, always) {
    const who = this.asking.get(id) || this.phones.get(id) || { id, name: 'Phone' };
    this.asking.delete(id);
    if (allow) {
      this.sessionAllowed.add(id);
      this.names.set(id, who.name);
      if (always) this.o.saveSettings({ remoteAllowed: [...this.#always().filter((d) => d.id !== id), { id, name: who.name }] });
      this.#event('remote', who, always ? 'Can always control this PC' : 'Allowed to control this PC');
    }
    this.o.web()?.sendPhone(id, { type: 'remote', allowed: !!allow });
    this.o.push('remote-ask-closed', id);
    const p = this.phones.get(id);
    if (p) this.#emit(p);
    this.#pushRemote();
  }

  revoke(id) {
    this.sessionAllowed.delete(id);
    this.o.saveSettings({ remoteAllowed: this.#always().filter((d) => d.id !== id) });
    this.o.web()?.sendPhone(id, { type: 'remote', allowed: false });
    this.lastRemote.delete(id);
    const p = this.phones.get(id);
    if (p) this.#emit(p);
    this.#pushRemote();
  }

  pendingAsks() { return [...this.asking.values()]; }

  async remote(from, ev) {
    if (!this.isAllowed(from.id)) {
      if (!this.asking.has(from.id)) {
        this.asking.set(from.id, { id: from.id, name: from.name });
        this.o.push('remote-ask', { id: from.id, name: from.name });
        this.o.attention(`${from.name} wants to use your mouse and keyboard`, 'Open DropWave to allow or deny');
      }
      return { ok: false, ask: true, error: 'Waiting for the PC to allow it' };
    }
    if (!ev || typeof ev !== 'object' || ev.t === 'hello') return { ok: true };
    const first = Date.now() - (this.lastRemote.get(from.id) || 0) > 4000;
    this.lastRemote.set(from.id, Date.now());
    if (first) { const p = this.phones.get(from.id); if (p) this.#emit(p); this.#pushRemote(); }
    if (this.o.inputLog) { fs.appendFileSync(this.o.inputLog, JSON.stringify({ from: from.id, ...ev }) + '\n'); return { ok: true }; }
    if (ev.t === 'action') return this.#action(String(ev.a));
    try { await this.o.remoteInput.start(); } catch (e) { return { ok: false, error: e.message }; }
    this.o.remoteInput.handle(ev);
    return { ok: true };
  }

  #action(a) {
    if (process.platform !== 'win32') return { ok: false, error: 'Works on Windows PCs for now' };
    const run = (cmd, args) => spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    if (a === 'lock') run('rundll32.exe', ['user32.dll,LockWorkStation']);
    else if (a === 'sleep') run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"]);
    else return { ok: false, error: 'Unknown action' };
    return { ok: true };
  }
}

module.exports = { PhoneHub, findCode };
