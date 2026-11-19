// Phone page extras: "Control PC" (touchpad, keyboard, Deck) in any browser, and, inside the
// DropWave Android app, sharing this phone with the PC: battery, notifications (with replies),
// what's playing, clipboard, and "Find my phone".
// Uses window.DW_PAGE = { api, myId, toast, pcName() } set up by index.html.
(function () {
  const P = () => window.DW_PAGE;
  const DW = window.Capacitor?.Plugins?.DropWave || null; // only inside the Android app
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const post = (path, body) => P().api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: P().myId, ...body }) });
  const phone = (type, data) => post('/api/phone', { type, data }).catch(() => {});
  const I = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
  const ICONS = {
    pad: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 14h18M12 14v6"/>',
    clip: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    kbd: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    play: '<path d="M6 4v16l14-8z"/>', prev: '<path d="M19 20 9 12l10-8zM5 19V5"/>', next: '<path d="m5 4 10 8-10 8zM19 5v14"/>',
    vdown: '<path d="M11 5 6 9H2v6h4l5 4zM22 12h-6"/>', vup: '<path d="M11 5 6 9H2v6h4l5 4zM19 9v6M16 12h6"/>', mute: '<path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6"/>',
    desk: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>', swap: '<path d="m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>',
    close: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m15 9-6 6M9 9l6 6"/>', shot: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
    task: '<path d="M3 12h4l3 8 4-16 3 8h4"/>', copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>', undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sl: '<path d="m15 18-6-6 6-6"/>', sr: '<path d="m9 18 6-6-6-6"/>', present: '<path d="M2 3h20M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3M7 21l5-5 5 5"/>',
  };

  // ---------- styles ----------
  const css = document.createElement('style');
  css.textContent = `
  .pgrid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:0 0 14px; }
  a.ptile, a.pcard { color:inherit; text-decoration:none; display:block; }
  .pcard { padding:14px; }
  .pcard-row { display:flex; gap:12px; align-items:flex-start; margin-bottom:2px; }
  .pcard-row b { display:block; font-size:14.5px; }
  .pcard-row small { display:block; font-size:12.5px; color:var(--faint); margin-top:3px; line-height:1.45; }
  .pcard .pbtn { margin-top:12px; }
  .pcard-ic { width:40px; height:40px; border-radius:13px; flex:none; display:grid; place-items:center; color:var(--accent); background:color-mix(in oklab, var(--accent) 14%, transparent); }
  .pcard-ic.on { color:#fff; background:linear-gradient(120deg,var(--accent),var(--accent2)); }
  .ptile { display:flex; flex-direction:column; align-items:flex-start; gap:10px; padding:14px; border-radius:18px; background:var(--raised); border:1px solid var(--line); text-align:left; }
  .ptile .ic { width:38px; height:38px; border-radius:12px; display:grid; place-items:center; color:var(--accent); background:color-mix(in oklab, var(--accent) 14%, transparent); }
  .ptile b { font-size:14.5px; display:block; } .ptile small { font-size:12px; color:var(--faint); display:block; margin-top:2px; }
  .ptile.wide { grid-column:1 / -1; flex-direction:row; align-items:center; }
  .ptile.wide > div { flex:1; min-width:0; }
  .ptile.on { border-color:var(--accent); box-shadow:0 0 0 3px var(--glow); }
  .remote { position:fixed; inset:0; z-index:54; background:var(--bg); display:flex; flex-direction:column; padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
  .remote .rtop { display:flex; align-items:center; gap:10px; padding:12px 14px; }
  .remote .rtop b { flex:1; font-size:16px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .remote .rtop button { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; background:var(--raised); border:1px solid var(--line); }
  .rtabs { display:flex; gap:6px; margin:0 14px 10px; padding:4px; border-radius:14px; background:var(--raised); border:1px solid var(--line); }
  .rtabs button { flex:1; height:36px; border-radius:10px; font-weight:600; font-size:13.5px; color:var(--muted); display:flex; align-items:center; justify-content:center; gap:6px; }
  .rtabs button.on { background:linear-gradient(120deg,var(--accent),var(--accent2)); color:#fff; }
  .rwait { margin:0 14px 10px; padding:12px 14px; border-radius:14px; font-size:13.5px; background:color-mix(in oklab, var(--accent) 12%, var(--raised)); border:1px solid color-mix(in oklab, var(--accent) 40%, var(--line)); }
  .pad { position:relative; flex:1; margin:0 14px; border-radius:24px; background:var(--raised); border:1px solid var(--line2); touch-action:none; overflow:hidden;
    background-image:radial-gradient(circle at 1px 1px, var(--line2) 1px, transparent 0); background-size:22px 22px; }
  .pad .hint { position:absolute; left:0; right:0; bottom:14px; text-align:center; font-size:12px; color:var(--faint); pointer-events:none; padding:0 10px; }
  .pad .dot { position:absolute; width:46px; height:46px; margin:-23px 0 0 -23px; border-radius:50%; background:var(--glow); pointer-events:none; transition:opacity .2s; }
  .pad.drag { border-color:var(--accent); box-shadow:inset 0 0 0 2px var(--accent); }
  .rbtns { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:10px 14px 0; }
  .rbtns button { height:48px; border-radius:16px; background:var(--raised); border:1px solid var(--line2); font-weight:600; font-size:14px; }
  .rbtns button:active, .rkeys button:active, .deck button:active { transform:scale(.96); }
  .rkeys { display:flex; gap:6px; overflow-x:auto; margin:8px 14px 0; scrollbar-width:none; }
  .rkeys button { flex:none; height:38px; min-width:46px; padding:0 12px; border-radius:11px; background:var(--raised); border:1px solid var(--line); font-size:13px; font-weight:600; }
  .rtype { display:flex; gap:8px; margin:8px 14px 12px; }
  .rtype input { flex:1; min-width:0; height:46px; border-radius:14px; border:1px solid var(--line2); background:var(--raised); padding:0 14px; font-size:15px; outline:none; }
  .rtype input:focus { border-color:var(--accent); }
  .rtype button { width:46px; height:46px; border-radius:14px; display:grid; place-items:center; background:var(--raised); border:1px solid var(--line2); }
  .deck { flex:1; overflow:auto; padding:0 14px 14px; }
  .deck h3 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); margin:12px 4px 8px; }
  .deck .g { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
  .deck button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px; height:84px; border-radius:18px; background:var(--raised); border:1px solid var(--line); font-size:12.5px; font-weight:600; }
  .deck button svg { color:var(--accent); width:24px; height:24px; }
  .deck button.warn svg { color:var(--bad); }
  @media (orientation: landscape) { .deck .g { grid-template-columns:repeat(6, 1fr); } }
  `;
  document.head.appendChild(css);

  // ---------- the "this phone & your PC" tiles ----------
  // Home tiles (slots in index.html): Control PC + Deck, Send clipboard, Lock / Sleep, and the
  // "phone notifications on PC" card (app) or "get the app" card (browser).
  function renderBox() {
    const ctl = $('#slotControl');
    if (!ctl) return;
    ctl.innerHTML = `<button class="pbtn primary wide" id="pControl">${I(ICONS.pad)}<span>Control PC</span></button>
      <button class="pbtn" id="pDeck">${I(ICONS.grid)}<span>Deck</span></button>`;
    $('#pControl').addEventListener('click', () => openRemote('pad'));
    $('#pDeck').addEventListener('click', () => openRemote('deck'));

    $('#slotClip').innerHTML = DW ? `<button class="pbtn" id="pClip">${I(ICONS.clip)}<span>Send clipboard</span></button>` : '';
    $('#pClip')?.addEventListener('click', sendClipboard);

    $('#slotPower').innerHTML = `<button class="pbtn outline warn" data-act="lock">${I(ICONS.lock)}<span>Lock PC</span></button>
      <button class="pbtn outline warn" data-act="sleep">${I(ICONS.moon)}<span>Sleep</span></button>`;
    $('#slotPower').querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => quickAction(btn.dataset.act)));

    const box = $('#phoneBox');
    const callCard = DW && callsAccess !== 'all' ? `<div class="group pcard" style="margin-top:8px">
        <div class="pcard-row"><span class="pcard-ic">${I('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>')}</span><div><b>Show calls on PC</b>
        <small>See who’s calling, answer, decline or dial from the PC, and recent calls. Android asks for Phone and Call log.</small></div></div>
        <button class="pbtn primary wide" id="pCallsOn" style="width:100%;justify-content:center">Allow calls</button></div>` : '';
    const card = (id, icon, title, text, btn) => `<div class="group pcard" style="margin-top:8px">
        <div class="pcard-row"><span class="pcard-ic">${I(icon)}</span><div><b>${title}</b><small>${text}</small></div></div>
        <button class="pbtn primary wide" id="${id}" style="width:100%;justify-content:center">${btn}</button></div>`;
    const smsCard = DW && smsAccess !== 'all' ? card('pSmsOn', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
      'Show messages on PC', 'Read and reply to SMS from the PC. Android asks for SMS and Contacts (for names).', 'Allow messages') : '';
    const filesCard = DW && filesAccess !== 'all' ? card('pFilesOn', '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      'Browse phone files from PC', 'Open this phone’s folders on the PC and copy files. In Android settings, turn on “Allow access to manage all files” for DropWave.', 'Open settings') : '';
    const ctlCard = DW && !controlAccess ? card('pCtlOn', '<path d="M4 4l7 17 2.5-7.5L21 11 4 4Z"/>',
      'Control this phone from PC', 'When the PC shows this screen, use its mouse and keyboard here. In Accessibility, turn on “DropWave: control from PC”.', 'Open settings') : '';
    const photoCard = DW && photosAccess === 'none' ? `<div class="group pcard" style="margin-top:8px">
        <div class="pcard-row"><span class="pcard-ic">${I(ICONS.shot)}</span><div><b>Share photos with PC</b>
        <small>See this phone’s photos and videos on the PC and save the ones you want. Nothing is copied until you pick it there.</small></div></div>
        <button class="pbtn primary wide" id="pPhotosOn" style="width:100%;justify-content:center">Allow photos</button></div>` : '';
    if (DW && !notifAccess) {
      box.innerHTML = `<div class="sec-h">Phone on PC</div><div class="group pcard">
        <div class="pcard-row"><span class="pcard-ic">${I(ICONS.bell)}</span><div><b>Show phone notifications on PC</b>
        <small>Reply, copy one-time codes and control music from the PC. If Android says “Restricted setting”: App info › ⋮ › Allow restricted settings.</small></div></div>
        <button class="pbtn primary wide" id="pNotifOn" style="width:100%;justify-content:center">Turn on</button></div>${photoCard}${callCard}${smsCard}${filesCard}${ctlCard}`;
      $('#pNotifOn').addEventListener('click', () => DW.openNotifAccess().catch(() => {}));
    } else if (DW) {
      box.innerHTML = `<div class="sec-h">Phone on PC</div><div class="group pcard"><div class="pcard-row"><span class="pcard-ic on">${I(ICONS.bell)}</span><div><b>Notifications, music &amp; clipboard are shared</b>
        <small>Your PC shows them on its Home page. Turn off in Android settings › Notification access.</small></div></div></div>${photoCard}${callCard}${smsCard}${filesCard}${ctlCard}`;
    }
    $('#pPhotosOn')?.addEventListener('click', () => DW.requestPhotos().catch(() => {}));
    $('#pCallsOn')?.addEventListener('click', () => DW.requestCalls().catch(() => {}));
    $('#pSmsOn')?.addEventListener('click', () => DW.requestSms().catch(() => {}));
    $('#pFilesOn')?.addEventListener('click', () => DW.openFilesAccess().catch(() => {}));
    $('#pCtlOn')?.addEventListener('click', () => DW.openControlAccess().catch(() => {}));
    if (!DW) {
      box.innerHTML = `<div class="sec-h">Get more</div><a class="group pcard" href="https://github.com/lalitaryan1993/dropwave/releases/latest" target="_blank" rel="noopener">
        <div class="pcard-row"><span class="pcard-ic">${I(ICONS.bell)}</span><div><b>Get the Android app</b><small>Phone notifications, clipboard sync, music and Find my phone on your PC.</small></div></div></a>`;
    }
  }

  // Lock / Sleep from Home: straight to the PC (it asks its user the first time).
  async function quickAction(a) {
    if (!confirm(a === 'sleep' ? `Put ${P().pcName()} to sleep?` : `Lock ${P().pcName()}?`)) return;
    try {
      const r = await post('/api/remote', { ev: { t: 'action', a } });
      const b = await r.json().catch(() => ({}));
      if (r.ok) P().toast(a === 'sleep' ? 'Going to sleep…' : 'Locked');
      else if (b.ask) P().toast(`Press Allow on ${P().pcName()}, then tap again`);
      else P().toast(b.error || 'Couldn’t do that');
    } catch { P().toast('Couldn’t reach the PC'); }
  }

  // ---------- Android app: share this phone with the PC ----------
  let notifAccess = false;
  let photosAccess = 'none';
  let callsAccess = 'none';
  let smsAccess = 'none';
  let filesAccess = 'none';
  let controlAccess = false;
  let lastClip = null; // last clipboard text seen or set here (no echo back to the PC)
  const sentIcons = new Set();

  async function sendStatus() {
    if (!DW) return;
    try {
      const s = await DW.phoneStatus();
      notifAccess = !!s.notifAccess;
      const hadCalls = callsAccess;
      photosAccess = s.photosAccess || 'none';
      callsAccess = s.callsAccess || 'none';
      smsAccess = s.smsAccess || 'none';
      filesAccess = s.filesAccess || 'none';
      controlAccess = !!s.controlAccess;
      if (callsAccess !== 'none' && hadCalls !== callsAccess) sendCallLog(); // just allowed
      phone('status', { ...s, clip: true, app: 'android' });
      renderBox();
    } catch {}
  }

  async function sendNotifs(list) {
    if (!list) { try { list = (await DW.notifSnapshot()).list; } catch { return; } }
    list = list || [];
    phone('notifs', { list });
    for (const n of list) {
      if (sentIcons.has(n.pkg)) continue;
      sentIcons.add(n.pkg);
      DW.appIcon({ pkg: n.pkg }).then((r) => r?.data && phone('icon', { pkg: n.pkg, data: r.data })).catch(() => {});
    }
  }

  function sendCallLog() {
    if (!DW) return;
    DW.callLog({ limit: 50 }).then((r) => phone('calllog', r)).catch(() => {});
  }

  async function sendMedia(m) {
    if (m === undefined) { try { m = (await DW.mediaSnapshot()).media; } catch { return; } }
    phone('media', m || null);
  }

  async function sendClipboard() {
    try {
      const r = await DW.readClipboard();
      if (!r?.text) return P().toast('The clipboard is empty');
      lastClip = r.text;
      await phone('clip', { text: r.text });
      P().toast(`Copied to ${P().pcName()}’s clipboard`);
    } catch { P().toast('Couldn’t read the clipboard'); }
  }

  // Android only lets apps read the clipboard while they're on screen: check when DropWave comes back.
  async function checkClipboard() {
    if (!DW || !connected) return;
    try {
      const r = await DW.readClipboard();
      if (r?.text && r.text !== lastClip && !r.sensitive) { lastClip = r.text; phone('clip', { text: r.text }); }
      else if (r?.text) lastClip = r.text;
    } catch {}
  }

  let connected = false;
  function onConnected() {
    connected = true;
    sentIcons.clear();
    if (!DW) return;
    sendStatus();
    sendNotifs();
    sendMedia();
    sendCallLog();
    DW.callState().then((r) => r?.call && phone('call', r.call)).catch(() => {});
    if (lastClip === null) DW.readClipboard().then((r) => { lastClip = r?.text || ''; }).catch(() => { lastClip = ''; });
  }

  if (DW) {
    DW.addListener('phoneNotifs', (d) => connected && sendNotifs(d.list || []));
    DW.addListener('phoneMedia', (d) => connected && sendMedia(d.media || null));
    DW.addListener('battery', () => connected && sendStatus());
    DW.addListener('volume', () => connected && sendStatus());
    DW.addListener('access', () => connected && sendStatus()); // back from a permission dialog / settings
    DW.addListener('call', (d) => connected && phone('call', d));
    DW.addListener('appcall', (d) => connected && phone('appcall', d));
    DW.addListener('sms', (d) => connected && phone('sms', d));
    DW.addListener('mirror', (d) => connected && phone('mirror', d));
    DW.addListener('photoUpload', (d) => { if (d.done === d.total) P().toast(`${d.total} sent to ${P().pcName()}`); });
    DW.addListener('ring', (d) => connected && phone('ring', { on: !!d.on }));
    DW.addListener('clip', (d) => { if (connected && d.text && d.text !== lastClip && !d.sensitive) { lastClip = d.text; phone('clip', { text: d.text }); } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { setTimeout(checkClipboard, 400); sendStatus(); } });
    window.addEventListener('focus', () => setTimeout(checkClipboard, 300));
  }

  // Commands from the PC
  function onCommand(c) {
    if (!c || typeof c !== 'object') return;
    if (c.type === 'remote') { remoteAllowed(!!c.allowed); return; }
    if (!DW) return;
    if (c.type === 'ring') DW.ring({ on: !!c.on }).catch(() => {});
    else if (c.type === 'media') DW.mediaControl({ action: String(c.action), pos: Number(c.pos) || 0 }).catch(() => P().toast('Nothing is playing on this phone'));
    else if (c.type === 'photos') {
      DW.photoPage({ offset: Number(c.offset) || 0, limit: Number(c.limit) || 60, kind: String(c.kind || 'all') })
        .then((r) => phone('photos', r))
        .catch((e) => phone('photos', { error: e?.message || 'Couldn’t read the photos', offset: Number(c.offset) || 0, kind: c.kind }));
    } else if (c.type === 'photo-get' && Array.isArray(c.ids)) {
      const app = window.DW_APP || {};
      DW.uploadPhotos({ ids: c.ids.map(String), token: String(c.token || ''), base: app.base || '', key: app.key || '', from: P().myId })
        .then(() => P().toast(`Sending ${c.ids.length} to ${P().pcName()}…`)).catch(() => P().toast('Couldn’t send the photos'));
    } else if (c.type === 'call') {
      DW.callAction({ action: String(c.action) }).catch((e) => P().toast(e?.message || 'Couldn’t do that'));
    } else if (c.type === 'dial') {
      DW.dial({ number: String(c.number || '') }).catch((e) => phone('dial-error', { error: e?.message || 'Couldn’t place the call' }));
    } else if (c.type === 'sms-threads') {
      DW.smsThreads({ limit: 80 }).then((r) => phone('sms-threads', r)).catch((e) => phone('sms-threads', { error: e?.message || 'Couldn’t read messages' }));
    } else if (c.type === 'sms-thread') {
      DW.smsThread({ thread: Number(c.thread) }).then((r) => phone('sms-thread', r)).catch((e) => phone('sms-thread', { thread: c.thread, error: e?.message || 'Couldn’t open that conversation' }));
    } else if (c.type === 'sms-send') {
      DW.smsSend({ to: String(c.to || ''), text: String(c.text || '') })
        .then(() => phone('sms-sent', { to: c.to, ref: c.ref, ok: true }))
        .catch((e) => phone('sms-sent', { to: c.to, ref: c.ref, ok: false, error: e?.message || 'Couldn’t send' }));
    } else if (c.type === 'files-list') {
      DW.filesList({ path: String(c.path || ''), hidden: !!c.hidden }).then((r) => phone('files', r)).catch((e) => phone('files', { path: c.path, error: e?.message || 'Couldn’t open that folder' }));
    } else if (c.type === 'files-get' && Array.isArray(c.paths)) {
      const app = window.DW_APP || {};
      DW.uploadFiles({ paths: c.paths.map(String), token: String(c.token || ''), base: app.base || '', key: app.key || '', from: P().myId })
        .then(() => P().toast(`Sending ${c.paths.length} file${c.paths.length > 1 ? 's' : ''} to ${P().pcName()}…`)).catch(() => P().toast('Couldn’t send the files'));
    } else if (c.type === 'mirror-start') {
      const app = window.DW_APP || {};
      DW.mirrorStart({ token: String(c.token || ''), base: app.base || '', key: app.key || '', from: P().myId })
        .then((r) => { if (!r?.prompted) P().toast(`Tap the notification to show this screen on ${P().pcName()}`); })
        .catch((e) => phone('mirror', { on: false, error: e?.message || 'Couldn’t start' }));
    } else if (c.type === 'mirror-stop') {
      DW.mirrorStop().catch(() => {});
    } else if (c.type === 'mirror-input' && c.ev) {
      DW.mirrorInput(c.ev).catch((e) => phone('mirror', { on: true, error: e?.message || '' }));
    } else if (c.type === 'calllog') {
      sendCallLog();
    } else if (c.type === 'volume') DW.volume({ action: String(c.action), value: Number(c.value) || 0 }).then(sendStatus).catch((e) => P().toast(e?.message || 'Couldn’t change the volume'));
    else if (c.type === 'notif') DW.notifAction({ key: String(c.key || ''), action: String(c.action), i: Number(c.i) || 0, text: String(c.text || '') }).catch(() => P().toast('Couldn’t do that on this phone'));
    else if (c.type === 'clip' && typeof c.text === 'string') {
      lastClip = c.text;
      DW.setClipboard({ text: c.text }).then(() => { if (!c.auto) P().toast(`Copied from ${P().pcName()}`); }).catch(() => {});
    }
  }

  // ---------- Control PC: touchpad, keyboard, Deck ----------
  let remote = null; // the overlay while open
  const queue = [];
  let pumping = false;
  let waiting = false;

  function send(ev) {
    if (ev.t === 'rel') {
      const last = queue[queue.length - 1];
      if (last && last.t === 'rel') { last.dx += ev.dx; last.dy += ev.dy; return; }
    }
    if (ev.t === 'wheel') {
      const last = queue[queue.length - 1];
      if (last && last.t === 'wheel') { last.dy += ev.dy; return; }
    }
    queue.push(ev);
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const ev = queue.shift();
      if (ev.t === 'rel') { ev.dx = Math.round(ev.dx); ev.dy = Math.round(ev.dy); if (!ev.dx && !ev.dy) continue; }
      try {
        const r = await post('/api/remote', { ev });
        if (r.status === 403) {
          const b = await r.json().catch(() => ({}));
          queue.length = 0;
          if (b.ask) setWaiting(true);
          else if (b.error) P().toast(b.error);
        } else if (r.ok && waiting) setWaiting(false);
      } catch { queue.length = 0; }
    }
    pumping = false;
  }

  function setWaiting(on) {
    waiting = on;
    const w = remote && $('.rwait', remote);
    if (w) { w.classList.toggle('hidden', !on); w.textContent = `Waiting for ${P().pcName()} to allow… Press Allow on the PC.`; }
  }

  function remoteAllowed(ok) {
    if (!remote) return;
    if (ok) { setWaiting(false); P().toast('You can control the PC now'); }
    else { P().toast(`${P().pcName()} said no`); closeRemote(); }
  }

  const DECK = [
    ['Media', [['Previous', ICONS.prev, { t: 'key', key: 'MediaTrackPrevious' }], ['Play / Pause', ICONS.play, { t: 'key', key: 'MediaPlayPause' }], ['Next', ICONS.next, { t: 'key', key: 'MediaTrackNext' }],
      ['Volume −', ICONS.vdown, { t: 'key', key: 'AudioVolumeDown' }], ['Mute', ICONS.mute, { t: 'key', key: 'AudioVolumeMute' }], ['Volume +', ICONS.vup, { t: 'key', key: 'AudioVolumeUp' }]]],
    ['Windows', [['Show desktop', ICONS.desk, { t: 'key', key: 'D', mods: ['Meta'] }], ['Switch app', ICONS.swap, { t: 'key', key: 'Tab', mods: ['Alt'] }], ['Close window', ICONS.close, { t: 'key', key: 'F4', mods: ['Alt'] }],
      ['Screenshot', ICONS.shot, { t: 'key', key: 'S', mods: ['Meta', 'Shift'] }], ['Task Manager', ICONS.task, { t: 'key', key: 'Escape', mods: ['Control', 'Shift'] }], ['Task view', ICONS.grid, { t: 'key', key: 'Tab', mods: ['Meta'] }]]],
    ['Edit', [['Copy', ICONS.copy, { t: 'key', key: 'C', mods: ['Control'] }], ['Paste', ICONS.paste, { t: 'key', key: 'V', mods: ['Control'] }], ['Undo', ICONS.undo, { t: 'key', key: 'Z', mods: ['Control'] }]]],
    ['Slides', [['Previous slide', ICONS.sl, { t: 'key', key: 'ArrowLeft' }], ['Start show', ICONS.present, { t: 'key', key: 'F5' }], ['Next slide', ICONS.sr, { t: 'key', key: 'ArrowRight' }]]],
    ['Power', [['Lock PC', ICONS.lock, { t: 'action', a: 'lock' }, 'warn'], ['Sleep', ICONS.moon, { t: 'action', a: 'sleep' }, 'warn']]],
  ];

  function openRemote(start = 'pad') {
    if (remote) return;
    remote = document.createElement('div');
    remote.className = 'remote';
    remote.innerHTML = `
      <div class="rtop"><b>Control ${esc(P().pcName())}</b><button id="rClose" aria-label="Close">${I(ICONS.x)}</button></div>
      <div class="rtabs"><button data-tab="pad" class="on">${I(ICONS.pad)} Touchpad</button><button data-tab="deck">${I(ICONS.grid)} Deck</button></div>
      <div class="rwait hidden"></div>
      <div data-pane="pad" style="display:flex;flex-direction:column;flex:1;min-height:0">
        <div class="pad" id="rPad"><div class="dot" style="opacity:0"></div><div class="hint">Move with one finger · tap = click · two-finger tap = right-click · two fingers = scroll · hold, then move = drag</div></div>
        <div class="rbtns"><button data-b="l">Left click</button><button data-b="r">Right click</button></div>
        <div class="rkeys">${[['Esc', 'Escape'], ['Tab', 'Tab'], ['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight'], ['⌫', 'Backspace'], ['Del', 'Delete'], ['↵', 'Enter'], ['Win', 'Meta'], ['Home', 'Home'], ['End', 'End'], ['PgUp', 'PageUp'], ['PgDn', 'PageDown']]
          .map(([l, k]) => `<button data-k="${k}">${l}</button>`).join('')}</div>
        <div class="rtype"><input id="rType" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="Type on the PC…" aria-label="Type on the PC" /><button id="rEnter" aria-label="Enter">${I('<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>')}</button></div>
      </div>
      <div data-pane="deck" class="deck" style="display:none">${DECK.map(([h, items]) => `<h3>${h}</h3><div class="g">${items.map(([l, ic, ev, cls], i) =>
        `<button class="${cls || ''}" data-deck='${esc(JSON.stringify(ev))}'>${I(ic)}<span>${l}</span></button>`).join('')}</div>`).join('')}</div>`;
    document.body.appendChild(remote);
    $('#rClose', remote).addEventListener('click', closeRemote);
    remote.querySelectorAll('.rtabs button').forEach((b) => b.addEventListener('click', () => {
      remote.querySelectorAll('.rtabs button').forEach((x) => x.classList.toggle('on', x === b));
      remote.querySelectorAll('[data-pane]').forEach((p) => { p.style.display = p.dataset.pane === b.dataset.tab ? (p.dataset.pane === 'pad' ? 'flex' : 'block') : 'none'; });
    }));
    remote.querySelectorAll('[data-b]').forEach((b) => b.addEventListener('click', () => send({ t: 'click', b: b.dataset.b })));
    remote.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => send({ t: 'key', key: b.dataset.k })));
    remote.querySelectorAll('[data-deck]').forEach((b) => b.addEventListener('click', () => {
      const ev = JSON.parse(b.dataset.deck);
      if (ev.t === 'action' && ev.a === 'sleep' && !confirm(`Put ${P().pcName()} to sleep?`)) return;
      if (ev.t === 'action' && ev.a === 'lock' && !confirm(`Lock ${P().pcName()}?`)) return;
      navigator.vibrate?.(12);
      send(ev);
    }));
    if (start === 'deck') remote.querySelector('.rtabs [data-tab="deck"]').click();
    setupPad($('#rPad', remote));
    setupTyping($('#rType', remote), $('#rEnter', remote));
    send({ t: 'hello' }); // asks the PC for permission right away, not on the first touch
  }

  function closeRemote() {
    if (!remote) return;
    remote.remove(); remote = null; waiting = false; queue.length = 0;
  }
  // Back (Android button, or the browser's): close the panel first.
  const prevBack = window.dwBack;
  window.dwBack = () => { if (remote) { closeRemote(); return true; } return prevBack ? prevBack() : false; };

  function setupPad(pad) {
    const dot = $('.dot', pad);
    const pts = new Map(); // pointerId -> { x, y, sx, sy, t }
    let moved = false, maxPts = 0, startT = 0, holdTimer = null, dragging = false, lastTapEnd = 0;
    const accel = (d) => d * (1.4 + Math.min(2.6, Math.abs(d) * 0.12)); // faster swipes go further
    const showDot = (x, y, on) => { const r = pad.getBoundingClientRect(); dot.style.left = `${x - r.left}px`; dot.style.top = `${y - r.top}px`; dot.style.opacity = on ? 1 : 0; };

    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      if (pts.size === 1) {
        moved = false; maxPts = 1; startT = Date.now();
        showDot(e.clientX, e.clientY, true);
        clearTimeout(holdTimer);
        // Hold still for a moment, then move: drag (select text, move windows).
        holdTimer = setTimeout(() => {
          if (!moved && pts.size === 1) { dragging = true; pad.classList.add('drag'); navigator.vibrate?.(25); send({ t: 'down', b: 'l' }); }
        }, 450);
      } else { maxPts = Math.max(maxPts, pts.size); clearTimeout(holdTimer); }
    });

    pad.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(p.x - p.sx, p.y - p.sy) > 8) { moved = true; if (!dragging) clearTimeout(holdTimer); }
      if (pts.size === 1) {
        showDot(e.clientX, e.clientY, true);
        if (moved || dragging) send({ t: 'rel', dx: accel(dx), dy: accel(dy) });
      } else if (pts.size === 2 && e.pointerId === [...pts.keys()][0]) {
        if (moved) send({ t: 'wheel', dy: Math.round(dy * 4) }); // natural scrolling: fingers up, page down
      }
    });

    const lift = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size) return;
      clearTimeout(holdTimer);
      showDot(0, 0, false);
      if (dragging) { dragging = false; pad.classList.remove('drag'); send({ t: 'up', b: 'l' }); return; }
      const quick = Date.now() - startT < 260;
      if (!moved && quick) {
        if (maxPts >= 2) send({ t: 'click', b: 'r' });
        else { send({ t: 'click', b: 'l' }); lastTapEnd = Date.now(); }
      }
    };
    pad.addEventListener('pointerup', lift);
    pad.addEventListener('pointercancel', lift);
    void lastTapEnd;
  }

  // The phone keyboard (with autocorrect and word suggestions) types on the PC: compare the field
  // before and after each change and send the difference.
  function setupTyping(input, enter) {
    let last = '';
    input.addEventListener('input', () => {
      const v = input.value;
      let i = 0;
      while (i < last.length && i < v.length && last[i] === v[i]) i++;
      for (let n = last.length - i; n > 0; n--) send({ t: 'key', key: 'Backspace' });
      if (v.length > i) send({ t: 'text', s: v.slice(i) });
      last = v;
    });
    const doEnter = () => { send({ t: 'key', key: 'Enter' }); input.value = ''; last = ''; };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doEnter(); }
      else if (e.key === 'Backspace' && !input.value) send({ t: 'key', key: 'Backspace' }); // nothing left here: still delete on the PC
    });
    enter.addEventListener('click', doEnter);
    input.addEventListener('blur', () => { input.value = ''; last = ''; });
  }

  window.dwPhone = { connected: onConnected, disconnected: () => { connected = false; }, command: onCommand, render: renderBox };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderBox); else renderBox();
})();
