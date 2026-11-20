// Phone files: browse the phone's internal storage from the PC and copy files to this PC.
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Folder, File, FileImage, FileVideo, FileAudio, FileText, FileArchive, ChevronRight, HardDrive, Download, RefreshCw, Eye, EyeOff, X, Smartphone, FolderLock, ArrowUp, Check } from 'lucide-react';
import { api, fmtSize, timeAgo } from './lib.js';
import { Button } from './components.jsx';

function iconFor(it) {
  if (it.dir) return Folder;
  const m = it.mime || '';
  if (m.startsWith('image/')) return FileImage;
  if (m.startsWith('video/')) return FileVideo;
  if (m.startsWith('audio/')) return FileAudio;
  if (/zip|rar|7z|tar|gzip/.test(m)) return FileArchive;
  if (m.startsWith('text/') || /pdf|document|sheet|presentation|msword/.test(m)) return FileText;
  return File;
}

export function FilesView({ phones, selected, onSelect, toast }) {
  const list = Object.values(phones);
  const phone = phones[selected] || list[0] || null;
  const id = phone?.id;
  const [f, setF] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [hidden, setHidden] = useState(false);
  const access = f?.access ?? phone?.status?.filesAccess ?? null;

  useEffect(() => {
    if (!id) return;
    setF(null); setSel(new Set());
    api.filesGet(id).then((d) => { setF(d); if (d && !d.items.length && !d.loading) api.filesList(id, d.path || '', false).catch(() => {}); });
    return api.onFiles((d) => d.id === id && setF(d));
  }, [id]);
  useEffect(() => { if (id && phone?.status?.filesAccess === 'all' && f?.access === 'none') api.filesList(id, '', hidden); }, [phone?.status?.filesAccess]); // eslint-disable-line react-hooks/exhaustive-deps
  // Switched on again in DropWave › Privacy on the phone: load.
  const filesOff = !!phone?.status?.off?.includes('files');
  const wasOff = useRef(filesOff);
  useEffect(() => { if (id && wasOff.current && !filesOff) api.filesList(id, f?.path || '', hidden).catch(() => {}); wasOff.current = filesOff; }, [filesOff, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e) => toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  const go = (rel) => { setSel(new Set()); api.filesList(id, rel, hidden).catch(fail); };
  const crumbs = useMemo(() => {
    const parts = (f?.path || '').split('/').filter(Boolean);
    return [{ name: 'Internal storage', rel: '' }, ...parts.map((p, i) => ({ name: p, rel: parts.slice(0, i + 1).join('/') }))];
  }, [f?.path]);
  const join = (name) => (f?.path ? `${f.path}/${name}` : name);
  const toggle = (name) => setSel((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const files = (f?.items || []).filter((x) => !x.dir);
  const selBytes = files.filter((x) => sel.has(x.name)).reduce((a, x) => a + x.size, 0);
  const download = async (names) => {
    try { const r = await api.filesDownload(id, names); toast(`Saving ${r.count} to ${r.dir}`); setSel(new Set()); }
    catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); }
  };

  if (!phone) return <Empty Icon={Smartphone} title="No phone connected" text="Open the DropWave app on your Android phone to browse its files here." />;
  if (filesOff) return <Empty Icon={FolderLock} title="Switched off on the phone" text={`Phone files sharing is off in DropWave › Privacy on ${phone.name}. Turn it on there and this page fills in by itself.`} />;
  if (access === 'none') {
    return <Empty Icon={FolderLock} title="Allow file access on the phone" text={`In the DropWave app on ${phone.name}, tap “Browse phone files from PC”, then turn on “Allow access to manage all files”.`} />;
  }
  const used = f?.total ? f.total - f.free : 0;

  return (
    <div className="relative flex h-full flex-col">
      <div className="px-7 pb-3 pt-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] font-semibold tracking-tight">Phone files</h1>
            <p className="mt-1 text-[13px] text-muted">{phone.name} · pick files to copy to this PC</p>
          </div>
          <div className="flex items-center gap-2">
            {list.length > 1 && (
              <select value={id} onChange={(e) => onSelect(e.target.value)} className="no-drag h-9 rounded-xl border border-line bg-raised px-2 text-[12.5px]">
                {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <Button variant="ghost" title={hidden ? 'Hide hidden files' : 'Show hidden files'} onClick={() => { const h = !hidden; setHidden(h); api.filesList(id, f?.path || '', h).catch(fail); }}>
              {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" title="Refresh" onClick={() => go(f?.path || '')}><RefreshCw className={`h-4 w-4 ${f?.loading ? 'animate-spin' : ''}`} /></Button>
          </div>
        </div>
        {f?.total > 0 && (
          <div className="mt-4 flex items-center gap-3 rounded-2xl border border-line bg-raised/60 px-4 py-3">
            <HardDrive className="h-5 w-5 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="h-2 overflow-hidden rounded-full bg-[var(--line-strong)]"><div className="h-full rounded-full grad-bg" style={{ width: `${(used / f.total) * 100}%` }} /></div>
            </div>
            <span className="shrink-0 text-[12px] text-muted tabular">{fmtSize(f.free)} free of {fmtSize(f.total)}</span>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-1 text-[13px]">
          {crumbs.length > 1 && <button onClick={() => go(crumbs.at(-2).rel)} className="no-drag mr-1 grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-[var(--line)]" title="Up"><ArrowUp className="h-4 w-4" /></button>}
          {crumbs.map((c, i) => (
            <span key={c.rel} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-faint" />}
              <button onClick={() => go(c.rel)} className={`no-drag rounded-lg px-2 py-1 ${i === crumbs.length - 1 ? 'font-semibold' : 'text-muted hover:bg-[var(--line)] hover:text-fg'}`}>{c.name}</button>
            </span>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-7 pb-28">
        {f?.error && <div className="mb-3 rounded-2xl border border-bad/40 bg-bad/10 px-4 py-3 text-[12.5px]">{f.error}</div>}
        {!f || (f.loading && !f.items.length) ? (
          <div className="space-y-1.5">{Array.from({ length: 10 }, (_, i) => <div key={i} className="h-11 animate-pulse rounded-xl bg-[var(--line)]" />)}</div>
        ) : f.items.length === 0 ? (
          <div className="py-16 text-center text-[13px] text-faint">This folder is empty.</div>
        ) : (
          <div className={`overflow-hidden rounded-2xl border border-line bg-raised/50 transition ${f.loading ? 'opacity-60' : ''}`}>
            {f.items.map((it) => {
              const Icon = iconFor(it);
              const on = sel.has(it.name);
              return (
                <div key={it.name} onDoubleClick={() => (it.dir ? go(join(it.name)) : download([it.name]))}
                  onClick={() => (it.dir ? go(join(it.name)) : toggle(it.name))}
                  className={`group flex cursor-default items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 ${on ? 'bg-accent/10' : 'hover:bg-[var(--line)]'}`}>
                  {!it.dir ? (
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 ${on ? 'border-accent bg-accent text-white' : 'border-line-strong text-transparent group-hover:border-faint'}`}><Check className="h-3 w-3" /></span>
                  ) : <span className="w-5 shrink-0" />}
                  <Icon className={`h-[18px] w-[18px] shrink-0 ${it.dir ? 'text-accent' : 'text-muted'}`} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]" title={it.name}>{it.name}</span>
                  <span className="w-28 shrink-0 text-right text-[12px] text-faint tabular">{it.dir ? `${it.count ?? 0} item${it.count === 1 ? '' : 's'}` : fmtSize(it.size)}</span>
                  <span className="w-32 shrink-0 text-right text-[12px] text-faint">{it.mtime ? timeAgo(it.mtime) : ''}</span>
                </div>
              );
            })}
          </div>
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
    </div>
  );
}

function Empty({ Icon, title, text }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div>
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[var(--line)]"><Icon className="h-7 w-7 text-faint" /></div>
        <div className="mt-4 font-display text-[17px] font-semibold">{title}</div>
        <div className="mx-auto mt-1 max-w-[440px] text-[13px] text-muted">{text}</div>
      </div>
    </div>
  );
}
