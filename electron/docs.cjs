// "Print on PC" and "Scan to PC": a phone sends PDFs or photos, a window on the PC shows the pages,
// and the PC user prints them on any printer this PC can use (USB or network) or saves a PDF.
// The window (src/docs.jsx) turns every file into page pictures; this file prints / saves them.
const { BrowserWindow, ipcMain, dialog, shell, app } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PAPER = { A4: [210, 297], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif' };
const typeOf = (name) => TYPES[path.extname(name).toLowerCase()] || 'image/jpeg';

function setupDocs({ preload, iconPath, colors, load }) {
  const docs = new Map(); // id -> { purpose, from, dir, files, win }

  function open(d) {
    // More scans from the same phone go into its open scan window.
    if (d.purpose === 'scan') {
      for (const [id, x] of docs) {
        if (x.purpose === 'scan' && x.from.id === d.from.id && x.win && !x.win.isDestroyed()) {
          const base = x.files.length;
          x.files.push(...d.files);
          x.extraDirs.push(d.dir);
          x.win.webContents.send('docs-added', { id, from: base });
          if (x.win.isMinimized()) x.win.restore();
          x.win.show(); x.win.focus();
          return;
        }
      }
    }
    const c = colors();
    const w = new BrowserWindow({
      width: 1080, height: 760, minWidth: 640, minHeight: 480, show: false,
      backgroundColor: c.bg, title: `${d.purpose === 'scan' ? 'Scan' : 'Print'} from ${d.from.name} · DropWave`, icon: iconPath(),
      titleBarStyle: 'hidden', titleBarOverlay: { color: c.bar, symbolColor: c.symbol, height: 40 },
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    docs.set(d.id, { ...d, extraDirs: [], win: w });
    load(w, `docs=${encodeURIComponent(d.id)}`);
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.once('ready-to-show', () => { w.show(); w.focus(); });
    w.on('closed', () => {
      const x = docs.get(d.id);
      docs.delete(d.id);
      for (const dir of [d.dir, ...(x?.extraDirs || [])]) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    });
  }

  const get = (id) => { const d = docs.get(String(id)); if (!d) throw new Error('This document is no longer open'); return d; };

  ipcMain.handle('docs:info', (_e, id) => {
    const d = get(id);
    return { purpose: d.purpose, from: d.from, files: d.files.map((f) => ({ name: f.name, size: f.size, type: typeOf(f.name) })) };
  });
  ipcMain.handle('docs:file', (_e, id, i) => {
    const f = get(id).files[Number(i)];
    if (!f) throw new Error('No such file');
    return fsp.readFile(f.path);
  });
  ipcMain.handle('docs:printers', async (e) => {
    const list = await e.sender.getPrintersAsync().catch(() => []);
    return list.map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: !!p.isDefault, status: p.status }));
  });

  // Pages arrive as JPEG/PNG bytes; lay them out one per sheet in a hidden window.
  async function sheetWindow(d, pages, paper, landscape) {
    const [pw, ph] = PAPER[paper] || PAPER.A4;
    const [W, H] = landscape ? [ph, pw] : [pw, ph];
    const out = path.join(d.dir, `out-${Date.now()}`);
    await fsp.mkdir(out, { recursive: true });
    const names = [];
    for (let k = 0; k < pages.length; k++) {
      const buf = Buffer.from(pages[k].data);
      const name = `p${k + 1}.${pages[k].type === 'image/png' ? 'png' : 'jpg'}`;
      await fsp.writeFile(path.join(out, name), buf);
      names.push(name);
    }
    const html = `<!doctype html><meta charset="utf-8"><style>
@page { size: ${W}mm ${H}mm; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.s { width: ${W}mm; height: ${H}mm; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page }
.s:last-child { break-after: auto }
img { max-width: ${W - 8}mm; max-height: ${H - 8}mm; object-fit: contain }
</style>${names.map((n) => `<div class="s"><img src="${n}"></div>`).join('')}`;
    await fsp.writeFile(path.join(out, 'sheets.html'), html);
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    await w.loadFile(path.join(out, 'sheets.html'));
    return { w, out, size: { width: W * 1000, height: H * 1000 } };
  }

  ipcMain.handle('docs:print', async (_e, id, o) => {
    const d = get(id);
    if (!o?.pages?.length) throw new Error('Nothing to print');
    const { w, out, size } = await sheetWindow(d, o.pages, o.paper, !!o.landscape);
    try {
      return await new Promise((resolve) => {
        w.webContents.print({
          silent: true, printBackground: true, deviceName: String(o.printer || ''),
          copies: Math.max(1, Math.min(99, Number(o.copies) || 1)), color: o.color !== false,
          landscape: false, pageSize: size, margins: { marginType: 'none' },
          duplexMode: o.duplex ? 'longEdge' : 'simplex',
        }, (ok, why) => resolve(ok ? { ok: true } : { ok: false, error: why || 'The printer didn’t take the job' }));
      });
    } finally {
      setTimeout(() => { try { w.destroy(); } catch {} fsp.rm(out, { recursive: true, force: true }).catch(() => {}); }, 3000);
    }
  });

  ipcMain.handle('docs:pdf', async (e, id, o) => {
    const d = get(id);
    if (!o?.pages?.length) throw new Error('Nothing to save');
    const n = new Date(), two = (x) => String(x).padStart(2, '0');
    const stamp = `${n.getFullYear()}-${two(n.getMonth() + 1)}-${two(n.getDate())} ${two(n.getHours())}.${two(n.getMinutes())}`;
    const dir = path.join(app.getPath('documents'), 'DropWave Scans');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const base = String(o.name || '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || `${d.purpose === 'scan' ? 'Scan' : 'Document'} ${stamp}`;
    // Automated tests (dev profile only) save without the dialog.
    const testDir = process.env.DROPWAVE_PROFILE && process.env.DROPWAVE_DOCS_TEST_DIR;
    const r = testDir ? { canceled: false, filePath: path.join(testDir, `${base}.pdf`) } : await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Save as PDF', defaultPath: path.join(dir, base.endsWith('.pdf') ? base : `${base}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const { w, out, size } = await sheetWindow(d, o.pages, o.paper, !!o.landscape);
    try {
      const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: { width: size.width / 25400, height: size.height / 25400 }, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      await fsp.writeFile(r.filePath, pdf);
      if (!testDir) shell.showItemInFolder(r.filePath);
      return { ok: true, path: r.filePath, bytes: pdf.length };
    } finally {
      try { w.destroy(); } catch {}
      fsp.rm(out, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Pages as pictures (JPG / PNG): one file for one page, else numbered files in a folder.
  ipcMain.handle('docs:images', async (e, id, o) => {
    const d = get(id);
    if (!o?.pages?.length) throw new Error('Nothing to save');
    const ext = o.ext === 'png' ? 'png' : 'jpg';
    const n = new Date(), two = (x) => String(x).padStart(2, '0');
    const stamp = `${n.getFullYear()}-${two(n.getMonth() + 1)}-${two(n.getDate())} ${two(n.getHours())}.${two(n.getMinutes())}`;
    const base = `${d.purpose === 'scan' ? 'Scan' : 'Document'} ${stamp}`;
    const dir = path.join(app.getPath('documents'), 'DropWave Scans');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const win = BrowserWindow.fromWebContents(e.sender);
    const testDir = process.env.DROPWAVE_PROFILE && process.env.DROPWAVE_DOCS_TEST_DIR;
    const files = [];
    if (o.pages.length === 1) {
      const r = testDir ? { filePath: path.join(testDir, `${base}.${ext}`) } : await dialog.showSaveDialog(win, {
        title: `Save as ${ext.toUpperCase()}`, defaultPath: path.join(dir, `${base}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      await fsp.writeFile(r.filePath, Buffer.from(o.pages[0].data));
      files.push(r.filePath);
    } else {
      const r = testDir ? { filePaths: [testDir] } : await dialog.showOpenDialog(win, {
        title: `Folder for ${o.pages.length} ${ext.toUpperCase()} pictures`, defaultPath: dir, buttonLabel: 'Save here', properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
      for (let k = 0; k < o.pages.length; k++) {
        const f = path.join(r.filePaths[0], `${base} - ${two(k + 1)}.${ext}`);
        await fsp.writeFile(f, Buffer.from(o.pages[k].data));
        files.push(f);
      }
    }
    if (!testDir) shell.showItemInFolder(files[0]);
    return { ok: true, path: files.length > 1 ? path.dirname(files[0]) : files[0], count: files.length, bytes: o.pages.reduce((a, p) => a + p.data.byteLength, 0) };
  });

  return { open };
}

module.exports = { setupDocs };
