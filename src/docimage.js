// Page pictures for "Print on PC" / "Scan to PC": open PDFs and photos as pages, find a document's
// corners in a photo, straighten it (perspective warp), and clean it up (auto / grey / black & white).
// Plain canvas code: no libraries besides pdf.js, nothing leaves this PC.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_SIDE = 2600; // ~300 dpi on A4: sharp on paper, light enough to print fast

export const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

/** File bytes -> list of source canvases (one per PDF page, one for a photo). */
export async function openPages(bytes, type, name = '') {
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const v1 = page.getViewport({ scale: 1 });
      const scale = Math.min(4, MAX_SIDE / Math.max(v1.width, v1.height));
      const vp = page.getViewport({ scale });
      const c = canvasOf(vp.width, vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push(c);
      page.cleanup();
    }
    doc.destroy();
    return out;
  }
  const bmp = await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: 'from-image' });
  const k = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
  const c = canvasOf(bmp.width * k, bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return [c];
}

const DEFAULT_QUAD = [[0.03, 0.03], [0.97, 0.03], [0.97, 0.97], [0.03, 0.97]];
export const fullQuad = () => [[0, 0], [1, 0], [1, 1], [0, 1]];

const area = (q) => Math.abs(q.reduce((s, p, i) => { const r = q[(i + 1) % 4]; return s + p[0] * r[1] - r[0] * p[1]; }, 0)) / 2;
function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z === 0) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

/**
 * Where is the sheet of paper? Works for the usual case: a light page on a darker table.
 * Otsu threshold on a small blurred copy, the largest light blob, its four extreme corners.
 * Returns corners as fractions [TL, TR, BR, BL], or a slightly inset frame if nothing convincing.
 */
export function detectQuad(src) {
  const W = 360, k = W / Math.max(src.width, src.height);
  const w = Math.max(8, Math.round(src.width * k)), h = Math.max(8, Math.round(src.height * k));
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  // Two clues for "this is the page":
  //  1. paper-ness: bright AND colourless (white paper vs a beige, wooden or grey table);
  //  2. ink: text, lines and tables make many edges; a table top has few.
  const paper = new Float32Array(n), lum = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    paper[j] = Math.max(0, mn - 0.8 * (mx - mn));
    lum[j] = (r * 77 + g * 150 + b * 29) / 256;
  }
  const edge = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    const gx = lum[p + 1 - w] + 2 * lum[p + 1] + lum[p + 1 + w] - lum[p - 1 - w] - 2 * lum[p - 1] - lum[p - 1 + w];
    const gy = lum[p - 1 + w] + 2 * lum[p + w] + lum[p + 1 + w] - lum[p - 1 - w] - 2 * lum[p - w] - lum[p + 1 - w];
    edge[p] = Math.hypot(gx, gy);
  }
  const R = Math.max(3, Math.round(w / 45));
  const maps = [boxBlur(paper, w, h, 2), boxBlur(edge, w, h, R)];

  const lab = new Int32Array(n);
  const stack = new Int32Array(n);
  // Largest blob above thr: its four extreme corners, and how well it fills that quad.
  function blobAt(m, thr) {
    lab.fill(-1);
    let bestId = -1, bestN = 0, id = 0;
    for (let s = 0; s < n; s++) {
      if (m[s] <= thr || lab[s] !== -1) continue;
      let sp = 0, cnt = 0; stack[sp++] = s; lab[s] = id;
      while (sp) {
        const p = stack[--sp]; cnt++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && lab[p - 1] === -1 && m[p - 1] > thr) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && lab[p + 1] === -1 && m[p + 1] > thr) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && lab[p - w] === -1 && m[p - w] > thr) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && lab[p + w] === -1 && m[p + w] > thr) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      if (cnt > bestN) { bestN = cnt; bestId = id; }
      id++;
    }
    if (bestId < 0) return null;
    let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
    for (let p = 0; p < n; p++) {
      if (lab[p] !== bestId) continue;
      const x = p % w, y = (p / w) | 0;
      if (x + y < tl[2]) tl = [x, y, x + y];
      if (x + y > br[2]) br = [x, y, x + y];
      if (x - y > tr[2]) tr = [x, y, x - y];
      if (x - y < bl[2]) bl = [x, y, x - y];
    }
    const q = [tl, tr, br, bl].map(([x, y]) => [Math.min(1, Math.max(0, x / (w - 1))), Math.min(1, Math.max(0, y / (h - 1)))]);
    const qa = area(q) * n;
    return { q, frac: bestN / n, fill: qa > 0 ? bestN / qa : 0 };
  }
  // Try a range of thresholds on both clues; keep the blob that looks most like a sheet of paper:
  // fills its quad (straight edges), a sensible size, not running off the photo.
  let best = null, bestScore = 0;
  const dbg = typeof window !== 'undefined' ? window.__dqAll : null;
  maps.forEach((m, mi) => {
    const sorted = Float32Array.from(m).sort();
    const seen = new Set();
    for (const pc of [0.3, 0.4, 0.5, 0.58, 0.65, 0.72, 0.78, 0.84, 0.89, 0.93, 0.96]) {
      const thr = sorted[Math.floor(pc * (n - 1))];
      if (seen.has(thr)) continue;
      seen.add(thr);
      const b = blobAt(m, thr);
      if (!b || b.frac < 0.04 || b.frac > 0.92 || !convex(b.q)) continue;
      const touches = b.q.filter(([x, y]) => x < 0.03 || y < 0.03 || x > 0.97 || y > 0.97).length;
      const score = Math.pow(Math.min(1, b.fill), 6) * Math.sqrt(b.frac) * (touches >= 2 ? 0.15 : touches ? 0.35 : 1);
      dbg?.push({ map: mi ? 'ink' : 'paper', pc, frac: +b.frac.toFixed(3), fill: +b.fill.toFixed(2), touches, score: +score.toFixed(3), q: b.q.map((p) => p.map((v) => +v.toFixed(2))) });
      if (b.fill > 0.72 && score > bestScore) { bestScore = score; best = b.q; }
    }
  });
  return best || DEFAULT_QUAD.map((p) => [...p]);
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0; const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / (2 * r + 1);
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Unit square -> quad (Heckbert). Returns a function (u, v) -> [x, y]. */
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return (u, v) => { const z = g * u + h * v + 1; return [(a * u + b * v + c) / z, (d * u + e * v + f) / z]; };
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Cut the quad out of the source and make it a flat rectangle. */
export function warp(src, quadFrac) {
  const W = src.width, H = src.height;
  const q = quadFrac.map(([x, y]) => [x * (W - 1), y * (H - 1)]);
  const full = quadFrac.every(([x, y], i) => Math.abs(x - [0, 1, 1, 0][i]) < 1e-6 && Math.abs(y - [0, 0, 1, 1][i]) < 1e-6);
  if (full) { const c = canvasOf(W, H); c.getContext('2d').drawImage(src, 0, 0); return c; }
  let ow = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), oh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1, MAX_SIDE / Math.max(ow, oh));
  ow = Math.max(8, Math.round(ow * k)); oh = Math.max(8, Math.round(oh * k));
  const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const out = canvasOf(ow, oh);
  const octx = out.getContext('2d');
  const od = octx.createImageData(ow, oh);
  const o = od.data;
  const map = squareToQuad(q);
  for (let y = 0; y < oh; y++) {
    const v = y / (oh - 1);
    for (let x = 0; x < ow; x++) {
      let [sx, sy] = map(x / (ow - 1), v);
      if (sx < 0) sx = 0; else if (sx > W - 1.001) sx = W - 1.001;
      if (sy < 0) sy = 0; else if (sy > H - 1.001) sy = H - 1.001;
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
      const i00 = (iy * W + ix) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      const oi = (y * ow + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
        const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
        o[oi + ch] = top + (bot - top) * fy;
      }
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

export function rotate(src, deg) {
  const r = ((deg % 360) + 360) % 360;
  if (!r) return src;
  const c = r === 180 ? canvasOf(src.width, src.height) : canvasOf(src.height, src.width);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** 'original' | 'magic' (no shadows, white paper) | 'auto' (brighter paper, darker ink) | 'gray' | 'bw' (crisp black on white). */
export function applyFilter(src, mode) {
  if (!mode || mode === 'original') return src;
  const w = src.width, h = src.height;
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < n; i += 4, j++) { const v = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; lum[j] = v; hist[v]++; }
  const pct = (p) => { let acc = 0; const target = n * p; for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= target) return t; } return 255; };
  if (mode === 'magic') {
    magic(d, w, h);
  } else if (mode === 'bw') {
    // Bradley adaptive threshold: each pixel against the mean of its neighbourhood (handles shadows).
    const S = Math.max(15, Math.round(Math.max(w, h) / 40)), half = S >> 1, T = 0.13;
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += lum[y * w + x]; integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row; }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
        const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
        const s = integ[(y1 + 1) * (w + 1) + x1 + 1] - integ[y0 * (w + 1) + x1 + 1] - integ[(y1 + 1) * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
        const v = lum[y * w + x] * cnt <= s * (1 - T) ? 0 : 255;
        const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
  } else {
    const lo = pct(0.02), hi = Math.max(lo + 30, pct(mode === 'auto' ? 0.9 : 0.98));
    const lut = new Uint8ClampedArray(256);
    for (let t = 0; t < 256; t++) { const x = (t - lo) / (hi - lo); lut[t] = Math.max(0, Math.min(255, 255 * Math.pow(Math.max(0, x), mode === 'auto' ? 1.15 : 1))); }
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      if (mode === 'gray') { d[i] = d[i + 1] = d[i + 2] = lut[lum[j]]; continue; }
      // auto: stretch each channel the same way so paper turns white and colours stay.
      d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export const toBytes = (canvas, type = 'image/jpeg', q = 0.9) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('Couldn’t make the page picture'))), type, q));

/** Rotate by any angle (straighten a slightly tilted page); the corners that open up are white. */
export function straighten(src, deg) {
  if (!deg) return src;
  const r = (deg * Math.PI) / 180, cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
  const c = canvasOf(src.width * cos + src.height * sin, src.width * sin + src.height * cos);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(r);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Brightness / contrast (-100..100) and sharpness (0..100, unsharp mask). */
export function adjust(src, a) {
  const b = a?.b || 0, k = a?.c || 0, s = a?.s || 0;
  if (!b && !k && !s) return src;
  const w = src.width, h = src.height;
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  if (s) {
    const o = new Uint8ClampedArray(d);
    const amt = s / 60;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const blur = (o[i + ch - 4] + o[i + ch + 4] + o[i + ch - w * 4] + o[i + ch + w * 4]) / 4;
        d[i + ch] = o[i + ch] + amt * (o[i + ch] - blur);
      }
    }
  }
  if (b || k) {
    const f = (259 * (k * 1.275 + 255)) / (255 * (259 - k * 1.275)); // contrast factor
    const lut = new Uint8ClampedArray(256);
    for (let t = 0; t < 256; t++) lut[t] = f * (t - 128) + 128 + b * 1.2;
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * "Magic": flat white paper and dark ink even with shadows and uneven light. Each pixel is divided by
 * the paper's own brightness around it (a big blur), so a shadow across the page disappears; colour stays.
 */
function magic(d, w, h) {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) lum[j] = Math.max(d[i], d[i + 1], d[i + 2]);
  // Background = local brightness of the paper: max-ish (dilate) then a large blur, on a small copy.
  const sw = Math.max(16, Math.round(w / 8)), sh = Math.max(16, Math.round(h / 8));
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let m = 0;
    const x0 = Math.floor((x * w) / sw), x1 = Math.floor(((x + 1) * w) / sw), y0 = Math.floor((y * h) / sh), y1 = Math.floor(((y + 1) * h) / sh);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx += 2) { const v = lum[yy * w + xx]; if (v > m) m = v; }
    small[y * sw + x] = m;
  }
  const bg = blurArr(blurArr(small, sw, sh, 3), sw, sh, 3);
  for (let y = 0, j = 0; y < h; y++) {
    const sy = Math.min(sh - 1, (y * sh) / h);
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++, j++) {
      const sx = Math.min(sw - 1, (x * sw) / w);
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      const v = (bg[y0 * sw + x0] * (1 - fx) + bg[y0 * sw + x1] * fx) * (1 - fy) + (bg[y1 * sw + x0] * (1 - fx) + bg[y1 * sw + x1] * fx) * fy;
      const k = 255 / Math.max(40, v);
      const i = j * 4;
      for (let ch = 0; ch < 3; ch++) {
        let t = d[i + ch] * k; // paper -> ~255
        t = 255 - (255 - Math.min(255, t)) * 1.35; // deeper ink
        d[i + ch] = t;
      }
    }
  }
}

function blurArr(a, w, h, r) {
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += a[yy * w + xx]; c++; }
    out[y * w + x] = s / c;
  }
  return out;
}

/** Pages -> PNG bytes (lossless; small for black & white pages). */
export async function encodePng(canvases) {
  const out = [];
  for (const c of canvases) out.push(await toBytes(c, 'image/png'));
  return out;
}

/** Page pictures -> JPEG bytes. size: 'best' | 'standard' | 'small' | a byte budget for all pages (portals). */
export async function encodePages(canvases, size) {
  const enc = (c, q, scale) => {
    let src = c;
    if (scale < 1) { src = canvasOf(c.width * scale, c.height * scale); const x = src.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, src.width, src.height); }
    return toBytes(src, 'image/jpeg', q);
  };
  const presets = { best: [0.92, 1], standard: [0.8, 0.78], small: [0.62, 0.55] };
  if (typeof size === 'string') {
    const [q, s] = presets[size] || presets.best;
    const out = [];
    for (const c of canvases) out.push(await enc(c, q, s));
    return out;
  }
  // A byte budget: step quality and size down until everything fits (PDF overhead ~3 KB a page).
  const budget = Math.max(20_000, size - canvases.length * 3000);
  const steps = [[0.85, 1], [0.75, 0.85], [0.65, 0.72], [0.55, 0.6], [0.5, 0.5], [0.45, 0.42], [0.4, 0.35], [0.35, 0.28], [0.3, 0.22]];
  let out = [];
  for (const [q, s] of steps) {
    out = [];
    for (const c of canvases) out.push(await enc(c, q, s));
    if (out.reduce((a, b) => a + b.length, 0) <= budget) return out;
  }
  return out;
}
