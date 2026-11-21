// "Print on PC" / "Scan to PC" window: the pages a phone sent, ready to print on any printer this PC
// can use (USB or network) or to save as a PDF. Scans get their corners found and straightened.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Printer, FileDown, RotateCw, Trash2, Crop, Check, ChevronUp, ChevronDown, Loader2, ScanLine, Wand2, SlidersHorizontal, Copy } from 'lucide-react';
import { api } from './lib.js';
import { Button } from './components.jsx';
import { openPages, detectQuad, fullQuad, warp, rotate, applyFilter, toBytes, canvasOf, straighten, adjust, encodePages, encodePng } from './docimage.js';

const load = (k, d) => { try { const v = localStorage.getItem(`dw_docs_${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(`dw_docs_${k}`, JSON.stringify(v)); } catch {} };

const FILTERS = [['magic', 'Magic'], ['auto', 'Auto'], ['original', 'Original'], ['gray', 'Grey'], ['bw', 'B & W']];
// PDF size: quality presets, or "under N" for portals with an upload limit (Aadhaar, exams, banks).
const SIZES = [['best', 'Best quality'], ['standard', 'Standard'], ['small', 'Small'], [200_000, 'Under 200 KB'], [500_000, 'Under 500 KB'], [1_000_000, 'Under 1 MB'], [2_000_000, 'Under 2 MB']];
const NO_ADJ = { b: 0, c: 0, s: 0 };
let seq = 0;

// Final picture of a page: cut out, rotated, straightened, cleaned up, adjusted. Cached per page
// version; the slow cut-out (warp) is cached by corners, so sliders only redo the cheap steps.
const cache = new WeakMap(), warps = new WeakMap();
function rendered(p) {
  const hit = cache.get(p);
  if (hit) return hit;
  let flat = warps.get(p.quad);
  if (!flat || flat.src !== p.src) { flat = { src: p.src, c: warp(p.src, p.quad) }; warps.set(p.quad, flat); }
  const c = adjust(applyFilter(straighten(rotate(flat.c, p.rot), p.angle || 0), p.filter), p.adj || NO_ADJ);
  cache.set(p, c);
  return c;
}

function thumbOf(canvas, max = 220) {
  const k = max / Math.max(canvas.width, canvas.height);
  const t = canvasOf(canvas.width * k, canvas.height * k);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.8);
}

export function DocsApp() {
  const id = new URLSearchParams(location.hash.slice(1)).get('docs');
  const [info, setInfo] = useState(null);
  const [pages, setPages] = useState([]); // { key, src, quad, rot, filter, name }
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [crop, setCrop] = useState(false);
  const [printers, setPrinters] = useState([]);
  const [opt, setOpt] = useState(() => ({ printer: load('printer', ''), copies: 1, color: load('color', true), paper: load('paper', 'A4'), duplex: false }));
  const [busy, setBusy] = useState('');
  const [size, setSize] = useState(() => load('size', 'best'));
  const [fmt, setFmt] = useState(() => load('fmt', 'pdf')); // pdf | jpg | png
  const [msg, setMsg] = useState(null); // { ok, text }
  const loaded = useRef(0);

  // Theme like the main window.
  useEffect(() => {
    api.getState?.().then((s) => {
      const t = s?.settings?.theme;
      const mq = matchMedia('(prefers-color-scheme: dark)');
      document.documentElement.classList.toggle('dark', t === 'dark' || (t !== 'light' && mq.matches));
      document.documentElement.dataset.style = s?.settings?.style || 'aurora';
    }).catch(() => {});
  }, []);

  async function loadFrom(start, inf) {
    const scan = inf.purpose === 'scan';
    const out = [];
    for (let i = start; i < inf.files.length; i++) {
      const f = inf.files[i];
      try {
        const bytes = await api.docsFile(id, i);
        const srcs = await openPages(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), f.type, f.name);
        srcs.forEach((src, k) => out.push({
          key: ++seq, src, name: srcs.length > 1 ? `${f.name} · page ${k + 1}` : f.name, rot: 0,
          // docscan-*: Google's scanner on the phone already cropped and cleaned the page.
          quad: scan && f.type !== 'application/pdf' && !f.name.startsWith('docscan-') ? detectQuad(src) : fullQuad(),
          filter: scan && !f.name.startsWith('docscan-') ? load('filter', 'magic') : 'original', adj: NO_ADJ, angle: 0,
        }));
      } catch (e) {
        setError(`Couldn’t open ${f.name}${/heic|heif/i.test(f.type) ? ' (HEIC photos aren’t supported yet; send it as JPEG)' : ''}`);
      }
    }
    loaded.current = inf.files.length;
    return out;
  }

  useEffect(() => {
    (async () => {
      try {
        const inf = await api.docsInfo(id);
        setInfo(inf);
        document.title = `${inf.purpose === 'scan' ? 'Scan' : 'Print'} from ${inf.from.name} · DropWave`;
        const ps = await loadFrom(0, inf);
        setPages(ps);
      } catch (e) { setError(String(e.message || e)); }
      setLoading(false);
    })();
    api.docsPrinters().then((list) => {
      setPrinters(list);
      // Saved choice, else Windows' default, but a real printer before OneNote / Print to PDF / Fax.
      const virtual = (p) => /onenote|pdf|xps|fax|send to/i.test(p.name);
      setOpt((o) => (list.some((p) => p.name === o.printer) ? o : { ...o, printer: (list.find((p) => p.isDefault && !virtual(p)) || list.find((p) => !virtual(p)) || list.find((p) => p.isDefault) || list[0])?.name || '' }));
    });
    // More pages scanned on the phone while this window is open.
    return api.onDocsAdded?.(async (d) => {
      if (d.id !== id) return;
      const inf = await api.docsInfo(id);
      setInfo(inf);
      const more = await loadFrom(loaded.current, inf);
      setPages((ps) => { setSel(ps.length); return [...ps, ...more]; });
    });
  }, [id]);

  const scan = info?.purpose === 'scan';
  const page = pages[sel];
  const update = (k, patch) => setPages((ps) => ps.map((p, i) => (i === k ? { ...p, ...patch } : p)));
  const move = (k, dir) => setPages((ps) => { const a = [...ps]; const j = k + dir; if (j < 0 || j >= a.length) return ps; [a[k], a[j]] = [a[j], a[k]]; setSel(j); return a; });
  const remove = (k) => setPages((ps) => { const a = ps.filter((_, i) => i !== k); setSel((s) => Math.max(0, Math.min(s, a.length - 1))); return a; });
  const setAllFilter = (f) => { save('filter', f); setPages((ps) => ps.map((p) => ({ ...p, filter: f }))); };
  const setO = (patch) => { setOpt((o) => { const n = { ...o, ...patch }; save('printer', n.printer); save('color', n.color); save('paper', n.paper); return n; }); };

  async function finalPages(sz = 'best', kind = 'jpg') {
    const cs = [];
    for (const p of pages) {
      await new Promise((r) => setTimeout(r)); // keep the window responsive between pages
      let c = rendered(p);
      if (!opt.color) c = applyFilter(c, p.filter === 'bw' ? 'original' : 'gray');
      cs.push(c);
    }
    if (kind === 'png') return (await encodePng(cs)).map((data) => ({ type: 'image/png', data }));
    // A size limit is per picture when saving pictures (portals check each upload), for the whole PDF otherwise.
    if (kind === 'jpg-each' && typeof sz === 'number') { const out = []; for (const c of cs) out.push(...(await encodePages([c], sz))); return out.map((data) => ({ type: 'image/jpeg', data })); }
    return (await encodePages(cs, sz)).map((data) => ({ type: 'image/jpeg', data }));
  }

  async function doPrint() {
    setBusy('print'); setMsg(null);
    try {
      const r = await api.docsPrint(id, { ...opt, pages: await finalPages() });
      setMsg(r.ok ? { ok: true, text: `Sent ${pages.length} page${pages.length > 1 ? 's' : ''} to ${printers.find((p) => p.name === opt.printer)?.label || 'the printer'}.` } : { ok: false, text: r.error });
    } catch (e) { setMsg({ ok: false, text: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
    setBusy('');
  }
  async function doPdf() {
    setBusy('pdf'); setMsg(null);
    try {
      const r = fmt === 'pdf'
        ? await api.docsPdf(id, { paper: opt.paper, pages: await finalPages(size) })
        : await api.docsImages(id, { ext: fmt, pages: await finalPages(size, fmt === 'png' ? 'png' : 'jpg-each') });
      if (r.ok) setMsg({ ok: true, text: `Saved (${r.bytes >= 1e6 ? `${(r.bytes / 1e6).toFixed(1)} MB` : `${Math.round(r.bytes / 1000)} KB`}): ${r.path}` });
    } catch (e) { setMsg({ ok: false, text: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
    setBusy('');
  }

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <div className="drag flex h-10 shrink-0 items-center gap-2 px-4 text-[13px] font-semibold">
        {scan ? <ScanLine className="h-4 w-4 text-accent" /> : <Printer className="h-4 w-4 text-accent" />}
        {info ? `${scan ? 'Scan' : 'Print'} from ${info.from.name}` : 'DropWave'}
        {pages.length > 0 && <span className="font-normal text-muted">· {pages.length} page{pages.length > 1 ? 's' : ''}</span>}
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted"><Loader2 className="h-5 w-5 animate-spin" /> Opening…</div>
      ) : !pages.length ? (
        <div className="flex flex-1 items-center justify-center text-bad">{error || 'Nothing to show'}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* pages */}
          <div className="w-44 shrink-0 space-y-2 overflow-y-auto border-r border-line p-3">
            {pages.map((p, k) => <Thumb key={p.key} p={p} k={k} on={k === sel} onPick={() => { setSel(k); setCrop(false); }} />)}
          </div>
          {/* page */}
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="flex flex-1 items-center justify-center overflow-hidden p-5">
              {page && (crop ? <CropView p={page} onQuad={(q) => update(sel, { quad: q })} /> : <PageView p={page} />)}
            </div>
            {page && (
              <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-t border-line px-3 py-2">
                {scan && (crop
                  ? <>
                      <Button variant="ghost" onClick={() => update(sel, { quad: detectQuad(page.src) })}><Wand2 className="h-4 w-4" /> Find edges</Button>
                      <Button variant="ghost" onClick={() => update(sel, { quad: fullQuad() })}>Whole photo</Button>
                      <Button variant="primary" onClick={() => setCrop(false)}><Check className="h-4 w-4" /> Done</Button>
                    </>
                  : <Button variant="ghost" onClick={() => setCrop(true)}><Crop className="h-4 w-4" /> Crop</Button>)}
                {!crop && <>
                  <Button variant="ghost" onClick={() => update(sel, { rot: (page.rot + 90) % 360 })}><RotateCw className="h-4 w-4" /> Rotate</Button>
                  <Button variant="ghost" disabled={sel === 0} onClick={() => move(sel, -1)} aria-label="Move up"><ChevronUp className="h-4 w-4" /></Button>
                  <Button variant="ghost" disabled={sel === pages.length - 1} onClick={() => move(sel, 1)} aria-label="Move down"><ChevronDown className="h-4 w-4" /></Button>
                  <Button variant="danger" disabled={pages.length < 2} onClick={() => remove(sel)}><Trash2 className="h-4 w-4" /> Remove</Button>
                </>}
              </div>
            )}
          </div>
          {/* options */}
          <div className="w-72 shrink-0 space-y-4 overflow-y-auto border-l border-line p-4 text-[13px]">
            <Field label="Look">
              <div className="grid grid-cols-5 gap-1 rounded-xl border border-line bg-bg-2/50 p-1">
                {FILTERS.map(([k, t]) => (
                  <button key={k} onClick={() => setAllFilter(k)} className={`no-drag h-8 rounded-lg text-[12px] ${page?.filter === k ? 'bg-raised font-semibold text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>{t}</button>
                ))}
              </div>
            </Field>
            {page && <Adjust p={page} onChange={(patch) => update(sel, patch)} onAll={() => setPages((ps) => ps.map((x) => ({ ...x, adj: page.adj, angle: page.angle })))} many={pages.length > 1} />}
            <Field label="Printer">
              {printers.length ? (
                <select value={opt.printer} onChange={(e) => setO({ printer: e.target.value })} className="no-drag h-9 w-full rounded-lg border border-line bg-raised px-2 outline-none focus:border-accent">
                  {printers.map((p) => <option key={p.name} value={p.name}>{p.label}{p.isDefault ? ' (default)' : ''}</option>)}
                </select>
              ) : <div className="text-muted">No printers found on this PC. Add one in Windows Settings › Bluetooth &amp; devices › Printers &amp; scanners, or save a PDF.</div>}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Copies">
                <input type="number" min={1} max={99} value={opt.copies} onChange={(e) => setO({ copies: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
                  className="no-drag h-9 w-full rounded-lg border border-line bg-raised px-2 outline-none focus:border-accent" />
              </Field>
              <Field label="Paper">
                <select value={opt.paper} onChange={(e) => setO({ paper: e.target.value })} className="no-drag h-9 w-full rounded-lg border border-line bg-raised px-2 outline-none focus:border-accent">
                  {['A4', 'Letter', 'Legal'].map((p) => <option key={p}>{p}</option>)}
                </select>
              </Field>
            </div>
            <label className="no-drag flex items-center gap-2"><input type="checkbox" checked={!opt.color} onChange={(e) => setO({ color: !e.target.checked })} /> Black &amp; white (saves ink)</label>
            <label className="no-drag flex items-center gap-2"><input type="checkbox" checked={opt.duplex} onChange={(e) => setO({ duplex: e.target.checked })} /> Both sides (if the printer can)</label>
            <div className="space-y-2 pt-1">
              <Button variant="primary" className="h-10 w-full" disabled={!!busy || !printers.length} onClick={doPrint}>
                {busy === 'print' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print {pages.length > 1 ? `${pages.length} pages` : ''}
              </Button>
              <div className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-bg-2/50 p-1">
                {[['pdf', 'PDF'], ['jpg', 'JPG'], ['png', 'PNG']].map(([k, t]) => (
                  <button key={k} onClick={() => { setFmt(k); save('fmt', k); }} className={`no-drag h-8 rounded-lg text-[12px] ${fmt === k ? 'bg-raised font-semibold text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>{t}</button>
                ))}
              </div>
              {fmt !== 'png' && (
                <select value={String(size)} onChange={(e) => { const v = /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value; setSize(v); save('size', v); }}
                  className="no-drag h-9 w-full rounded-lg border border-line bg-raised px-2 outline-none focus:border-accent" title="File size">
                  {SIZES.map(([v, t]) => <option key={v} value={String(v)}>{t}{typeof v === 'number' ? (fmt === 'pdf' ? ' (whole PDF)' : ' (each picture)') : ''}</option>)}
                </select>
              )}
              <Button variant="soft" className="h-10 w-full" disabled={!!busy} onClick={doPdf}>
                {busy === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />} Save as {fmt.toUpperCase()}{fmt !== 'pdf' && pages.length > 1 ? ` (${pages.length} pictures)` : ''}
              </Button>
            </div>
            {msg && <div className={msg.ok ? 'text-good' : 'text-bad'}>{msg.text}</div>}
            {error && <div className="text-warn">{error}</div>}
            {scan && <div className="text-[12px] text-muted">Scan more on the phone and the pages are added here.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Brightness, contrast, sharpness and straighten for the page shown. Changes apply when you let go.
function Adjust({ p, onChange, onAll, many }) {
  const adj = p.adj || NO_ADJ;
  const [v, setV] = useState({ ...adj, a: p.angle || 0 });
  const t = useRef(null);
  useEffect(() => { setV({ ...(p.adj || NO_ADJ), a: p.angle || 0 }); }, [p.key, p.adj, p.angle]);
  const set = (k, x) => {
    const n = { ...v, [k]: x };
    setV(n);
    clearTimeout(t.current);
    t.current = setTimeout(() => onChange({ adj: { b: n.b, c: n.c, s: n.s }, angle: n.a }), 220);
  };
  const row = (k, label, min, max, unit = '') => (
    <label className="no-drag block">
      <div className="flex justify-between text-[12px] text-muted"><span>{label}</span><span className="tabular-nums">{v[k] > 0 ? '+' : ''}{v[k]}{unit}</span></div>
      <input type="range" min={min} max={max} step={k === 'a' ? 0.5 : 1} value={v[k]} onChange={(e) => set(k, Number(e.target.value))} onDoubleClick={() => set(k, 0)} className="w-full accent-[var(--accent)]" />
    </label>
  );
  const changed = v.b || v.c || v.s || v.a;
  return (
    <Field label={<span className="flex items-center gap-1.5"><SlidersHorizontal className="h-3 w-3" /> Adjust this page</span>}>
      <div className="space-y-2 rounded-xl border border-line bg-bg-2/40 p-3">
        {row('b', 'Brightness', -100, 100)}
        {row('c', 'Contrast', -100, 100)}
        {row('s', 'Sharpness', 0, 100)}
        {row('a', 'Straighten', -15, 15, '°')}
        <div className="flex gap-1 pt-1">
          <Button variant="ghost" className="h-8 flex-1 text-[12px]" disabled={!changed} onClick={() => { setV({ b: 0, c: 0, s: 0, a: 0 }); onChange({ adj: NO_ADJ, angle: 0 }); }}>Reset</Button>
          {many && <Button variant="ghost" className="h-8 flex-1 text-[12px]" onClick={onAll}><Copy className="h-3.5 w-3.5" /> All pages</Button>}
        </div>
      </div>
    </Field>
  );
}

function Field({ label, children }) {
  return <div className="space-y-1.5"><div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{label}</div>{children}</div>;
}

function Thumb({ p, k, on, onPick }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const t = setTimeout(() => setUrl(thumbOf(rendered(p))), 0); return () => clearTimeout(t); }, [p]);
  return (
    <button onClick={onPick} className={`no-drag block w-full rounded-xl border p-1.5 text-left ${on ? 'border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]' : 'border-line hover:border-line-strong'}`}>
      <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-lg bg-bg-2">
        {url ? <img src={url} alt="" className="max-h-full max-w-full object-contain shadow" /> : <Loader2 className="h-4 w-4 animate-spin text-muted" />}
      </div>
      <div className="mt-1 truncate text-[11px] text-muted">{k + 1}. {p.name}</div>
    </button>
  );
}

function PageView({ p }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const t = setTimeout(() => {
      const c = rendered(p);
      const el = ref.current;
      if (!el) return;
      el.width = c.width; el.height = c.height;
      el.getContext('2d').drawImage(c, 0, 0);
      setReady(true);
    }, 0);
    return () => clearTimeout(t);
  }, [p]);
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <canvas ref={ref} className="max-h-full max-w-full bg-white object-contain shadow-[0_10px_40px_-10px_rgba(0,0,0,.45)]" style={{ visibility: ready ? 'visible' : 'hidden' }} />
      {!ready && <Loader2 className="absolute h-6 w-6 animate-spin text-muted" />}
    </div>
  );
}

// The whole photo with the page outline; drag the four corners.
function CropView({ p, onQuad }) {
  const box = useRef(null);
  const url = useMemo(() => thumbOf(p.src, 1400), [p.src]);
  const [drag, setDrag] = useState(-1);
  const q = p.quad;
  const move = (e) => {
    if (drag < 0) return;
    const r = box.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    onQuad(q.map((pt, i) => (i === drag ? [x, y] : pt)));
  };
  return (
    <div className="relative max-h-full max-w-full" style={{ aspectRatio: `${p.src.width} / ${p.src.height}`, height: '100%' }}
      onPointerMove={move} onPointerUp={() => setDrag(-1)} onPointerLeave={() => setDrag(-1)}>
      <div ref={box} className="relative h-full w-full">
        <img src={url} alt="" className="h-full w-full select-none object-contain" draggable={false} />
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
          <polygon points={q.map(([x, y]) => `${x},${y}`).join(' ')} fill="rgba(109,93,252,.18)" stroke="var(--accent)" strokeWidth="0.004" />
        </svg>
        {q.map(([x, y], i) => (
          <div key={i} onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setDrag(i); }}
            className="no-drag absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-accent shadow-lg active:cursor-grabbing"
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, touchAction: 'none' }} />
        ))}
      </div>
    </div>
  );
}
