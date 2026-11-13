// Screenshot any page at a given device size — used for the README images.
// Options come as JSON in the SHOOT env var (Chromium would swallow some --flags):
//   SHOOT='{"url":"...","out":"x.png","w":390,"h":844,"scale":2,"ua":"...","cookie":"name=value",
//           "pre":"<js run once, then reload>","js":"<js before capture>","wait":2500}' npx electron scripts/shoot.cjs
const { app, BrowserWindow, session, nativeTheme } = require('electron');
const fs = require('node:fs');

// A dev tool must never pop up Electron's error dialog on the user's screen: log and exit.
const fail = (e) => { console.error('shoot failed:', e?.stack || e); app.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
setTimeout(() => fail(new Error('timed out after 45 s')), 45000).unref();

let args;
try { args = JSON.parse(process.env.SHOOT || '{}'); } catch (e) { fail(e); }
const W = Number(args?.w || 390), H = Number(args?.h || 844), SCALE = Number(args?.scale || 2);
app.commandLine.appendSwitch('hide-scrollbars');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  if (!args?.url || !args?.out) throw new Error('SHOOT needs "url" and "out"');
  if (args.theme) nativeTheme.themeSource = args.theme; // 'light' | 'dark'
  const ses = session.fromPartition('persist:dropwave-shoot');
  if (args.cookie) {
    const [name, ...v] = String(args.cookie).split('=');
    await ses.cookies.set({ url: new URL(args.url).origin, name, value: v.join('='), httpOnly: true });
  }
  // Shown (hidden windows stop producing frames after the page changes) but far off-screen,
  // fully transparent, unfocusable and out of the taskbar, so nothing appears on the desktop.
  const win = new BrowserWindow({
    width: 400, height: 400, x: -32000, y: -32000, show: false, frame: false,
    skipTaskbar: true, focusable: false, opacity: 0,
    transparent: !!args.transparent, backgroundColor: args.transparent ? '#00000000' : '#ffffff',
    webPreferences: { session: ses, backgroundThrottling: false },
  });
  // DevTools device emulation sets the viewport and pixel ratio independent of the
  // window (which Windows clamps to the screen size).
  win.showInactive();
  win.webContents.on('render-process-gone', (_e, d) => console.error('renderer gone:', d.reason, d.exitCode));
  win.webContents.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) console.error('navigating to', d.url); });
  // Attach after the first load: loading the page can swap the renderer process.
  if (args.ua) win.webContents.setUserAgent(String(args.ua));
  await win.loadURL(String(args.url));
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: SCALE, mobile: W < 900, screenWidth: W, screenHeight: H,
  });
  if (args.pre) await win.webContents.executeJavaScript(String(args.pre));
  // Reload so the page lays out (and runs its startup code) at the emulated size.
  await new Promise((r) => { win.webContents.once('did-finish-load', r); win.webContents.reload(); });
  await wait(Number(args.wait || 2500));
  if (args.js) { await win.webContents.executeJavaScript(String(args.js)); await wait(1000); }
  const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const buf = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(String(args.out), buf);
  console.log('saved', args.out, { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
  app.exit(0);
});
