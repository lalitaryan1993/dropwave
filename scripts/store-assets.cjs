// Makes the Microsoft Store tiles (build/appx/*.png) from build/icon.png.
// Run with Electron (it provides PNG decode/resize):  npx electron scripts/store-assets.cjs
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'build', 'appx');
const BG = [0x0b, 0x0d, 0x14]; // same dark as the installer (R, G, B)
const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));

// A W×H picture: the icon (iconSize px, centred) on a transparent or dark background.
function tile(W, H, iconSize, dark) {
  const ic = icon.resize({ width: iconSize, height: iconSize, quality: 'best' });
  const src = Buffer.from(ic.toBitmap()); // BGRA
  const out = Buffer.alloc(W * H * 4);
  if (dark) for (let i = 0; i < W * H; i++) out.set([BG[2], BG[1], BG[0], 255], i * 4);
  const ox = Math.round((W - iconSize) / 2), oy = Math.round((H - iconSize) / 2);
  for (let y = 0; y < iconSize; y++) {
    for (let x = 0; x < iconSize; x++) {
      const s = (y * iconSize + x) * 4, d = ((y + oy) * W + (x + ox)) * 4;
      const a = src[s + 3] / 255, da = out[d + 3] / 255;
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) out[d + c] = oa ? Math.round((src[s + c] * a + out[d + c] * da * (1 - a)) / oa) : 0;
      out[d + 3] = Math.round(oa * 255);
    }
  }
  return nativeImage.createFromBitmap(out, { width: W, height: H }).toPNG();
}

// name, width, height, icon size as a share of the height, dark background
const TILES = [
  ['StoreLogo', 50, 50, 1, false],
  ['Square44x44Logo', 44, 44, 1, false],
  ['SmallTile', 71, 71, 0.8, false],
  ['Square150x150Logo', 150, 150, 0.66, false],
  ['LargeTile', 310, 310, 0.6, false],
  ['Wide310x150Logo', 310, 150, 0.7, true],
];

app.whenReady().then(() => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, w, h, share, dark] of TILES) {
    for (const scale of [100, 200]) {
      const W = (w * scale) / 100, H = (h * scale) / 100;
      const file = scale === 100 ? `${name}.png` : `${name}.scale-200.png`;
      fs.writeFileSync(path.join(OUT, file), tile(W, H, Math.round(H * share), dark));
    }
  }
  console.log('Store tiles written to', OUT);
  app.quit();
});
