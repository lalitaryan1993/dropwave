const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { Engine, localIPv4s, collectFiles, DEFAULT_TCP_PORT } = require('./engine.cjs');
const { WebShare, DEFAULT_WEB_PORT } = require('./webshare.cjs');

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
  settings,
  me: { id: settings.deviceId, name: settings.deviceName, ips: localIPv4s().map((i) => i.address), port: engine?.port, platform: process.platform },
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

  win.once('ready-to-show', () => { if (!START_HIDDEN) win.show(); });

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
  });
  w.on('clients', () => push('peers', allPeers()));
  w.on('transfer', handleTransfer);
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
    decide: (request) => {
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
    },
  });

  engine.on('peers', () => push('peers', allPeers()));
  engine.on('request-closed', (id) => { pendingRequests.delete(id); push('request-closed', id); });
  engine.on('log', (m) => console.log('[engine]', m));
  engine.on('transfer', handleTransfer);

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
app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  const firstRun = !fs.existsSync(dataFile('settings.json'));
  settings = load('settings.json', defaultSettings());
  // Test profiles get a distinguishable default name, but never override a name the user chose.
  if (firstRun && PROFILE) settings.deviceName = `${os.hostname()} (${PROFILE})`;
  if (firstRun) save('settings.json', settings);
  history = load('history.json', { items: [] });
  nativeTheme.themeSource = settings.theme;
  nativeTheme.on('updated', () => { applyTheme(); push('state', publicState()); });

  if (!settings.webPin) { settings.webPin = newPin(); save('settings.json', settings); }
  registerIpc();
  await startEngine();
  await startWeb();
  createWindow();
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
