// Turns the ChatGPT artwork in build/ into every icon the app and installer need.
// Run with Electron (it provides PNG decode/resize):  npx electron scripts/process-icons.cjs
//
//   build/icon-source.png    -> build/icon.png (512), build/icon.ico (16..256), build/tray.png (32),
//                               electron/web/icon-192.png, icon-512.png, favicon.png (phone page)
//   build/banner-source.png  -> build/installerSidebar.bmp (164x314), if present
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const B = (...p) => path.join(__dirname, '..', 'build', ...p);
const P = (...p) => path.join(__dirname, '..', 'electron', 'web', ...p);

function bitmapOf(img) {
  const { width, height } = img.getSize();
  return { width, height, data: Buffer.from(img.toBitmap()) }; // BGRA
}

// Bounding box of the colourful tile (skip the light/white canvas around it).
function tileBounds({ width, height, data }) {
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const b = data[i], g = data[i + 1], r = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  // Make it square around the centre.
  const size = Math.max(x1 - x0, y1 - y0) + 1;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), width: size, height: size };
}

// Apply a smooth rounded-square alpha mask (superellipse-ish via rounded rect, 4x AA).
function maskRounded(img, radiusRatio = 0.235, inset = 0.022) {
  const bm = bitmapOf(img);
  const { width: S, data } = bm;
  const m = S * inset, r = S * radiusRatio, SS = 4;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        const cx = Math.min(Math.max(px, m + r), S - m - r);
        const cy = Math.min(Math.max(py, m + r), S - m - r);
        if (px >= m && px <= S - m && py >= m && py <= S - m && (px - cx) ** 2 + (py - cy) ** 2 <= r * r) hit++;
      }
      const i = (y * S + x) * 4;
      const a = hit / (SS * SS);
      // Bitmap is premultiplied-free BGRA from toBitmap; scale alpha only.
      data[i + 3] = Math.round(data[i + 3] * a);
      if (a < 1) { data[i] = Math.round(data[i] * a); data[i + 1] = Math.round(data[i + 1] * a); data[i + 2] = Math.round(data[i + 2] * a); }
    }
  }
  return nativeImage.createFromBitmap(data, { width: S, height: S });
}

const sized = (img, s) => img.resize({ width: s, height: s, quality: 'best' });

function writeIco(img, file) {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = sizes.map((s) => sized(img, s).toPNG());
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, k) => {
    const e = k * 16;
    dir[e] = s >= 256 ? 0 : s; dir[e + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(pngs[k].length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += pngs[k].length;
  });
  fs.writeFileSync(file, Buffer.concat([header, dir, ...pngs]));
}

// 24-bit bottom-up BMP, as NSIS expects for the wizard sidebar.
function writeBmp(img, file) {
  const { width: w, height: h, data } = bitmapOf(img);
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = 54 + (h - 1 - y) * row + x * 3;
      buf[d] = data[s]; buf[d + 1] = data[s + 1]; buf[d + 2] = data[s + 2];
    }
  }
  fs.writeFileSync(file, buf);
}

app.whenReady().then(() => {
  const src = nativeImage.createFromPath(B('icon-source.png'));
  if (src.isEmpty()) throw new Error('build/icon-source.png missing');
  const tile = sized(src.crop(tileBounds(bitmapOf(src))), 1024);
  const icon = maskRounded(tile);

  fs.writeFileSync(B('icon.png'), sized(icon, 512).toPNG());
  writeIco(icon, B('icon.ico'));
  fs.writeFileSync(B('tray.png'), sized(icon, 32).toPNG());
  fs.mkdirSync(P(), { recursive: true });
  fs.writeFileSync(P('icon-192.png'), sized(icon, 192).toPNG());
  fs.writeFileSync(P('icon-512.png'), sized(icon, 512).toPNG());
  fs.writeFileSync(P('favicon.png'), sized(icon, 64).toPNG());
  console.log('icons written');

  const bannerSrc = B('banner-source.png');
  if (fs.existsSync(bannerSrc)) {
    const b = nativeImage.createFromPath(bannerSrc);
    const { width, height } = b.getSize();
    const ratio = 164 / 314;
    const cw = Math.min(width, Math.round(height * ratio));
    const ch = Math.round(cw / ratio);
    const crop = b.crop({ x: Math.round((width - cw) / 2), y: Math.round((height - ch) / 2), width: cw, height: ch });
    writeBmp(crop.resize({ width: 164, height: 314, quality: 'best' }), B('installerSidebar.bmp'));
    console.log('installer sidebar written');
  }
  app.quit();
});
