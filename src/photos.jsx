// Photos: the phone's camera roll on the PC. Thumbnails come from the phone page by page;
// originals are only copied when you pick them (saved to <save folder>\Phone).
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Images, Download, Check, X, Play, Loader2, RefreshCw, FolderOpen, ImageOff, Smartphone, ExternalLink } from 'lucide-react';
import { api, fmtSize } from './lib.js';
import { Button, Modal } from './components.jsx';

const KINDS = [['all', 'All'], ['photos', 'Photos'], ['videos', 'Videos'], ['screenshots', 'Screenshots']];
const fmtDur = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: diff < 7 ? 'long' : undefined, day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function PhotosView({ phones, selected, onSelect, toast }) {
  const list = Object.values(phones);
  const phone = phones[selected] || list[0] || null;
  const id = phone?.id;
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [saved, setSaved] = useState({});
  const [preview, setPreview] = useState(null);
  const sentinel = useRef(null);
  const access = data?.access ?? phone?.status?.photosAccess ?? null;

  // Load / follow this phone's photos.
  useEffect(() => {
    if (!id) return;
    setSel(new Set()); setData(null);
    api.photosGet(id).then((d) => {
      setData(d);
      if (d && !d.items.length && d.hasMore && !d.loading) api.photosLoad(id, { kind: d.kind }).then(setData).catch(() => {});
    });
    const offs = [
      api.onPhotos((d) => d.id === id && setData(d)),
      api.onPhotosSaved((e) => e.id === id && setSaved((s) => ({ ...s, ...e.saved }))),
    ];
    return () => offs.forEach((f) => f());
  }, [id]);

  // Photo access was just allowed on the phone: load.
  const prevAccess = useRef(access);
  useEffect(() => {
    if (id && prevAccess.current === 'none' && access && access !== 'none') api.photosLoad(id, { kind: data?.kind || 'all', reset: true }).then(setData).catch(() => {});
    prevAccess.current = access;
  }, [access, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Endless scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !id) return;
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting && data?.hasMore && !data?.loading) api.photosLoad(id, { kind: data.kind }).then(setData).catch(() => {});
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [id, data]);

  const groups = useMemo(() => {
    const g = [];
    for (const it of data?.items || []) {
      const label = dayLabel(it.date);
      if (g.at(-1)?.label !== label) g.push({ label, items: [] });
      g.at(-1).items.push(it);
    }
    return g;
  }, [data]);

  const toggle = (it) => setSel((s) => { const n = new Set(s); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; });
  const toggleDay = (items) => setSel((s) => {
    const n = new Set(s);
    const all = items.every((x) => n.has(x.id));
    for (const x of items) if (all) n.delete(x.id); else n.add(x.id);
    return n;
  });
  const download = async (ids) => {
    try {
      const r = await api.photosDownload(id, ids);
      toast(`Saving ${r.count} to ${r.dir}`);
      setSel(new Set());
    } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); }
  };
  const setKind = (k) => { setSel(new Set()); api.photosLoad(id, { kind: k }).then(setData).catch(() => {}); };
  const reload = () => api.photosLoad(id, { kind: data?.kind || 'all', reset: true }).then(setData).catch(() => {});
  const selBytes = (data?.items || []).filter((x) => sel.has(x.id)).reduce((a, x) => a + (x.size || 0), 0);

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex flex-wrap items-end justify-between gap-4 px-7 pb-4 pt-7">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">Photos</h1>
          <p className="mt-1 text-[13px] text-muted">{phone ? `From ${phone.name}. Pick what you want, it’s copied to this PC.` : 'Your phone’s photos and videos, on this PC'}</p>
        </div>
        {phone && access !== 'none' && (
          <div className="flex items-center gap-2">
            {list.length > 1 && (
              <select value={id} onChange={(e) => onSelect(e.target.value)} className="no-drag h-9 rounded-xl border border-line bg-raised px-2 text-[12.5px]">
                {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <div className="flex rounded-xl border border-line bg-bg-2/60 p-1">
              {KINDS.map(([k, l]) => (
                <button key={k} onClick={() => setKind(k)}
                  className={`no-drag relative h-7 rounded-lg px-3 text-[12.5px] font-medium ${(data?.kind || 'all') === k ? 'text-fg' : 'text-muted hover:text-fg'}`}>
                  {(data?.kind || 'all') === k && <motion.span layoutId="photo-kind" className="absolute inset-0 rounded-lg bg-raised shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                  <span className="relative">{l}</span>
                </button>
              ))}
            </div>
            <Button variant="ghost" onClick={reload} title="Refresh"><RefreshCw className={`h-4 w-4 ${data?.loading ? 'animate-spin' : ''}`} /></Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-7 pb-28">
        {!phone ? (
          <Empty Icon={Smartphone} title="No phone connected" text="Open the DropWave app on your Android phone. Its photos and videos show up here." />
        ) : access === 'none' ? (
          <Empty Icon={ImageOff} title="Allow photos on the phone" text={`In the DropWave app on ${phone.name}, tap “Allow photos” on Home. Nothing is copied until you pick it here.`} />
        ) : (
          <>
            {access === 'partial' && (
              <div className="mb-4 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-[12.5px] text-muted">
                Only the photos you picked on the phone are shared. To share all, open Android settings › Apps › DropWave › Photos and videos › Always allow all.
              </div>
            )}
            {data?.error && <div className="mb-4 rounded-2xl border border-bad/40 bg-bad/10 px-4 py-3 text-[12.5px]">{data.error}</div>}
            {!data || (data.loading && !data.items.length) ? (
              <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(132px,1fr))]">
                {Array.from({ length: 24 }, (_, i) => <div key={i} className="aspect-square animate-pulse rounded-xl bg-[var(--line)]" />)}
              </div>
            ) : !data.items.length ? (
              <Empty Icon={Images} title="Nothing here" text="No photos or videos in this view." />
            ) : (
              groups.map((g) => (
                <section key={g.label} className="mb-6">
                  <div className="sticky top-0 z-10 -mx-2 mb-2 flex items-center justify-between bg-[var(--panel-solid)]/90 px-2 py-2 backdrop-blur">
                    <div className="font-display text-[14.5px] font-semibold">{g.label} <span className="ml-1 text-[12px] font-normal text-faint">{g.items.length}</span></div>
                    <button onClick={() => toggleDay(g.items)} className="no-drag text-[12px] font-medium text-accent hover:underline">
                      {g.items.every((x) => sel.has(x.id)) ? 'Unselect' : 'Select all'}
                    </button>
                  </div>
                  <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(132px,1fr))]">
                    {g.items.map((it) => (
                      <Tile key={it.id} it={it} on={sel.has(it.id)} saved={!!saved[it.id]} selecting={sel.size > 0}
                        onClick={(e) => (sel.size || e.ctrlKey || e.shiftKey ? toggle(it) : setPreview(it))} onCheck={() => toggle(it)} />
                    ))}
                  </div>
                </section>
              ))
            )}
            <div ref={sentinel} className="flex h-16 items-center justify-center text-[12px] text-faint">
              {data?.loading && data.items.length > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : data && !data.hasMore && data.items.length > 0 ? `${data.items.length} items` : ''}
            </div>
          </>
        )}
      </div>

      <AnimatePresence>
        {sel.size > 0 && (
          <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
            className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-line-strong bg-panel-solid py-2 pl-4 pr-2 shadow-2xl">
            <span className="text-[13px] font-semibold tabular">{sel.size} selected</span>
            <span className="text-[12px] text-faint tabular">{fmtSize(selBytes)}</span>
            <Button variant="primary" onClick={() => download([...sel])}><Download className="h-4 w-4" /> Download to PC</Button>
            <Button variant="ghost" onClick={() => setSel(new Set())} title="Clear selection"><X className="h-4 w-4" /></Button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {preview && <Preview key={preview.id} it={preview} saved={saved[preview.id]} onClose={() => setPreview(null)} onDownload={() => { download([preview.id]); }} />}
      </AnimatePresence>
    </div>
  );
}

function Tile({ it, on, saved, selecting, onClick, onCheck }) {
  return (
    <div className={`group relative aspect-square overflow-hidden rounded-xl bg-[var(--line)] ${on ? 'ring-[3px] ring-accent' : ''}`}>
      <button onClick={onClick} className="no-drag block h-full w-full" title={it.name}>
        {it.thumb ? <img src={it.thumb} alt="" loading="lazy" draggable={false} className={`h-full w-full object-cover transition ${on ? 'scale-[.92] rounded-lg' : 'group-hover:scale-[1.03]'}`} />
          : <span className="grid h-full w-full place-items-center text-faint"><ImageOff className="h-5 w-5" /></span>}
      </button>
      {it.video && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-white tabular">
          <Play className="h-2.5 w-2.5 fill-white" /> {fmtDur(it.dur)}
        </span>
      )}
      {saved && <span className="pointer-events-none absolute bottom-1.5 right-1.5 grid h-5 w-5 place-items-center rounded-full bg-good text-white" title="Saved on this PC"><Check className="h-3 w-3" /></span>}
      <button onClick={onCheck} aria-label={on ? 'Unselect' : 'Select'}
        className={`no-drag absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border-2 transition ${on ? 'border-accent bg-accent text-white opacity-100' : `border-white/90 bg-black/25 text-transparent ${selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}`}>
        <Check className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Preview({ it, saved, onClose, onDownload }) {
  return (
    <Modal onClose={onClose}>
      <div className="-mx-6 -mt-6 overflow-hidden rounded-t-3xl bg-black">
        {it.thumb ? <img src={it.thumb} alt="" className="mx-auto max-h-[46vh] w-full object-contain" /> : <div className="grid h-60 place-items-center text-white/50"><ImageOff className="h-8 w-8" /></div>}
      </div>
      <div className="mt-4 truncate font-display text-[16px] font-semibold" title={it.name}>{it.name}</div>
      <div className="mt-1 text-[12.5px] text-faint tabular">
        {new Date(it.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {fmtSize(it.size)}{it.w && it.h ? ` · ${it.w}×${it.h}` : ''}{it.video ? ` · ${fmtDur(it.dur)}` : ''}
      </div>
      <p className="mt-2 text-[12px] text-faint">This is a small preview. Download it for the full quality original.</p>
      <div className="mt-5 flex justify-end gap-2">
        {saved ? (
          <>
            <Button variant="soft" onClick={() => api.showInFolder(saved)}><FolderOpen className="h-4 w-4" /> Show in folder</Button>
            <Button variant="primary" onClick={() => api.openPath(saved)}><ExternalLink className="h-4 w-4" /> Open</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={onDownload}><Download className="h-4 w-4" /> Download to PC</Button>
          </>
        )}
      </div>
    </Modal>
  );
}

function Empty({ Icon, title, text }) {
  return (
    <div className="grid place-items-center px-6 pt-20 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-2xl bg-[var(--line)]"><Icon className="h-7 w-7 text-faint" /></div>
      <div className="mt-4 font-display text-[17px] font-semibold">{title}</div>
      <div className="mt-1 max-w-[420px] text-[13px] text-muted">{text}</div>
    </div>
  );
}
