const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, nativeTheme, clipboard, session, desktopCapturer } = require('electron');

// Calls/screen sharing stay on the local network: offer real LAN addresses instead of
// mDNS ".local" names, which some phones can't resolve.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const QRCode = require('qrcode');
const { Engine, localIPv4s, collectFiles, DEFAULT_TCP_PORT } = require('./engine.cjs');
const { WebShare, DEFAULT_WEB_PORT } = require('./webshare.cjs');
const { loadOrCreate: loadOrCreateTls } = require('./tls.cjs');
const { RemoteInput } = require('./input.cjs');
const { PhoneHub } = require('./phone.cjs');
const { UsbLink } = require('./usb.cjs');

// Remote control: off unless the user allows it for the screen share that is running now.
const remoteInput = new RemoteInput();
let controlOn = false;
let phoneHub = null;
const diagnostics = require('./diagnostics.cjs');

// ---- profiles (lets two copies run on one PC for testing) ----
const PROFILE = process.env.DROPWAVE_PROFILE;
if (PROFILE) app.setPath('userData', `${app.getPath('userData')}-${PROFILE}`);
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const START_HIDDEN = process.argv.includes('--hidden');

if (!PROFILE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
// Only the installed app has a Start-menu shortcut with this ID. Setting it in dev makes the
// taskbar fall back to electron.exe's icon instead of the DropWave window icon.
if (app.isPackaged) app.setAppUserModelId('com.dropwave.app');

// ---- tiny JSON stores ----
const dataFile = (n) => path.join(app.getPath('userData'), n);
function load(name, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(dataFile(name), 'utf8')) }; } catch { return fallback; }
}
function save(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 2));
}

let settings;
let history; // { items: [] }
let win = null;
let tray = null;
let engine = null;
let web = null;
let webError = null;
let usb = null; // USB cable link (adb reverse), started when settings.usb is on
let quitting = false;
const pendingRequests = new Map(); // requestId -> { resolve, request }
const active = new Map(); // transferId -> latest transfer object

function defaultSettings() {
  return {
    deviceId: crypto.randomUUID(),
    deviceName: os.hostname(),
    saveDir: path.join(app.getPath('downloads'), 'DropWave'),
    theme: 'system',
    autoStart: false,
    closeToTray: true,
    notifications: true,
    trusted: [], // [{ id, name }]
    autoAcceptTrusted: true,
    webEnabled: true,
    webPin: newPin(),
    identityKey: Engine.generateIdentityKey(), // this PC's long-term signing key (never leaves the PC)
    knownKeys: {}, // device id -> identity key, pinned on first contact
    accent: 'wave', // colour theme: wave, ocean, sunset, forest, graphite
    style: 'aurora', // look: aurora, frost (Windows Mica), petal, ink, dots
    language: 'en', // en | hi
    usb: false, // connect the phone over a USB cable too (needs adb + USB debugging)
    otpAutoCopy: true, // a new one-time code from the phone is copied here, and cleared after a minute
    clipSync: true, // copy on the phone, paste on the PC (and back) with the Android app
    phoneNotifs: true, // the phone's new notifications pop up on this PC too
    remoteAllowed: [], // [{ id, name }] phones that may always use this PC's mouse and keyboard
  };
}

function newPin() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

const allPeers = () => [...(engine ? engine.peerList() : []), ...(web ? web.clientList() : [])];

function webInfo() {
  const port = web?.port || Number(process.env.DROPWAVE_WEB_PORT) || DEFAULT_WEB_PORT;
  const ips = localIPv4s();
  const urls = ips.map((i) => `http://${i.address}:${port}`);
  return { enabled: settings.webEnabled && !!web, error: webError, port, pin: settings.webPin, urls, primary: urls[0] || null };
}

const publicState = () => ({
  // Never hand the private identity key (or the key store) to the UI.
  settings: (({ identityKey: _k, knownKeys: _kk, ...rest }) => rest)(settings),
  me: {
    id: settings.deviceId, name: settings.deviceName, ips: localIPv4s().map((i) => i.address), port: engine?.port,
    platform: process.platform, fingerprint: engine?.fingerprint, mica: canMica(),
  },
  web: webInfo(),
  peers: allPeers(),
  transfers: [...active.values()],
  history: history.items,
  pending: [...pendingRequests.values()].map((p) => p.request),
  version: app.getVersion(),
});

const push = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  // Phone updates also go to the call popup, and open / close it.
  if (channel === 'phone' || channel === 'phone-gone') callPopup(channel, payload);
};

// ---- call popup: a small window on top of everything while a phone rings or is on a call ----
let callWin = null;
function callPopup(channel, payload) {
  const calling = channel === 'phone' && payload?.call;
  if (callWin && !callWin.isDestroyed()) callWin.webContents.send(channel, payload);
  if (calling && (!callWin || callWin.isDestroyed())) {
    const { screen } = require('electron');
    const area = screen.getPrimaryDisplay().workArea;
    callWin = new BrowserWindow({
      width: 540, height: 130, x: area.x + area.width - 556, y: area.y + 16,
      frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, transparent: true, hasShadow: false,
      backgroundColor: '#00000000', title: 'Call · DropWave', icon: iconPath(),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    callWin.setAlwaysOnTop(true, 'screen-saver');
    const hash = `callwin=${encodeURIComponent(payload.id)}`;
    if (DEV_URL) callWin.loadURL(`${DEV_URL}#${hash}`); else callWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash });
    callWin.webContents.on('will-navigate', (e) => e.preventDefault());
    callWin.once('ready-to-show', () => callWin?.showInactive());
    callWin.on('closed', () => { callWin = null; });
  } else if (!calling && callWin && !callWin.isDestroyed()) {
    const id = channel === 'phone' ? payload?.id : payload;
    if (callWin.webContents.getURL().includes(`callwin=${encodeURIComponent(id)}`)) setTimeout(() => { try { callWin?.close(); } catch {} }, 400);
  }
}

// ---- window ----
const STYLE_BG = {
  aurora: ['#f5f6fa', '#0b0d14'], petal: ['#fff3f4', '#170c13'], ink: ['#f3f0e8', '#121212'], dots: ['#fbf6ec', '#13110d'],
};
// Frost lets the Windows 11 Mica backdrop show through (older Windows: a plain colour).
const canMica = () => process.platform === 'win32' && Number(os.release().split('.')[2] || 0) >= 22621;
function themeColors() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors);
  const symbol = dark ? '#e6e8f0' : '#1d2030';
  if (settings.style === 'frost' && canMica()) return { bg: '#00000000', symbol, mica: true };
  const pair = STYLE_BG[settings.style] || STYLE_BG.aurora;
  return { bg: dark ? pair[1] : pair[0], symbol, mica: false };
}

function createWindow() {
  const c = themeColors();
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: c.bg,
    title: 'DropWave',
    icon: iconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.symbol, height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // DropWave works while hidden in the tray; without this, Chromium pauses animation
      // frames in background windows and dialogs could stay stuck mid-close.
      backgroundThrottling: false,
    },
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  if (c.mica) { try { win.setBackgroundMaterial('mica'); } catch {} }
  win.once('ready-to-show', () => { if (!START_HIDDEN || pendingSend) win.show(); });

  // Dev-only: save window screenshots for visual checks.
  if (process.env.DROPWAVE_SHOT_DIR) {
    const dir = process.env.DROPWAVE_SHOT_DIR;
    let n = 0;
    setInterval(async () => {
      if (!win) return;
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `shot-${PROFILE || 'main'}-${++n}.png`), img.toPNG());
    }, 3000);
  }
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
  // Never let a dropped file navigate the window away from the app.
  win.webContents.on('will-navigate', (e, url) => { if (!DEV_URL || !url.startsWith(DEV_URL)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function openPlayer(src, name, local) {
  const p = new BrowserWindow({
    width: 1040, height: 640, minWidth: 420, minHeight: 280, backgroundColor: '#000000',
    title: `${name} · DropWave`, icon: iconPath(), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  p.setMenu(null);
  p.loadFile(path.join(__dirname, 'player.html'), { query: { src, name, local: local ? '1' : '0' } });
  p.webContents.on('will-navigate', (e) => e.preventDefault());
  p.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// ---- phone screen windows (one per phone) ----
const mirrorWins = new Map(); // phone id -> BrowserWindow
function openMirror(p) {
  const old = mirrorWins.get(p.id);
  if (old && !old.isDestroyed()) { old.show(); old.focus(); return; }
  const c = themeColors();
  const w = new BrowserWindow({
    width: 430, height: 880, minWidth: 260, minHeight: 360,
    backgroundColor: '#05060a', title: `${p.name} · DropWave`, icon: iconPath(),
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#05060a', symbolColor: '#e6e8f0', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  void c;
  const hash = `mirror=${encodeURIComponent(p.id)}&name=${encodeURIComponent(p.name)}${p.app ? `&app=1&phone=${encodeURIComponent(p.phone)}` : ''}`;
  if (DEV_URL) w.loadURL(`${DEV_URL}#${hash}`);
  else w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  mirrorWins.set(p.id, w);
  w.on('closed', () => {
    mirrorWins.delete(p.id);
    const a = appWins.get(p.id);
    if (a) { appWins.delete(p.id); web?.endStream(a.token); try { a.child.kill(); } catch {} }
    else phoneHub?.mirrorStop(p.id);
  });
}

function mirrorStateTo(id, s) { const w = mirrorWins.get(id); if (w && !w.isDestroyed()) w.webContents.send('mirror-state', s); }

// ---- a phone app in its own window (Elevated, over USB) ----
// DropWave's helper runs on the phone as the shell user (adb app_process), puts the app on a virtual
// display of its own and streams it here like the phone's screen. Taps go back to that display only.
const appWins = new Map(); // window id -> { child, token }
let dbgFrames = 0;
function appWindowStart(phoneId, pkg, label) {
  if (!/^[\w.]+$/.test(String(pkg))) throw new Error('Unknown app');
  if (!web) throw new Error('Turn on “Allow phones, tablets and TVs” in Settings first.');
  const d = usb?.ready();
  if (!d) throw new Error('To open phone apps in their own window, connect the phone with a USB cable: Settings › Phones & TVs › Connect over a USB cable.');
  const id = `aw:${phoneId}:${pkg}`;
  const open = mirrorWins.get(id);
  if (open && !open.isDestroyed() && appWins.has(id)) { open.show(); open.focus(); return true; }
  const token = crypto.randomBytes(16).toString('hex');
  web.allowMirror(token, {
    clientId: id, loopback: true,
    onFrame: (type, pts, data) => { if (process.env.DROPWAVE_DEBUG && (dbgFrames = (dbgFrames || 0) + 1) % 60 === 1) console.log('[appwin] frame', type, data.length, dbgFrames); sendFrame(mirrorWins.get(id), type, pts, data); },
    onEnd: () => { if (process.env.DROPWAVE_DEBUG) console.log('[appwin] stream ended'); mirrorStateTo(id, { state: 'off' }); },
  });
  openMirror({ id, name: label || pkg, app: true, phone: phoneId });
  mirrorStateTo(id, { state: 'asking' });
  const child = usb.helper(d.serial, 'com.dropwave.app.elevated.AppWindowServer', [`http://127.0.0.1:${web.port}`, web.appKey(), token, id, pkg, 720, 1520, 320]);
  let err = '';
  child.stderr.on('data', (b) => { err = (err + b).slice(-400); if (process.env.DROPWAVE_DEBUG) console.log('[appwin:err]', String(b).trim()); });
  child.stdout.on('data', (b) => { if (process.env.DROPWAVE_DEBUG) console.log('[appwin]', String(b).trim()); });
  child.on('exit', () => {
    const a = appWins.get(id);
    if (a?.child !== child) return;
    appWins.delete(id);
    const msg = err.trim().split(/\r?\n/).pop();
    if (msg) mirrorStateTo(id, { state: 'error', error: msg.includes('no launcher') ? 'This app can’t be opened in a window.' : msg });
  });
  appWins.set(id, { child, token });
  return true;
}

// ---- "DropWave Camera": the phone's camera as a Windows 11 webcam (Zoom, Meet, Teams…) ----
// dwcam.exe adds the camera while it runs and gets the pictures from the webcam window.
const vcamDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'vcam') : path.join(__dirname, '..', 'build', 'vcam'));
const vcamExe = () => { const p = path.join(vcamDir(), 'dwcam.exe'); return process.platform === 'win32' && fs.existsSync(p) ? p : null; };
const VCAM_FRAME = 1280 * 720 * 3 / 2;
let vcam = null; // { child, ready }
const vcamPush = (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('vcam-state', s); };
function vcamStatus() {
  const exe = vcamExe();
  if (!exe) return Promise.resolve({ status: 'missing', on: false });
  return new Promise((resolve) => {
    require('node:child_process').execFile(exe, ['status'], { windowsHide: true, timeout: 8000 }, (err, out) => {
      resolve({ status: err ? 'missing' : String(out).trim(), on: !!vcam?.ready });
    });
  });
}
function vcamInstall() {
  const exe = vcamExe();
  if (!exe) return Promise.resolve({ status: 'missing', on: false });
  // One Windows admin prompt: the camera is registered for the whole PC (Windows' camera service needs that).
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const ps = `Start-Process -FilePath ${q(exe)} -ArgumentList @('install', ${q('"' + path.join(vcamDir(), 'DropWaveCam.dll') + '"')}) -Verb RunAs -Wait -WindowStyle Hidden`;
  return new Promise((resolve) => {
    require('node:child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 120000 }, () => resolve(vcamStatus()));
  });
}
function vcamStart() {
  const exe = vcamExe();
  if (!exe) return Promise.resolve({ status: 'missing', on: false });
  if (vcam) return Promise.resolve({ status: 'installed', on: vcam.ready });
  return new Promise((resolve) => {
    const child = spawn(exe, ['run'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    vcam = { child, ready: false };
    let out = '';
    let answered = false;
    const answer = (r) => { if (!answered) { answered = true; resolve(r); vcamPush(r); } };
    child.stdout.on('data', (b) => {
      out += b;
      if (out.includes('ready')) { vcam && (vcam.ready = true); answer({ status: 'installed', on: true }); }
      else if (out.includes('error')) answer({ status: /not-installed/.test(out) ? 'not-installed' : /unsupported/.test(out) ? 'unsupported' : 'error', on: false, error: out.trim().slice(0, 200) });
    });
    child.stdin.on('error', () => {});
    child.on('exit', () => { vcam = null; answer({ status: 'error', on: false, error: 'The camera helper stopped' }); vcamPush({ status: 'installed', on: false }); });
    setTimeout(() => answer({ status: 'error', on: false, error: 'The camera didn’t start' }), 15000);
  });
}
function vcamStop() { if (vcam) { try { vcam.child.stdin.end(); } catch {} setTimeout(() => { try { vcam?.child.kill(); } catch {} }, 3000); } }
function vcamFrame(data) {
  if (!vcam?.ready || !data || data.byteLength !== VCAM_FRAME) return;
  const s = vcam.child.stdin;
  if (s.writableLength > VCAM_FRAME * 2) return; // the helper is behind: drop this one
  const h = Buffer.alloc(4); h.writeUInt32LE(VCAM_FRAME, 0);
  s.write(h); s.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

// A window that opens (or reloads) after the stream started missed its setup frames (size, codec
// config): remember them and send them again before the next key frame.
const streamMeta = new WeakMap(); // window -> { config, size, primed }
function sendFrame(w, type, pts, data) {
  if (!w || w.isDestroyed()) return;
  let m = streamMeta.get(w);
  if (!m) {
    m = { config: null, size: null, primed: false };
    streamMeta.set(w, m);
    w.webContents.on('did-finish-load', () => { m.primed = false; });
  }
  if (type === 3) m.size = Buffer.from(data);
  if (type === 1) { m.config = Buffer.from(data); m.primed = true; }
  if (type === 2 && !m.primed && m.config) {
    if (m.size) w.webContents.send('mirror-frame', { type: 3, pts: 0, data: m.size });
    w.webContents.send('mirror-frame', { type: 1, pts: 0, data: m.config });
    m.primed = true;
  }
  w.webContents.send('mirror-frame', { type, pts, data });
}

// ---- phone-as-webcam windows (one per phone) ----
const camWins = new Map();
function openCam(p) {
  const old = camWins.get(p.id);
  if (old && !old.isDestroyed()) { old.show(); old.focus(); return; }
  const w = new BrowserWindow({
    width: 960, height: 600, minWidth: 320, minHeight: 220,
    backgroundColor: '#000000', title: `${p.name} camera · DropWave`, icon: iconPath(),
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#000000', symbolColor: '#e6e8f0', height: 36 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  const hash = `webcam=${encodeURIComponent(p.id)}&name=${encodeURIComponent(p.name)}`;
  if (DEV_URL) w.loadURL(`${DEV_URL}#${hash}`);
  else w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  camWins.set(p.id, w);
  w.on('closed', () => { camWins.delete(p.id); phoneHub?.webcamStop(p.id); });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function applyTheme() {
  nativeTheme.themeSource = settings.theme;
  if (win) {
    const c = themeColors();
    try { win.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: 44 }); } catch {}
    win.setBackgroundColor(c.bg);
    try { win.setBackgroundMaterial(c.mica ? 'mica' : 'none'); } catch {}
  }
}

function iconPath(name = process.platform === 'win32' ? 'icon.ico' : 'icon.png') {
  const p = path.join(__dirname, '..', 'build', name);
  return fs.existsSync(p) ? p : undefined;
}

function createTray() {
  const p = iconPath('tray.png') || iconPath('icon.png');
  const img = p ? nativeImage.createFromPath(p).resize({ width: 16, height: 16, quality: 'best' }) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('DropWave');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DropWave', click: showWindow },
    { label: 'Open received files', click: () => { fs.mkdirSync(settings.saveDir, { recursive: true }); shell.openPath(settings.saveDir); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function notify(title, body, onClick) {
  if (!settings.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  n.on('click', () => { showWindow(); onClick?.(); });
  n.show();
}

const fmtSize = (b) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
};
const describe = (t) => (t.count === 1 ? t.files[0].name.split(/[\\/]/).pop() : `${t.count} files`);

function updateTaskbarProgress() {
  if (!win) return;
  const list = [...active.values()].filter((t) => t.status === 'active');
  if (!list.length) return win.setProgressBar(-1);
  const total = list.reduce((a, t) => a + t.total, 0) || 1;
  win.setProgressBar(list.reduce((a, t) => a + t.done, 0) / total);
}

// Text (clipboard) received from a PC or a browser: show it, never act on it automatically.
// ---- chat: one conversation per device, saved to chats.json ----
let chats; // { threads: { [peerId]: { peer:{id,name,kind,web}, messages:[], unread } } }
let openChat = null; // peer id whose conversation is on screen (no unread / notification for it)
const MAX_MESSAGES = 500;
let chatSaveTimer = null;
function saveChats() { clearTimeout(chatSaveTimer); chatSaveTimer = setTimeout(() => save('chats.json', chats), 300); }
function thread(peer) {
  const t = chats.threads[peer.id] || (chats.threads[peer.id] = { peer: {}, messages: [], unread: 0 });
  t.peer = { id: peer.id, name: peer.name || t.peer.name || 'Unknown', kind: peer.kind || peer.platform || t.peer.kind, web: !!peer.web || !!t.peer.web };
  return t;
}
function addMessage(peer, msg) {
  const t = thread(peer);
  t.messages.push(msg);
  if (t.messages.length > MAX_MESSAGES) t.messages.splice(0, t.messages.length - MAX_MESSAGES);
  if (msg.dir === 'in' && openChat !== peer.id) t.unread++;
  t.updatedAt = msg.at;
  saveChats();
  push('chat', { peerId: peer.id, peer: t.peer, message: msg, unread: t.unread });
  return t;
}
function updateMessage(peerId, msgId, patch) {
  const m = chats.threads[peerId]?.messages.find((x) => x.id === msgId);
  if (!m) return;
  Object.assign(m, patch);
  saveChats();
  push('chat', { peerId, peer: chats.threads[peerId].peer, message: m, unread: chats.threads[peerId].unread, update: true });
}
const chatSummaries = () => Object.values(chats.threads)
  .map((t) => ({ peer: t.peer, unread: t.unread, last: t.messages.at(-1) || null, updatedAt: t.updatedAt || 0 }))
  .sort((a, b) => b.updatedAt - a.updatedAt);

// Text from a PC or a browser lands in that device's conversation.
function handleText(m) {
  const t = addMessage({ ...m.from, kind: m.from.kind }, { id: m.id || crypto.randomUUID(), dir: 'in', text: m.text, at: m.at || Date.now() });
  const watching = openChat === m.from.id && win?.isVisible() && win?.isFocused();
  if (!watching) {
    notify(`Message from ${t.peer.name}`, m.text.length > 120 ? `${m.text.slice(0, 117)}…` : m.text, () => push('open-chat', m.from.id));
  }
}

// Call / screen-sharing signaling from a phone: hand it to the window; a ring brings it to the front.
function handleRtc({ from, msg }) {
  if (msg?.type === 'ring') {
    showWindow();
    win?.flashFrame(true);
    const what = msg.media === 'screen' ? (msg.share === 'callee' ? 'wants to see your screen' : 'wants to share their screen') : msg.media === 'video' ? 'is video calling' : 'is calling';
    notify(`${from.name} ${what}`, 'Open DropWave to answer');
  }
  push('rtc', { from, msg });
}

function handleTransfer(t) {
  const finished = ['completed', 'failed', 'rejected', 'cancelled'].includes(t.status);
  if (finished) {
    active.delete(t.id);
    history.items = [{ ...t, bps: undefined, eta: undefined }, ...history.items.filter((h) => h.id !== t.id)].slice(0, 300);
    save('history.json', history);
    if (t.direction === 'in' && t.status === 'completed' && (!win || !win.isFocused())) {
      notify('Files received', `${describe(t)} from ${t.from.name}`, () => t.savedTo?.[0] && shell.showItemInFolder(t.savedTo[0]));
    }
    if (t.direction === 'out' && t.status === 'completed' && (!win || !win.isFocused())) {
      notify('Sent', `${describe(t)} to ${t.to.name}`);
    }
  } else {
    if (t.direction === 'in' && t.web && !active.has(t.id) && (!win || !win.isFocused())) {
      notify(`Receiving from ${t.from.name}`, `${describe(t)} · ${fmtSize(t.total)}`);
    }
    active.set(t.id, t);
  }
  push('transfer', t);
  updateTaskbarProgress();
}

function forgetDevice(id) {
  const { [id]: _gone, ...rest } = settings.knownKeys || {};
  settings.knownKeys = rest;
  engine?.forgetPeerKey(id);
}

// Accept / Decline for anything arriving at this PC — from another PC or from a phone/TV browser.
function askUser(request) {
  const trusted = settings.trusted.some((d) => d.id === request.from.id);
  if (trusted && settings.autoAcceptTrusted) return Promise.resolve(true);
  return new Promise((resolve) => {
    pendingRequests.set(request.id, { resolve, request });
    push('incoming', request);
    if (!win || !win.isVisible() || !win.isFocused()) {
      notify(`${request.from.name} wants to send you files`, `${describe(request)} · ${fmtSize(request.total)}`);
      win?.flashFrame(true);
    }
  });
}

// ---- phones & TVs (browser access) ----
// The HTTPS certificate the Android app pins. Kept in its own file (private key: never in settings/UI).
function webTls() {
  try { return loadOrCreateTls(path.join(app.getPath('userData'), 'web-tls.json')); } catch (e) { console.error('web TLS:', e); return null; }
}

async function startWeb() {
  webError = null;
  if (!settings.webEnabled || web) return;
  const port = Number(process.env.DROPWAVE_WEB_PORT) || DEFAULT_WEB_PORT;
  const w = new WebShare({
    me: () => ({ id: settings.deviceId, name: settings.deviceName }),
    saveDir: () => settings.saveDir,
    pin: () => settings.webPin,
    webRoot: path.join(__dirname, 'web'),
    port,
    tls: webTls(),
    decide: askUser,
    remote: (from, ev) => phoneHub.remote(from, ev),
  });
  w.on('clients', (list) => { push('peers', allPeers()); phoneHub.sync(list); });
  w.on('phone', (m) => phoneHub.handle(m));
  w.on('transfer', handleTransfer);
  w.on('text', handleText);
  w.on('rtc', handleRtc);
  w.on('request-closed', (id) => { pendingRequests.delete(id); push('request-closed', id); });
  try {
    await w.start();
    web = w;
    if (engine) engine.webPort = port;
    usb?.poll();
  } catch (e) {
    webError = e.code === 'EADDRINUSE' ? `Port ${port} is used by another program` : e.message;
  }
}

async function stopWeb() {
  if (!web) return;
  const w = web;
  web = null;
  if (engine) engine.webPort = null;
  await w.stop();
  push('peers', allPeers());
  phoneHub.sync([]);
}

// ---- engine wiring ----
async function startEngine() {
  const port = Number(process.env.DROPWAVE_PORT) || DEFAULT_TCP_PORT;
  engine = new Engine({
    id: settings.deviceId,
    name: settings.deviceName,
    saveDir: settings.saveDir,
    port,
    decide: askUser,
    identityKey: settings.identityKey,
    knownKeys: settings.knownKeys,
    onNewKey: (id, key) => { settings.knownKeys = { ...settings.knownKeys, [id]: key }; save('settings.json', settings); },
  });

  engine.on('peers', () => push('peers', allPeers()));
  engine.on('request-closed', (id) => { pendingRequests.delete(id); push('request-closed', id); });
  engine.on('log', (m) => console.log('[engine]', m));
  engine.on('transfer', handleTransfer);
  engine.on('text', handleText);
  engine.on('rtc', handleRtc);

  try {
    await engine.start();
  } catch (e) {
    dialog.showErrorBox('DropWave could not start',
      e.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Another copy of DropWave may be running.`
        : e.message);
    quitting = true;
    app.quit();
  }
}

// ---- IPC ----
function registerIpc() {
  ipcMain.handle('state', () => publicState());

  ipcMain.handle('settings:update', async (_e, patch) => {
    const allowed = ['deviceName', 'theme', 'autoStart', 'closeToTray', 'notifications', 'autoAcceptTrusted', 'trusted', 'webEnabled', 'clipSync', 'phoneNotifs', 'accent', 'style', 'language', 'usb', 'otpAutoCopy'];
    if ('trusted' in patch) {
      // Removing a trusted device also forgets its pinned identity (e.g. after a reinstall).
      const keep = new Set((patch.trusted || []).map((d) => d.id));
      for (const d of settings.trusted) if (!keep.has(d.id)) forgetDevice(d.id);
    }
    for (const k of allowed) if (k in patch) settings[k] = patch[k];
    if ('deviceName' in patch) {
      settings.deviceName = String(patch.deviceName).trim().slice(0, 40) || os.hostname();
      engine.setName(settings.deviceName);
    }
    if ('style' in patch && !['aurora', 'frost', 'petal', 'ink', 'dots'].includes(settings.style)) settings.style = 'aurora';
    if ('theme' in patch || 'style' in patch) applyTheme();
    if ('autoStart' in patch && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!settings.autoStart, args: ['--hidden'] });
    }
    if ('webEnabled' in patch) { if (settings.webEnabled) await startWeb(); else await stopWeb(); }
    if ('usb' in patch) { if (settings.usb) usb.start(); else await usb.stop(); }
    save('settings.json', settings);
    push('state', publicState());
    return publicState();
  });

  // Updates
  ipcMain.handle('update:state', () => ({ ...update, supported: !!updater, version: app.getVersion() }));
  ipcMain.handle('update:check', async () => {
    if (!updater) return { ...update, supported: false };
    try { await updater.checkForUpdates(); } catch (e) { setUpdate({ state: 'error', error: String(e?.message || e).split('\n')[0] }); }
    return { ...update, supported: true };
  });
  ipcMain.handle('update:install', () => { if (update.state === 'ready') { quitting = true; updater.quitAndInstall(false, true); } });

  // Forget every remembered device identity (after someone reinstalled DropWave on their PC).
  ipcMain.handle('security:forgetKeys', () => {
    for (const id of Object.keys(settings.knownKeys || {})) forgetDevice(id);
    save('settings.json', settings);
    return Object.keys(settings.knownKeys || {}).length;
  });

  ipcMain.handle('settings:chooseSaveDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Save received files to', defaultPath: settings.saveDir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return publicState();
    settings.saveDir = r.filePaths[0];
    engine.setSaveDir(settings.saveDir);
    save('settings.json', settings);
    return publicState();
  });

  const findPeer = (peerId) => {
    const p = allPeers().find((x) => x.id === peerId);
    if (!p) throw new Error('That device is no longer online');
    return p;
  };

  // Computers get a direct TCP transfer; phones/TVs get download links in their browser.
  const sendTo = async (peer, paths) => {
    if (!peer.web) {
      // Let the receiving PC play media straight from us ("Play now") while it decides or copies.
      return engine.sendPaths(peer, paths, {
        streamLink: web ? (files) => web.addStreamLink(files.map((f) => ({ abs: f.abs, name: f.path }))) : null,
      });
    }
    const files = await collectFiles(paths);
    if (!files.length) throw new Error('Nothing to send — the folder is empty');
    return web.offer(peer.id, files.map((f) => ({ abs: f.abs, name: f.path, size: f.size })));
  };

  ipcMain.handle('send:paths', async (_e, peerId, paths) => {
    const clean = (paths || []).filter((p) => typeof p === 'string' && p && fs.existsSync(p));
    if (!clean.length) throw new Error('Could not read the dropped items');
    return sendTo(findPeer(peerId), clean);
  });

  ipcMain.handle('send:pick', async (_e, peerId, kind) => {
    const peer = findPeer(peerId);
    const r = await dialog.showOpenDialog(win, {
      title: `Send to ${peer.name}`,
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return sendTo(peer, r.filePaths);
  });

  // Explorer "Send with DropWave": the UI takes the waiting paths and sends them to a chosen device.
  ipcMain.handle('send:pending', () => pendingSend);
  ipcMain.handle('send:pendingDone', () => { pendingSend = null; });

  // Clipboard / text sharing
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); });
  // Remote control. The window turns it on only after the user presses "Allow" during a
  // screen share, and off when they stop it or the share ends.
  // DROPWAVE_INPUT_LOG (testing only): write the events to that file instead of moving the mouse.
  const inputLog = process.env.DROPWAVE_INPUT_LOG;
  ipcMain.handle('input:control', async (_e, on) => {
    controlOn = !!on;
    if (inputLog) { fs.appendFileSync(inputLog, JSON.stringify({ control: controlOn }) + '\n'); return controlOn; }
    if (controlOn) { await remoteInput.start(); win?.flashFrame(false); }
    else remoteInput.stop();
    return controlOn;
  });
  ipcMain.on('input:event', (_e, ev) => {
    if (!controlOn) return;
    if (inputLog) fs.appendFileSync(inputLog, JSON.stringify(ev) + '\n');
    else remoteInput.handle(ev);
  });
  // Phone on PC (Android app)
  ipcMain.handle('phone:list', () => ({ phones: phoneHub.list(), timeline: phoneHub.timeline, asks: phoneHub.pendingAsks(), remote: phoneHub.remoteState() }));
  ipcMain.handle('phone:cmd', (_e, id, cmd) => phoneHub.command(String(id), cmd));
  ipcMain.handle('remote:respond', (_e, id, allow, always) => phoneHub.respond(String(id), !!allow, !!always));
  ipcMain.handle('remote:revoke', (_e, id) => phoneHub.revoke(String(id)));
  ipcMain.handle('photos:get', (_e, id) => phoneHub.photos(String(id)));
  ipcMain.handle('photos:load', (_e, id, opts) => phoneHub.photosLoad(String(id), opts || {}));
  ipcMain.handle('photos:download', (_e, id, ids) => phoneHub.photosGet(String(id), Array.isArray(ids) ? ids.map(String) : []));
  ipcMain.handle('mirror:start', (_e, id) => phoneHub.mirrorStart(String(id)));
  // A stream window finished subscribing: send the codec setup again with the next key frame.
  ipcMain.on('mirror:ready', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const m = streamMeta.get(w);
    if (m) m.primed = false;
    // An app window: ask the helper for a fresh key frame right away.
    for (const [id, win] of mirrorWins) if (win === w && appWins.has(id)) web?.mirrorSend(id, { t: 'refresh' });
  });
  ipcMain.handle('appwin:start', (_e, phoneId, pkg, label) => appWindowStart(String(phoneId), String(pkg), String(label || '')));
  ipcMain.handle('mirror:stop', (_e, id) => phoneHub.mirrorStop(String(id)));
  ipcMain.handle('webcam:start', (_e, id, front) => phoneHub.webcamStart(String(id), !!front));
  ipcMain.handle('webcam:stop', (_e, id) => phoneHub.webcamStop(String(id)));
  ipcMain.handle('webcam:set', (_e, id, patch) => phoneHub.webcamSet(String(id), patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('callwin:size', (_e, h) => { if (callWin && !callWin.isDestroyed()) callWin.setSize(540, Math.max(110, Math.min(360, Number(h) || 130))); });
  ipcMain.handle('vcam:status', () => vcamStatus());
  ipcMain.handle('usb:status', () => usb.status());
  ipcMain.handle('usb:download', () => usb.download());
  ipcMain.handle('usb:install', async (_e, apk) => {
    const d = usb.ready();
    if (!d) throw new Error('Connect the phone with a USB cable first (Settings › Phones & TVs › Connect over a USB cable).');
    let file = apk && String(apk);
    if (!file) {
      const r = await dialog.showOpenDialog(win, { title: 'Install an app on the phone', filters: [{ name: 'Android apps', extensions: ['apk'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      file = r.filePaths[0];
    }
    if (!/\.apk$/i.test(file) || !fs.existsSync(file)) throw new Error('That isn’t an .apk file');
    return { ...(await usb.install(d.serial, file)), name: path.basename(file) };
  });
  ipcMain.handle('usb:radios', async () => { const d = usb.ready(); return d ? { usb: true, ...(await usb.radios(d.serial)) } : { usb: false }; });
  ipcMain.handle('usb:radio', async (_e, which, on) => {
    const d = usb.ready();
    if (!d || !['wifi', 'bluetooth'].includes(which)) throw new Error('Needs the USB cable');
    const r = await usb.setRadio(d.serial, which, !!on);
    if (!r.ok) throw new Error(`The phone didn’t allow that${r.error ? `: ${r.error}` : ''}`);
    return usb.radios(d.serial);
  });
  ipcMain.handle('vcam:install', () => vcamInstall());
  ipcMain.handle('vcam:start', () => vcamStart());
  ipcMain.handle('vcam:stop', () => { vcamStop(); return { on: false }; });
  ipcMain.on('vcam:frame', (_e, data) => vcamFrame(data));
  ipcMain.handle('win:top', (e, on) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && w !== win) w.setAlwaysOnTop(!!on, 'floating'); return !!on; });
  ipcMain.on('mirror:input', (_e, id, ev) => phoneHub.mirrorInput(String(id), ev));
  ipcMain.handle('mirror:shot', async (_e, name, dataUrl) => {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    const dir = path.join(settings.saveDir, 'Phone');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `Screenshot ${String(name || 'phone').replace(/[<>:"/\\|?*]/g, '_')} ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`);
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
    return file;
  });
  ipcMain.handle('backup:get', (_e, id) => phoneHub.backupState(String(id)));
  ipcMain.handle('backup:set', (_e, id, on) => phoneHub.backupSet(String(id), !!on));
  ipcMain.handle('backup:now', (_e, id) => phoneHub.backupCheck(String(id)));
  ipcMain.handle('sms:get', (_e, id) => phoneHub.sms(String(id)));
  ipcMain.handle('sms:load', (_e, id) => phoneHub.smsLoad(String(id)));
  ipcMain.handle('sms:open', (_e, id, thread, address) => phoneHub.smsOpen(String(id), thread, address));
  ipcMain.handle('sms:send', (_e, id, to, text) => phoneHub.smsSend(String(id), to, text));
  // Contacts, apps, phone controls: one question, one answer from the phone.
  const RPC_OK = new Set(['contacts', 'contactPhoto', 'apps', 'appIcons', 'appAction', 'controls', 'controlsSet']);
  ipcMain.handle('phone:rpc', (_e, id, method, args) => {
    if (!RPC_OK.has(method)) throw new Error('Unknown request');
    return phoneHub.rpc(String(id), method, args && typeof args === 'object' ? args : {}, method === 'contacts' || method === 'apps' ? 30000 : 20000);
  });
  ipcMain.handle('camera:take', (_e, id, mode) => phoneHub.cameraTake(String(id), mode === 'video' ? 'video' : 'photo'));
  ipcMain.handle('camera:copy', (_e, p) => {
    if (typeof p !== 'string' || !fs.existsSync(p) || !/\.(jpe?g|png|webp)$/i.test(p)) return false;
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  });
  ipcMain.handle('image:preview', (_e, p) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return null;
    const img = nativeImage.createFromPath(p);
    return img.isEmpty() ? null : img.resize({ width: 640, quality: 'good' }).toDataURL();
  });
  ipcMain.handle('apps:apk', (_e, id, pkg, name, size) => phoneHub.appApk(String(id), String(pkg || ''), String(name || ''), Number(size) || 0));
  ipcMain.handle('files:get', (_e, id) => phoneHub.files(String(id)));
  ipcMain.handle('files:list', (_e, id, rel, hidden) => phoneHub.filesList(String(id), String(rel || ''), hidden));
  ipcMain.handle('files:download', (_e, id, names) => phoneHub.filesGet(String(id), Array.isArray(names) ? names.map(String) : []));
  ipcMain.handle('rtc:send', async (_e, peerId, msg) => {
    const peer = findPeer(peerId);
    if (!peer.web) return engine.sendRtc(peer, msg); // another PC: over the encrypted engine channel
    if (!web?.sendRtc(peer.id, msg)) throw new Error('That device is no longer connected');
  });
  ipcMain.handle('text:send', async (_e, peerId, text) => {
    const peer = findPeer(peerId);
    if (peer.web) { if (!web?.sendText(peer.id, text)) throw new Error('That device is no longer connected'); return; }
    return engine.sendText(peer, text);
  });

  // Chat
  ipcMain.handle('chat:list', () => chatSummaries());
  ipcMain.handle('chat:get', (_e, peerId) => chats.threads[peerId]?.messages || []);
  ipcMain.handle('chat:open', (_e, peerId) => {
    openChat = peerId || null;
    const t = peerId && chats.threads[peerId];
    if (t && t.unread) { t.unread = 0; saveChats(); push('chat-read', peerId); }
  });
  ipcMain.handle('chat:clear', (_e, peerId) => { delete chats.threads[peerId]; saveChats(); return chatSummaries(); });
  ipcMain.handle('chat:send', async (_e, peerId, text) => {
    const body = String(text || '').trim().slice(0, 100 * 1024);
    if (!body) throw new Error('Nothing to send');
    const known = allPeers().find((x) => x.id === peerId) || chats.threads[peerId]?.peer || { id: peerId, name: 'Unknown' };
    const msg = { id: crypto.randomUUID(), dir: 'out', text: body, at: Date.now(), status: 'sending' };
    addMessage(known, msg);
    try {
      const peer = findPeer(peerId);
      if (peer.web) { if (!web?.sendText(peer.id, body)) throw new Error('That device is no longer connected'); }
      else await engine.sendText(peer, body);
      updateMessage(peerId, msg.id, { status: 'sent' });
    } catch (e) {
      updateMessage(peerId, msg.id, { status: 'failed', error: String(e.message || e).slice(0, 160) });
    }
    return msg.id;
  });
  ipcMain.handle('link:open', (_e, url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)); });

  ipcMain.handle('transfer:cancel', (_e, id) => { if (!web?.cancel(id)) engine.cancel(id); });

  ipcMain.handle('web:qr', async () => {
    const info = webInfo();
    if (!info.primary) return { ...info, qr: null };
    const qr = await QRCode.toDataURL(`${info.primary}/?k=${settings.webPin}`, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#0b0d14', light: '#ffffff' } });
    return { ...info, qr };
  });
  ipcMain.handle('web:resetPin', () => {
    settings.webPin = newPin();
    save('settings.json', settings);
    web?.kickAll();
    push('state', publicState());
    return publicState();
  });

  ipcMain.handle('request:respond', (_e, id, accept, trust) => {
    const p = pendingRequests.get(id);
    if (!p) return;
    if (accept && trust && p.request.from.id && !settings.trusted.some((d) => d.id === p.request.from.id)) {
      settings.trusted.push({ id: p.request.from.id, name: p.request.from.name });
      save('settings.json', settings);
    }
    pendingRequests.delete(id);
    p.resolve(!!accept);
    win?.flashFrame(false);
  });

  ipcMain.handle('peer:add', async (_e, address) => {
    const [ip, port] = String(address).trim().split(':');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('Enter an IP address like 192.168.1.20');
    return engine.probe(ip, Number(port) || DEFAULT_TCP_PORT);
  });

  ipcMain.handle('history:clear', () => { history.items = []; save('history.json', history); return []; });

  ipcMain.handle('shell:open', (_e, p) => {
    if (typeof p === 'string' && fs.existsSync(p)) return shell.openPath(p);
  });
  ipcMain.handle('shell:show', (_e, p) => {
    if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
    else { fs.mkdirSync(settings.saveDir, { recursive: true }); shell.openPath(settings.saveDir); }
  });
  ipcMain.handle('shell:openSaveDir', () => { fs.mkdirSync(settings.saveDir, { recursive: true }); return shell.openPath(settings.saveDir); });

  // Network check: why devices can't see each other, with one-click (UAC) fixes.
  const diagCtx = () => ({
    exe: process.execPath, engineOk: !!engine?.server, webOk: !settings.webEnabled || !!web, peerCount: allPeers().length,
  });
  let lastChecks = [];
  ipcMain.handle('diag:run', async () => (lastChecks = await diagnostics.runChecks(diagCtx())));
  ipcMain.handle('diag:fix', async (_e, id) => {
    const ok = await diagnostics.fix(String(id), diagCtx(), lastChecks.find((c) => c.id === id));
    lastChecks = await diagnostics.runChecks(diagCtx());
    return { ran: ok, checks: lastChecks };
  });

  // In-app player: a stream from another PC ("Play now") or a file already on this PC.
  ipcMain.handle('player:open', (_e, { url, file, name } = {}) => {
    let src, local = false;
    if (typeof url === 'string' && /^http:\/\/[\d.]+:\d{1,5}\/s\/[a-f0-9]{32}\/\d+(\/[^?#]*)?$/.test(url)) src = url;
    else if (typeof file === 'string' && fs.existsSync(file) && fs.statSync(file).isFile()) { src = require('node:url').pathToFileURL(file).href; local = true; }
    else throw new Error('Nothing to play');
    openPlayer(src, String(name || path.basename(file || 'Media')), local);
  });
}

// ---- lifecycle ----
// ---- auto-update (GitHub releases) ----
let update = { state: 'idle' }; // idle | checking | available | downloading | ready | latest | error
let updater = null;
function setUpdate(u) { update = { ...update, ...u }; push('update', update); }
function initUpdater() {
  // Only the installed app updates itself (dev builds and test profiles don't).
  if (!app.isPackaged || PROFILE) return;
  try { updater = require('electron-updater').autoUpdater; } catch { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  updater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => setUpdate({ state: 'latest', checkedAt: Date.now() }));
  updater.on('download-progress', (p) => setUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => {
    setUpdate({ state: 'ready', version: i.version });
    notify('DropWave update ready', `Version ${i.version} will install when you restart DropWave.`);
  });
  updater.on('error', (e) => setUpdate({ state: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 160) }));
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 10000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ---- Explorer "Send with DropWave" ----
// Explorer starts DropWave once per selected item ("--send <path>"); the single-instance lock
// forwards each to this process, so collect them briefly and show one "Send to…" picker.
let sendQueue = [];
let sendTimer = null;
let pendingSend = null; // paths waiting for the UI to pick a device
function pathsFromArgv(argv) {
  if (!argv.includes('--send')) return [];
  // Chromium may reorder switches and, in dev, passes the app folder as an argument too,
  // so take every absolute, existing path except the executable and the app itself.
  const skip = new Set([process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()])].map((p) => path.resolve(p).toLowerCase()));
  return argv.slice(1).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a)
    && !skip.has(path.resolve(a).toLowerCase()) && fs.existsSync(a));
}
function queueSend(paths) {
  if (!paths.length) return;
  sendQueue.push(...paths);
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    pendingSend = [...new Set(sendQueue)];
    sendQueue = [];
    showWindow();
    push('send-request', pendingSend);
  }, 700);
}

app.on('second-instance', (_e, argv) => {
  const paths = pathsFromArgv(argv);
  if (paths.length) queueSend(paths); else showWindow();
});

app.whenReady().then(async () => {
  // Screen sharing: share the main screen (with its sound on Windows). The share is only ever
  // started after the user accepts a request or presses "Share screen" in DropWave.
  // DROPWAVE_SHARE_SOURCE (demos/screenshots only): share the window whose title contains this
  // text instead of the whole screen, so a demo never shows someone's real desktop.
  const demoSource = process.env.DROPWAVE_SHARE_SOURCE;
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: demoSource ? ['window'] : ['screen'] })
      .then((sources) => {
        const src = demoSource ? sources.find((s) => s.name.includes(demoSource)) : sources[0];
        callback(src ? { video: src, ...(process.platform === 'win32' && !demoSource ? { audio: 'loopback' } : {}) } : {});
      })
      .catch(() => callback({}));
  });
  const firstRun = !fs.existsSync(dataFile('settings.json'));
  settings = load('settings.json', defaultSettings());
  // Test profiles get a distinguishable default name, but never override a name the user chose.
  if (firstRun && PROFILE) settings.deviceName = `${os.hostname()} (${PROFILE})`;
  // Always write back, so settings added in a newer version (e.g. the identity key) persist.
  save('settings.json', settings);
  history = load('history.json', { items: [] });
  chats = load('chats.json', { threads: {} });
  nativeTheme.themeSource = settings.theme;
  nativeTheme.on('updated', () => { applyTheme(); push('state', publicState()); });

  if (!settings.webPin) { settings.webPin = newPin(); save('settings.json', settings); }
  phoneHub = new PhoneHub({
    push, notify,
    web: () => web,
    settings: () => settings,
    saveSettings: (patch) => { Object.assign(settings, patch); save('settings.json', settings); push('state', publicState()); },
    clipboard, remoteInput,
    focused: () => !!win && win.isVisible() && win.isFocused(),
    attention: (title, body) => { notify(title, body); win?.flashFrame(true); },
    transfer: handleTransfer,
    openMirror,
    openCam,
    camFrame: (id, type, pts, data) => sendFrame(camWins.get(id), type, pts, data),
    camState: (id, s) => { const w = camWins.get(id); if (w && !w.isDestroyed()) w.webContents.send('mirror-state', s); },
    mirrorFrame: (id, type, pts, data) => sendFrame(mirrorWins.get(id), type, pts, data),
    mirrorState: (id, s) => { const w = mirrorWins.get(id); if (w && !w.isDestroyed()) w.webContents.send('mirror-state', s); },
    inputLog: process.env.DROPWAVE_INPUT_LOG,
  });
  phoneHub.start();
  registerIpc();
  await startEngine();
  usb = new UsbLink({ dir: app.getPath('userData'), ports: () => (web ? [web.port, web.tlsInfo?.port] : []) });
  usb.on('status', (st) => push('usb', st));
  usb.on('connected', (d) => console.log('[usb] phone connected', d.serial, d.model));
  await startWeb();
  if (settings.usb) usb.start();
  const startupSend = pathsFromArgv(process.argv);
  if (startupSend.length) pendingSend = startupSend; // picked up by the UI via send:pending
  createWindow();
  initUpdater();
  createTray();
});

app.on('before-quit', () => { quitting = true; vcamStop(); controlOn = false; remoteInput.stop(); phoneHub?.stop(); usb?.stop(); });
app.on('will-quit', (e) => {
  if (engine || web) {
    e.preventDefault();
    const eng = engine, w = web;
    engine = null; web = null;
    Promise.allSettled([eng?.stop(), w?.stop()]).finally(() => app.exit(0));
  }
});
app.on('window-all-closed', () => { /* keep running in tray */ });
