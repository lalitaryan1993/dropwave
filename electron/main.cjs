const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, nativeTheme, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { Engine, localIPv4s, collectFiles, DEFAULT_TCP_PORT } = require('./engine.cjs');
const { WebShare, DEFAULT_WEB_PORT } = require('./webshare.cjs');
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
    platform: process.platform, fingerprint: engine?.fingerprint,
  },
  web: webInfo(),
  peers: allPeers(),
  transfers: [...active.values()],
  history: history.items,
  pending: [...pendingRequests.values()].map((p) => p.request),
  version: app.getVersion(),
});

const push = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

// ---- window ----
function themeColors() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? { bg: '#0b0d14', symbol: '#e6e8f0' } : { bg: '#f5f6fa', symbol: '#1d2030' };
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
function handleText(m) {
  push('text', m);
  if (!win || !win.isVisible() || !win.isFocused()) {
    notify(`Text from ${m.from.name}`, m.text.length > 120 ? `${m.text.slice(0, 117)}…` : m.text);
  }
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
    decide: askUser,
  });
  w.on('clients', () => push('peers', allPeers()));
  w.on('transfer', handleTransfer);
  w.on('text', handleText);
  w.on('request-closed', (id) => { pendingRequests.delete(id); push('request-closed', id); });
  try {
    await w.start();
    web = w;
  } catch (e) {
    webError = e.code === 'EADDRINUSE' ? `Port ${port} is used by another program` : e.message;
  }
}

async function stopWeb() {
  if (!web) return;
  const w = web;
  web = null;
  await w.stop();
  push('peers', allPeers());
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
    const allowed = ['deviceName', 'theme', 'autoStart', 'closeToTray', 'notifications', 'autoAcceptTrusted', 'trusted', 'webEnabled'];
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
    if ('theme' in patch) applyTheme();
    if ('autoStart' in patch && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!settings.autoStart, args: ['--hidden'] });
    }
    if ('webEnabled' in patch) { if (settings.webEnabled) await startWeb(); else await stopWeb(); }
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
  ipcMain.handle('text:send', async (_e, peerId, text) => {
    const peer = findPeer(peerId);
    if (peer.web) { if (!web?.sendText(peer.id, text)) throw new Error('That device is no longer connected'); return; }
    return engine.sendText(peer, text);
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
  const firstRun = !fs.existsSync(dataFile('settings.json'));
  settings = load('settings.json', defaultSettings());
  // Test profiles get a distinguishable default name, but never override a name the user chose.
  if (firstRun && PROFILE) settings.deviceName = `${os.hostname()} (${PROFILE})`;
  // Always write back, so settings added in a newer version (e.g. the identity key) persist.
  save('settings.json', settings);
  history = load('history.json', { items: [] });
  nativeTheme.themeSource = settings.theme;
  nativeTheme.on('updated', () => { applyTheme(); push('state', publicState()); });

  if (!settings.webPin) { settings.webPin = newPin(); save('settings.json', settings); }
  registerIpc();
  await startEngine();
  await startWeb();
  const startupSend = pathsFromArgv(process.argv);
  if (startupSend.length) pendingSend = startupSend; // picked up by the UI via send:pending
  createWindow();
  initUpdater();
  createTray();
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  if (engine || web) {
    e.preventDefault();
    const eng = engine, w = web;
    engine = null; web = null;
    Promise.allSettled([eng?.stop(), w?.stop()]).finally(() => app.exit(0));
  }
});
app.on('window-all-closed', () => { /* keep running in tray */ });
