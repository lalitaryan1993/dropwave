// Android launcher icons from the DropWave icon (run with Electron: npx electron make-icons.cjs).
//  - ic_launcher / ic_launcher_round: the rounded tile (older launchers)
//  - ic_launcher_foreground: the tile filling the 108dp adaptive-icon canvas; the launcher's
//    mask crops it to its own shape, so the tile's rounded corners never show
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const res = path.join(__dirname, 'android', 'app', 'src', 'main', 'res');
const src = path.join(__dirname, '..', 'build', 'icon-source.png');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

app.whenReady().then(() => {
  const full = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  // Square (unrounded) crop of the ChatGPT artwork for the adaptive foreground.
  const raw = nativeImage.createFromPath(src);
  const { width, height } = raw.getSize();
  const inset = Math.round(width * 0.09); // stay inside the artwork's own rounded corners
  const square = raw.crop({ x: inset, y: inset, width: width - inset * 2, height: height - inset * 2 });
  for (const [d, k] of Object.entries(densities)) {
    const dir = path.join(res, `mipmap-${d}`);
    const legacy = full.resize({ width: Math.round(48 * k), height: Math.round(48 * k), quality: 'best' }).toPNG();
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), legacy);
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), legacy);
    // The launcher shows the middle 72dp of the 108dp canvas: place the artwork there.
    const canvas = Math.round(108 * k), inner = Math.round(72 * k), off = Math.round((canvas - inner) / 2);
    const art = square.resize({ width: inner, height: inner, quality: 'best' }).toBitmap();
    const buf = Buffer.alloc(canvas * canvas * 4); // transparent BGRA
    for (let y = 0; y < inner; y++) art.copy(buf, ((y + off) * canvas + off) * 4, y * inner * 4, (y + 1) * inner * 4);
    const fg = nativeImage.createFromBitmap(buf, { width: canvas, height: canvas }).toPNG();
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), fg);
  }
  // Splash screens: DropWave icon centered on the app's dark background (replaces Capacitor's defaults).
  for (const dir of fs.readdirSync(res).filter((d) => d.startsWith('drawable'))) {
    const file = path.join(res, dir, 'splash.png');
    if (!fs.existsSync(file)) continue;
    const { width: W, height: H } = nativeImage.createFromPath(file).getSize();
    const size = Math.round(Math.min(W, H) * 0.28);
    const icon = full.resize({ width: size, height: size, quality: 'best' }).toBitmap();
    const buf = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { buf[i * 4] = 0x14; buf[i * 4 + 1] = 0x0d; buf[i * 4 + 2] = 0x0b; buf[i * 4 + 3] = 255; } // #0b0d14 (BGRA)
    const ox = Math.round((W - size) / 2), oy = Math.round((H - size) / 2);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = ((y + oy) * W + (x + ox)) * 4, a = icon[s + 3] / 255;
      for (let c = 0; c < 3; c++) buf[d + c] = Math.round(icon[s + c] * a + buf[d + c] * (1 - a));
    }
    fs.writeFileSync(file, nativeImage.createFromBitmap(buf, { width: W, height: H }).toPNG());
  }

  fs.writeFileSync(path.join(res, 'values', 'ic_launcher_background.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#6D5DFC</color>\n</resources>\n');
  console.log('android icons written');
  app.quit();
});
