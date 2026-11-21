// The PC clipboard for text, HTML and pictures. Electron 45 made the clipboard asynchronous and
// web-like (read() -> ClipboardItem[], write(ClipboardItem[]); no readImage / readHTML / writeImage);
// older Electron versions are synchronous. Everything here is async and works with both.
const { clipboard, nativeImage } = require('electron');
const electron = require('electron');

const modern = typeof clipboard.readImage !== 'function' && typeof electron.ClipboardItem === 'function';

async function readText() {
  try { const t = await clipboard.readText(); return typeof t === 'string' ? t : ''; } catch { return ''; }
}

/** { text, html, png: Buffer | null } — whatever of those the clipboard holds. */
async function read() {
  if (!modern) {
    const img = clipboard.readImage();
    return { text: clipboard.readText(), html: clipboard.readHTML(), png: img.isEmpty() ? null : img.toPNG() };
  }
  const out = { text: '', html: '', png: null };
  let items = [];
  try { items = await clipboard.read(); } catch { return out; }
  for (const it of items || []) {
    const types = it.types || [];
    try {
      if (!out.text && types.includes('text/plain')) out.text = await (await it.getType('text/plain')).text();
      if (!out.html && types.includes('text/html')) out.html = await (await it.getType('text/html')).text();
      if (!out.png && types.includes('image/png')) out.png = Buffer.from(await (await it.getType('image/png')).arrayBuffer());
    } catch {}
  }
  return out;
}

/** Put text and/or HTML and/or a PNG picture on the clipboard (together, as one copy). */
async function write({ text, html, png }) {
  if (!modern) {
    clipboard.write({ ...(text ? { text } : {}), ...(html ? { html } : {}), ...(png ? { image: nativeImage.createFromBuffer(png) } : {}) });
    return;
  }
  const parts = {};
  if (text) parts['text/plain'] = new Blob([text], { type: 'text/plain' });
  if (html) parts['text/html'] = new Blob([html], { type: 'text/html' });
  if (png) parts['image/png'] = new Blob([png], { type: 'image/png' });
  if (!Object.keys(parts).length) return;
  await clipboard.write([new electron.ClipboardItem(parts)]);
}

async function writeText(text) {
  if (!modern) { clipboard.writeText(String(text || '')); return; }
  await clipboard.writeText(String(text || ''));
}

/** A picture file (or nativeImage) onto the clipboard. */
async function writeImage(img) {
  if (!modern) { clipboard.writeImage(img); return; }
  await write({ png: img.toPNG() });
}

module.exports = { read, write, readText, writeText, writeImage, modern };
