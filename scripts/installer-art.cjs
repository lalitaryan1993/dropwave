// Draws the installer's pictures from HTML (run with Electron: npx electron scripts/installer-art.cjs):
//   build/installerSidebar.bmp    164x314  Welcome / Finish pages
//   build/uninstallerSidebar.bmp  164x314  uninstaller
//   build/installerHeader.bmp     150x57   the band on top of the other pages
// NSIS wants plain 24-bit BMPs, so the window's pixels are written out by hand.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'build', 'icon.png')).toString('base64');
const BG = '#0b0d14';

const base = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;overflow:hidden;background:${BG};font-family:"Segoe UI Variable Display","Segoe UI",sans-serif;color:#fff;-webkit-font-smoothing:antialiased}
`;

function sidebar(title, sub) {
  // A small globe (like the app's Nearby screen) with an orbit and two devices, under the name.
  const dots = [];
  for (let r = 1; r < 14; r++) {
    const lat = Math.PI * (r / 14 - 0.5), n = Math.round(22 * Math.cos(lat));
    for (let i = 0; i < n; i++) {
      const lon = (i / n) * Math.PI * 2 + 0.6, x = Math.cos(lat) * Math.sin(lon), z = Math.cos(lat) * Math.cos(lon), y = Math.sin(lat);
      if (z < 0) continue;
      const land = Math.sin(lon * 3 + lat * 2) + Math.cos(lon * 2 - lat * 4) > 0.35;
      dots.push(`<circle cx="${(50 + x * 46).toFixed(1)}" cy="${(50 - y * 46).toFixed(1)}" r="${land ? 1.5 : 0.9}" fill="#fff" opacity="${(land ? 0.35 + z * 0.65 : 0.12 + z * 0.15).toFixed(2)}"/>`);
    }
  }
  return `<style>${base}
    body{background:radial-gradient(120% 70% at 50% 100%, #3b2a8a 0%, #1a1640 38%, ${BG} 72%)}
    .top{position:absolute;top:26px;left:0;right:0;text-align:center}
    .top img{width:52px;height:52px;border-radius:14px;box-shadow:0 10px 28px -8px rgba(109,93,252,.8)}
    .name{margin-top:10px;font-size:22px;font-weight:700;letter-spacing:-.3px}
    .sub{margin:5px 14px 0;font-size:11.5px;line-height:1.35;color:#b8bdd6}
    .stage{position:absolute;left:0;right:0;bottom:0;height:150px}
    .glow{position:absolute;left:50%;top:58%;width:170px;height:170px;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle,rgba(139,125,255,.55),transparent 65%)}
    .globe{position:absolute;left:50%;top:58%;width:84px;height:84px;transform:translate(-50%,-50%);border-radius:50%;overflow:hidden;
      background:radial-gradient(circle at 34% 30%, #b9f1ff 0%, #2cc8ea 20%, #8b7dff 60%, #3a2f8a 100%);box-shadow:inset -8px -10px 20px rgba(0,0,0,.35)}
    .shine{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 30% 24%,rgba(255,255,255,.45),transparent 32%)}
    svg.orbit{position:absolute;left:0;top:0;width:164px;height:150px}
    .dev{position:absolute;width:20px;height:20px;border-radius:50%;box-shadow:0 4px 10px -3px rgba(0,0,0,.6),inset 0 0 0 1px rgba(255,255,255,.3)}
  </style>
  <div class="top"><img src="${icon}"><div class="name">${title}</div><div class="sub">${sub}</div></div>
  <div class="stage">
    <div class="glow"></div>
    <svg class="orbit" viewBox="0 0 164 150"><ellipse cx="82" cy="87" rx="70" ry="26" fill="none" stroke="rgba(255,255,255,.28)" stroke-dasharray="2 5"/></svg>
    <div class="globe"><svg viewBox="0 0 100 100" width="84" height="84">${dots.join('')}</svg><div class="shine"></div></div>
    <svg class="orbit" viewBox="0 0 164 150"><path d="M12 87 A70 26 0 0 0 152 87" fill="none" stroke="rgba(255,255,255,.4)" stroke-dasharray="2 5"/></svg>
    <div class="dev" style="left:18px;top:92px;background:radial-gradient(circle at 32% 28%,#ffb3c7,#ff5d8f 45%,#b0245a)"></div>
    <div class="dev" style="left:128px;top:70px;width:16px;height:16px;opacity:.8;background:radial-gradient(circle at 32% 28%,#b7ffd9,#3ddc97 45%,#16805a)"></div>
  </div>`;
}

const header = `<style>${base}
  body{background:linear-gradient(90deg, ${BG} 0%, #1a1640 100%);display:flex;align-items:center;justify-content:flex-end;gap:7px;padding-right:10px}
  img{width:30px;height:30px;border-radius:9px;box-shadow:0 6px 16px -6px rgba(109,93,252,.9)}
  b{font-size:16px;font-weight:700;letter-spacing:-.2px}
</style><b>DropWave</b><img src="${icon}">`;

// 24-bit bottom-up BMP from a BGRA bitmap.
function bmp(bgra, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * h, 34); b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; b[o + x * 3] = bgra[i]; b[o + x * 3 + 1] = bgra[i + 1]; b[o + x * 3 + 2] = bgra[i + 2]; }
  }
  return b;
}

async function render(html, w, h, out) {
  const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true, frame: false, webPreferences: { offscreen: true, zoomFactor: 1 } });
  const tmp = path.join(app.getPath('temp'), `dw-installer-art-${w}x${h}-${Date.now()}.html`);
  fs.writeFileSync(tmp, '<!doctype html><meta charset="utf-8">' + html);
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 400));
  const img = (await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h })).resize({ width: w, height: h, quality: 'best' });
  fs.writeFileSync(out, bmp(img.toBitmap(), w, h));
  fs.writeFileSync(out.replace(/\.bmp$/, '.preview.png'), img.toPNG()); // to look at; not used by the installer
  win.destroy();
  fs.rmSync(tmp, { force: true });
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // one picture at a time: don't quit between them
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const b = path.join(root, 'build');
  await render(sidebar('DropWave', 'Your phone, on your PC.<br>Files to every PC, phone and TV.'), 164, 314, path.join(b, 'installerSidebar.bmp'));
  await render(sidebar('DropWave', 'Thanks for trying DropWave.<br>Your files stay where they are.'), 164, 314, path.join(b, 'uninstallerSidebar.bmp'));
  await render(header, 150, 57, path.join(b, 'installerHeader.bmp'));
  console.log('installer art written to build/');
  app.quit();
});
