import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Monitor, Laptop, Apple, FileUp, FolderUp, X, Check, ArrowUpRight, ArrowDownLeft,
  FolderOpen, File as FileIcon, ShieldCheck, AlertCircle, Ban, Clock, Plus, Loader2, Wifi,
  Smartphone, Tablet, Tv, QrCode, RefreshCw, Copy,
} from 'lucide-react';
import { api, fmtSize, fmtSpeed, fmtEta, timeAgo, hueFor, initials, label, peerOf, isPlayable, playStream } from './lib.js';
import { Play, ClipboardType, ExternalLink, Send } from 'lucide-react';

const spring = { type: 'spring', stiffness: 420, damping: 32 };

export function Avatar({ id, name, size = 48, ring = false }) {
  const h = hueFor(id);
  return (
    <div
      className="relative grid place-items-center rounded-full font-display font-semibold text-white shrink-0"
      style={{
        width: size, height: size, fontSize: size * 0.36,
        background: `linear-gradient(140deg, hsl(${h} 80% 62%), hsl(${(h + 50) % 360} 85% 52%))`,
        boxShadow: ring ? `0 0 0 3px var(--bg), 0 0 0 5px hsl(${h} 80% 62% / .6)` : `0 6px 18px -6px hsl(${h} 80% 50% / .6)`,
      }}
    >
      {initials(name)}
    </div>
  );
}

export function PlatformIcon({ platform, className }) {
  if (platform === 'phone') return <Smartphone className={className} />;
  if (platform === 'tablet') return <Tablet className={className} />;
  if (platform === 'tv') return <Tv className={className} />;
  if (platform === 'darwin') return <Apple className={className} />;
  if (platform === 'linux') return <Laptop className={className} />;
  return <Monitor className={className} />;
}

export function Button({ variant = 'ghost', className = '', children, ...rest }) {
  const base = 'no-drag inline-flex items-center justify-center gap-2 rounded-xl px-3.5 h-9 text-[13px] font-medium transition-all active:scale-[.97] disabled:opacity-50 disabled:pointer-events-none cursor-default';
  const styles = {
    primary: 'grad-bg text-white shadow-[0_8px_24px_-8px_var(--glow)] hover:brightness-110',
    ghost: 'bg-transparent text-muted hover:text-fg hover:bg-[var(--line)]',
    soft: 'bg-raised border border-line text-fg hover:border-line-strong',
    danger: 'bg-transparent text-bad hover:bg-[color-mix(in_oklab,var(--bad)_12%,transparent)]',
  };
  return <button className={`${base} ${styles[variant]} ${className}`} {...rest}>{children}</button>;
}

// ---------- device card (drop target) ----------

export function DeviceCard({ peer, dragging, busy, onDropPaths, onPick, onText }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const h = hueFor(peer.id);

  const handlers = {
    onDragEnter: (e) => { e.preventDefault(); depth.current++; setOver(true); },
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
    onDragLeave: () => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      const paths = api.pathsFromFiles(e.dataTransfer.files);
      if (paths.length) onDropPaths(peer, paths);
    },
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: over ? 1.035 : 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={spring}
      {...handlers}
      className="group relative rounded-3xl p-5 glass overflow-hidden"
      style={{
        borderColor: over ? `hsl(${h} 85% 62%)` : dragging ? 'var(--line-strong)' : undefined,
        borderStyle: dragging && !over ? 'dashed' : 'solid',
        boxShadow: over ? `0 0 0 4px hsl(${h} 85% 62% / .18), 0 24px 60px -20px hsl(${h} 85% 55% / .55)` : '0 1px 0 0 var(--line)',
      }}
    >
      <div
        className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full blur-3xl transition-opacity duration-500"
        style={{ background: `hsl(${h} 85% 60% / .22)`, opacity: over ? 1 : 0.45 }}
      />
      <div className="relative flex items-start gap-4">
        <div className="relative">
          <Avatar id={peer.id} name={peer.name} size={54} />
          <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-good ring-[3px] ring-[var(--panel-solid)]" />
        </div>
        <div className="min-w-0 flex-1 pt-1">
          <div className="truncate font-display text-[16px] font-semibold">{peer.name}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-faint">
            <PlatformIcon platform={peer.platform} className="h-3.5 w-3.5" />
            <span className="tabular">{peer.ip}</span>
            {peer.manual && <span className="rounded-md bg-[var(--line)] px-1.5 py-px text-[10.5px]">added by IP</span>}
            {peer.web && <span className="rounded-md bg-accent-2/15 px-1.5 py-px text-[10.5px] text-accent-2">browser</span>}
            {peer.outdated && <span className="rounded-md bg-warn/15 px-1.5 py-px text-[10.5px] text-warn" title="This PC runs an older DropWave. Ask them to update to send files.">update needed</span>}
          </div>
        </div>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
      </div>

      <div className="relative mt-5 h-9">
        <AnimatePresence mode="wait" initial={false}>
          {dragging ? (
            <motion.div
              key="drop"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              className="flex h-9 items-center justify-center gap-2 rounded-xl text-[13px] font-medium"
              style={{ color: over ? `hsl(${h} 90% 70%)` : 'var(--muted)', background: over ? `hsl(${h} 85% 60% / .12)` : 'transparent' }}
            >
              <ArrowDownLeft className={`h-4 w-4 transition-transform ${over ? 'rotate-[-45deg] scale-110' : ''}`} />
              {over ? `Release to send to ${peer.name}` : 'Drop here'}
            </motion.div>
          ) : (
            <motion.div key="btns" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex gap-2">
              <Button variant="soft" className="flex-1" onClick={() => onPick(peer, 'files')}><FileUp className="h-4 w-4" /> Files</Button>
              <Button variant="soft" className="flex-1" onClick={() => onPick(peer, 'folder')}><FolderUp className="h-4 w-4" /> Folder</Button>
              <Button variant="soft" className="w-9 shrink-0 px-0" onClick={() => onText(peer)} title="Send text or clipboard"><ClipboardType className="h-4 w-4" /></Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ---------- empty state ----------

export function Radar({ me, onAdd, onPhone, onCheck }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="relative grid h-64 w-64 place-items-center">
        {[0, 1, 2].map((i) => (
          <span key={i} className="radar-ring absolute inset-0 rounded-full border border-accent/40" style={{ animationDelay: `${i * 1.05}s` }} />
        ))}
        <span className="absolute inset-16 rounded-full bg-accent/10 blur-2xl" />
        <Avatar id={me.id} name={me.name} size={76} ring />
      </div>
      <h2 className="mt-2 font-display text-[22px] font-semibold">Looking for nearby devices…</h2>
      <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-muted">
        Open DropWave on another computer on the same Wi-Fi or LAN and it shows up here. Phones and TVs can join from their browser.
      </p>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" onClick={onPhone}><QrCode className="h-4 w-4" /> Connect phone or TV</Button>
        <Button variant="soft" onClick={onAdd}><Plus className="h-4 w-4" /> Add PC by IP</Button>
      </div>
      <button onClick={onCheck} className="mt-4 text-[12.5px] font-medium text-accent hover:underline">
        Can’t see your other devices? Run a network check
      </button>
      <p className="mt-6 flex items-center gap-1.5 text-[12px] text-faint">
        <Wifi className="h-3.5 w-3.5" /> This PC is visible as <b className="font-semibold text-muted">{me.name}</b> · {me.ips.join(', ') || 'no network'}
      </p>
    </div>
  );
}

// ---------- transfer rows ----------

const statusMeta = {
  waiting: { text: 'Waiting for approval', color: 'var(--warn)', Icon: Clock },
  active: { text: '', color: 'var(--accent)', Icon: null },
  completed: { text: 'Completed', color: 'var(--good)', Icon: Check },
  failed: { text: 'Failed', color: 'var(--bad)', Icon: AlertCircle },
  rejected: { text: 'Declined', color: 'var(--faint)', Icon: Ban },
  cancelled: { text: 'Cancelled', color: 'var(--faint)', Icon: X },
};

export function TransferRow({ t, compact = false }) {
  const p = peerOf(t) || {};
  const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.status === 'completed' ? 100 : 0;
  // paused / reconnecting = the connection dropped and DropWave is resuming it
  const live = ['active', 'waiting', 'paused', 'reconnecting'].includes(t.status);
  const stalled = t.status === 'paused' || t.status === 'reconnecting';
  const meta = statusMeta[t.status] || statusMeta.failed;
  const Dir = t.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
  const openable = t.direction === 'in' && t.status === 'completed' && t.savedTo?.length;
  // "Play now" while an incoming PC transfer is still copying; "Play" once a single media file landed.
  const playIdx = t.direction === 'in' ? t.files.findIndex((f) => isPlayable(f.name)) : -1;
  const canStream = live && t.stream && playIdx >= 0;
  const canPlayLocal = openable && t.count === 1 && isPlayable(t.files[0].name);

  return (
    // No layout animation here: rows re-render on every progress tick, and animating
    // their layout continuously made rows overlap.
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={spring}
      className={`group rounded-2xl border border-line bg-raised/70 ${compact ? 'p-3' : 'p-4'}`}
    >
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--line)]">
            {t.count > 1 ? <FolderOpen className="h-5 w-5 text-muted" /> : <FileIcon className="h-5 w-5 text-muted" />}
          </div>
          <span
            className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full ring-2 ring-[var(--panel-solid)]"
            style={{ background: t.direction === 'in' ? 'var(--accent-2)' : 'var(--accent)' }}
          >
            <Dir className="h-3 w-3 text-white" strokeWidth={2.6} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium" title={t.files.map((f) => f.name).join('\n')}>{label(t)}</div>
          <div className="mt-0.5 truncate text-[12px] text-faint">
            {t.direction === 'in' ? 'from' : 'to'} <span className="text-muted">{p.name}</span> · {fmtSize(t.total)}
            {!live && !compact && <> · {timeAgo(t.finishedAt)}</>}
          </div>
        </div>
        {canStream && (
          <button
            onClick={() => playStream(t, playIdx)}
            title="Watch it now, while it copies"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent/15 px-2.5 text-[12px] font-semibold text-accent transition hover:bg-accent/25"
          >
            <Play className="h-3.5 w-3.5 fill-current" /> {compact ? 'Play' : 'Play now'}
          </button>
        )}
        {live ? (
          <button
            onClick={() => api.cancel(t.id)}
            title="Cancel"
            className="grid h-8 w-8 place-items-center rounded-lg text-faint opacity-70 transition hover:bg-[var(--line)] hover:text-bad group-hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        ) : openable ? (
          // Hidden (not just transparent) until hover, so it doesn't squeeze the file name.
          <div className="hidden shrink-0 gap-1 group-hover:flex">
            {canPlayLocal && (
              <button onClick={() => api.play({ file: t.savedTo[0], name: label(t) })} className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[12px] font-semibold text-accent hover:bg-accent/15">
                <Play className="h-3.5 w-3.5 fill-current" /> Play
              </button>
            )}
            {t.count === 1 && (
              <button onClick={() => api.openPath(t.savedTo[0])} className="h-8 rounded-lg px-2.5 text-[12px] text-muted hover:bg-[var(--line)] hover:text-fg">Open</button>
            )}
            <button onClick={() => api.showInFolder(t.savedTo[0])} className="h-8 rounded-lg px-2.5 text-[12px] text-muted hover:bg-[var(--line)] hover:text-fg">Show in folder</button>
          </div>
        ) : null}
        {!live && (
          <span className={`flex shrink-0 items-center gap-1 text-[12px] font-medium ${openable ? 'group-hover:hidden' : ''}`} style={{ color: meta.color }} title={t.error}>
            <meta.Icon className="h-3.5 w-3.5" /> {!compact && meta.text}
          </span>
        )}
      </div>

      {live && (
        <div className="mt-3">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-[var(--line)]">
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full grad-bg"
              animate={{ width: t.status === 'waiting' ? '100%' : `${pct}%` }}
              transition={{ ease: 'linear', duration: 0.2 }}
              style={{ opacity: t.status === 'waiting' ? 0.25 : 1 }}
            />
            <div className="absolute inset-0 bar-shimmer" />
          </div>
          <div className="mt-1.5 flex justify-between text-[11.5px] text-faint tabular">
            <span className={stalled ? 'flex items-center gap-1 text-warn' : ''}>
              {stalled && <Loader2 className="h-3 w-3 animate-spin" />}
              {t.status === 'waiting' ? `Waiting for ${p.name} to accept…`
                : stalled ? `${t.status === 'reconnecting' ? 'Reconnecting' : 'Connection lost, waiting'} · ${pct.toFixed(0)}% saved`
                : `${fmtSize(t.done)} of ${fmtSize(t.total)} · ${pct.toFixed(0)}%${t.resumed ? ' · resumed' : ''}`}
            </span>
            <span>{fmtSpeed(t.bps)} {t.eta != null && t.status === 'active' ? `· ${fmtEta(t.eta)}` : ''}</span>
          </div>
        </div>
      )}
      {!live && t.error && t.status === 'failed' && !compact && <div className="mt-2 text-[12px] text-bad">{t.error}</div>}
    </motion.div>
  );
}

// ---------- modals ----------

function Modal({ children, onClose }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-6 backdrop-blur-sm"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.97 }}
        transition={spring}
        className="w-full max-w-[440px] rounded-3xl border border-line-strong bg-panel-solid p-6 shadow-2xl"
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export function IncomingModal({ req, onRespond }) {
  const [trust, setTrust] = useState(false);
  const shown = req.files.slice(0, 5);
  return (
    <Modal>
      <div className="flex flex-col items-center text-center">
        <div className="relative">
          <span className="radar-ring absolute inset-0 rounded-full border-2 border-accent/50" />
          <Avatar id={req.from.id} name={req.from.name} size={64} />
        </div>
        <div className="mt-4 font-display text-[19px] font-semibold">{req.from.name}</div>
        <div className="text-[13px] text-muted">wants to send you {req.count === 1 ? 'a file' : `${req.count} files`} · {fmtSize(req.total)}</div>
      </div>

      <div className="mt-5 max-h-44 overflow-auto rounded-2xl border border-line bg-bg-2/60 p-1.5">
        {shown.map((f, i) => (
          <div key={f.name} className="flex items-center gap-2.5 rounded-xl px-2.5 py-1.5">
            <FileIcon className="h-4 w-4 shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate text-left text-[13px]">{f.name}</span>
            <span className="text-[12px] text-faint tabular">{fmtSize(f.size)}</span>
            {req.stream && isPlayable(f.name) && (
              <button
                onClick={() => playStream(req, i)}
                title="Preview before accepting"
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg bg-accent/15 px-2 text-[12px] font-semibold text-accent transition hover:bg-accent/25"
              >
                <Play className="h-3 w-3 fill-current" /> Play
              </button>
            )}
          </div>
        ))}
        {req.files.length > shown.length && <div className="px-2.5 py-1.5 text-left text-[12px] text-faint">+ {req.files.length - shown.length} more</div>}
      </div>

      <label className="mt-4 flex cursor-default items-center gap-2.5 text-[13px] text-muted">
        <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
        <ShieldCheck className="h-4 w-4" /> Always accept from this device
      </label>

      <div className="mt-5 grid grid-cols-2 gap-2.5">
        <Button variant="soft" className="h-10" onClick={() => onRespond(req.id, false)}>Decline</Button>
        <Button variant="primary" className="h-10" onClick={() => onRespond(req.id, true, trust)} autoFocus><Check className="h-4 w-4" /> Accept</Button>
      </div>
      <motion.div className="mt-4 h-1 rounded-full bg-accent/40" initial={{ width: '100%' }} animate={{ width: '0%' }} transition={{ duration: 60, ease: 'linear' }} />
    </Modal>
  );
}

export function AddDeviceModal({ onClose, onAdded }) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { onAdded(await api.addPeer(value)); onClose(); }
    catch (e2) { setErr(String(e2.message || e2).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit}>
        <div className="font-display text-[18px] font-semibold">Add device by IP</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          Use this if a device doesn't appear automatically. You can find its IP at the bottom-left of DropWave on that computer.
        </p>
        <input
          autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="192.168.1.20"
          className="mt-4 h-11 w-full rounded-xl border border-line-strong bg-bg-2 px-3.5 text-[14px] outline-none transition focus:border-accent focus:shadow-[0_0_0_4px_var(--glow)] tabular"
        />
        {err && <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad"><AlertCircle className="h-3.5 w-3.5" /> {err}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value.trim() || busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Connect</Button>
        </div>
      </form>
    </Modal>
  );
}

export function PhoneModal({ onClose, onOpenSettings }) {
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState(false);
  const load = () => api.webQr().then(setInfo);
  useEffect(() => { load(); }, []);
  const resetPin = async () => { await api.resetPin(); load(); };
  const copy = async () => { await navigator.clipboard.writeText(info.primary); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <Modal onClose={onClose}>
      <div className="flex items-start justify-between">
        <div>
          <div className="font-display text-[19px] font-semibold">Connect a phone or TV</div>
          <p className="mt-1 text-[13px] text-muted">Works in any browser — no app needed.</p>
        </div>
        <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-[var(--line)] hover:text-fg"><X className="h-4 w-4" /></button>
      </div>

      {!info ? (
        <div className="grid h-72 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-faint" /></div>
      ) : !info.enabled ? (
        <div className="mt-5 rounded-2xl border border-line bg-bg-2/60 p-5 text-center text-[13px] text-muted">
          {info.error || 'Phone & TV access is turned off.'}
          <div className="mt-3"><Button variant="soft" onClick={onOpenSettings}>Open settings</Button></div>
        </div>
      ) : (
        <>
          <div className="mt-5 flex items-center gap-5">
            <div className="shrink-0 rounded-2xl bg-white p-2.5 shadow-[0_12px_40px_-14px_var(--glow)]">
              {info.qr ? <img src={info.qr} alt="QR code" className="h-40 w-40" /> : <div className="grid h-40 w-40 place-items-center text-[12px] text-black/50">No network</div>}
            </div>
            <ol className="space-y-2.5 text-[13px] text-muted">
              <li><b className="text-fg">1.</b> Connect the phone or TV to the same Wi-Fi</li>
              <li><b className="text-fg">2.</b> Scan this code with the camera</li>
              <li><b className="text-fg">3.</b> Or open the address below in its browser and enter the PIN</li>
            </ol>
          </div>

          <div className="mt-5 grid grid-cols-[1fr_auto] gap-2.5">
            <button onClick={copy} className="flex h-12 items-center justify-between gap-2 rounded-xl border border-line bg-bg-2/60 px-3.5 text-left hover:border-line-strong" title="Copy address">
              <span className="truncate font-medium tabular">{info.primary?.replace('http://', '') || '—'}</span>
              {copied ? <Check className="h-4 w-4 text-good" /> : <Copy className="h-4 w-4 text-faint" />}
            </button>
            <div className="flex h-12 items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">PIN</span>
              <span className="font-display text-[19px] font-semibold tracking-[.18em] tabular">{info.pin}</span>
            </div>
          </div>
          {info.urls.length > 1 && <div className="mt-2 truncate text-[11.5px] text-faint" title={info.urls.join('\n')}>Also: {info.urls.slice(1).map((u) => u.replace('http://', '')).join(' · ')}</div>}

          <div className="mt-5 flex items-center justify-between">
            <button onClick={resetPin} className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg"><RefreshCw className="h-3.5 w-3.5" /> New PIN (disconnects everyone)</button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------- text / clipboard ----------

const firstUrl = (s) => (String(s).match(/https?:\/\/[^\s<>"']+/i) || [])[0];

export function SendTextModal({ peer, onClose, onSent }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.readClipboard().then((t) => setText((cur) => cur || t || '')); }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api.sendText(peer.id, text); onSent(peer); onClose(); }
    catch (e2) { setErr(String(e2.message || e2).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit}>
        <div className="flex items-center gap-3">
          <Avatar id={peer.id} name={peer.name} size={40} />
          <div>
            <div className="font-display text-[18px] font-semibold">Send text</div>
            <div className="text-[13px] text-muted">to {peer.name}. Your clipboard is already pasted.</div>
          </div>
        </div>
        <textarea
          autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={6} maxLength={100000}
          placeholder="Paste a link, a note, a password-free message…"
          className="mt-4 w-full resize-none rounded-xl border border-line-strong bg-bg-2 px-3.5 py-3 text-[13.5px] outline-none transition focus:border-accent focus:shadow-[0_0_0_4px_var(--glow)]"
        />
        {err && <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad"><AlertCircle className="h-3.5 w-3.5" /> {err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!text.trim() || busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send</Button>
        </div>
      </form>
    </Modal>
  );
}

export function TextReceivedModal({ msg, onClose }) {
  const [copied, setCopied] = useState(false);
  const url = firstUrl(msg.text);
  const copy = async () => { await api.writeClipboard(msg.text); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <Modal onClose={onClose}>
      <div className="flex items-center gap-3">
        <Avatar id={msg.from.id || msg.from.name} name={msg.from.name} size={40} />
        <div className="min-w-0">
          <div className="truncate font-display text-[18px] font-semibold">{msg.from.name}</div>
          <div className="text-[13px] text-muted">sent you text</div>
        </div>
      </div>
      <div className="mt-4 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-2/60 px-3.5 py-3 text-[13.5px] select-text">{msg.text}</div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Close</Button>
        {url && <Button variant="soft" onClick={() => api.openLink(url)}><ExternalLink className="h-4 w-4" /> Open link</Button>}
        <Button variant="primary" onClick={copy} autoFocus>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}</Button>
      </div>
    </Modal>
  );
}

// Opened from Explorer's right-click "Send with DropWave": choose where the items go.
export function SendToModal({ paths, peers, onSend, onClose, onPhone }) {
  const names = paths.map((p) => p.split(/[\\/]/).pop());
  return (
    <Modal onClose={onClose}>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="font-display text-[19px] font-semibold">Send with DropWave</div>
          <div className="mt-1 truncate text-[13px] text-muted" title={names.join('\n')}>
            {names.length === 1 ? names[0] : `${names.length} items: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`}
          </div>
        </div>
        <button onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint hover:bg-[var(--line)] hover:text-fg"><X className="h-4 w-4" /></button>
      </div>
      {peers.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-line bg-bg-2/60 p-6 text-center text-[13px] text-muted">
          No devices nearby yet. Open DropWave on another PC, or connect a phone.
          <div className="mt-3"><Button variant="soft" onClick={onPhone}><QrCode className="h-4 w-4" /> Connect phone or TV</Button></div>
        </div>
      ) : (
        <div className="mt-5 grid max-h-80 gap-2 overflow-auto">
          {peers.map((p) => (
            <button key={p.id} onClick={() => onSend(p)}
              className="flex items-center gap-3 rounded-2xl border border-line px-3.5 py-3 text-left transition hover:border-accent hover:bg-accent/10">
              <Avatar id={p.id} name={p.name} size={38} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{p.name}</div>
                <div className="flex items-center gap-1.5 text-[12px] text-faint"><PlatformIcon platform={p.platform} className="h-3.5 w-3.5" /> {p.ip}</div>
              </div>
              <ArrowUpRight className="h-4 w-4 text-faint" />
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function Toasts({ toasts, dismiss }) {
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id} layout
            initial={{ opacity: 0, y: 16, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={spring}
            onClick={() => dismiss(t.id)}
            className="pointer-events-auto flex items-center gap-2.5 rounded-2xl border border-line-strong bg-panel-solid px-4 py-2.5 text-[13px] shadow-xl"
          >
            {t.kind === 'error' ? <AlertCircle className="h-4 w-4 text-bad" /> : <Check className="h-4 w-4 text-good" />}
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
