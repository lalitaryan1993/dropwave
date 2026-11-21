// Home: the phone on the PC. Battery, what's playing, notifications (reply, copy code), find the
// phone, clipboard and the phone's touchpad, plus a timeline of what moved between devices.
import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Smartphone, BatteryCharging, BellRing, Bell, ClipboardPaste, ClipboardCopy, Send, Phone, MessageSquare,
  Play, Pause, SkipBack, SkipForward, Music2, X, Copy, Reply, MousePointer2, Lock, History, QrCode, Download,
  Check, ArrowUpRight, ArrowDownLeft, ShieldCheck, Keyboard, Sparkles, BellOff, Volume2, Volume1, VolumeX, Plus, Minus, MonitorSmartphone,
} from 'lucide-react';
import { api, timeAgo } from './lib.js';
import { Avatar, Button, Modal } from './components.jsx';
import { RecentCalls } from './phonecalls.jsx';
import { ControlsCard, CameraCard, MicCard } from './phonetools.jsx';

const RELEASES = 'https://github.com/lalitaryan1993/dropwave/releases/latest';

// ---------- data ----------

/** Phones running the Android app (status, notifications, media), the session timeline, and "may it control this PC?" prompts. */
export function usePhones() {
  const [phones, setPhones] = useState({});
  const [timeline, setTimeline] = useState([]);
  const [asks, setAsks] = useState([]);
  const [remote, setRemote] = useState([]);
  useEffect(() => {
    api.phoneList().then((r) => {
      setPhones(Object.fromEntries(r.phones.map((p) => [p.id, p])));
      setTimeline(r.timeline);
      setAsks(r.asks);
      setRemote(r.remote || []);
    });
    const offs = [
      api.onPhone((p) => setPhones((m) => ({ ...m, [p.id]: p }))),
      api.onPhoneGone((id) => setPhones((m) => { const n = { ...m }; delete n[id]; return n; })),
      api.onTimeline((e) => setTimeline((t) => [e, ...t].slice(0, 100))),
      api.onRemoteAsk((a) => setAsks((l) => [...l.filter((x) => x.id !== a.id), a])),
      api.onRemoteAskClosed((id) => setAsks((l) => l.filter((x) => x.id !== id))),
      api.onRemoteState(setRemote),
    ];
    return () => offs.forEach((f) => f());
  }, []);
  return { phones, timeline, asks, remote };
}

// Ticks every second while something on screen counts (media position, "x min ago").
function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// ---------- Home ----------

export function Home({ phones, peers, timeline, history, selected, onSelect, onConnect, onPick, onText, onCall, onSeeAll, toast }) {
  const list = Object.values(phones);
  const phone = phones[selected] || list[0] || null;
  const browserPhones = peers.filter((p) => p.web && !phones[p.id]);

  return (
    <div className="h-full overflow-auto p-7">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">Home</h1>
          <p className="mt-1 text-[13px] text-muted">{phone ? 'Your phone, right here on your PC' : 'Bring your phone to your PC'}</p>
        </div>
        {list.length > 1 && (
          <div className="flex gap-1.5 rounded-xl border border-line bg-bg-2/60 p-1">
            {list.map((p) => (
              <button key={p.id} onClick={() => onSelect(p.id)}
                className={`no-drag h-8 rounded-lg px-3 text-[12.5px] font-medium ${p.id === phone?.id ? 'bg-raised text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>{p.name}</button>
            ))}
          </div>
        )}
      </div>

      {!phone ? (
        <Welcome browserPhones={browserPhones} onConnect={onConnect} />
      ) : (
        <div className="mt-6 grid gap-4 [grid-template-columns:minmax(0,1fr)_290px] max-[1100px]:[grid-template-columns:minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <PhoneHero phone={phone} />
            <Tiles phone={phone} onPick={onPick} onText={onText} onCall={onCall} toast={toast} />
            <Notifications phone={phone} toast={toast} />
          </div>
          <div className="min-w-0 space-y-4">
            <ControlsCard phone={phone} toast={toast} />
            <CameraCard phone={phone} toast={toast} />
            <MicCard phone={phone} />
            <MediaCard phone={phone} />
            <RecentCalls phone={phone} />
            <RemoteCard phone={phone} />
            <TimelineCard timeline={timeline} history={history} onSeeAll={onSeeAll} />
          </div>
        </div>
      )}
    </div>
  );
}

function Welcome({ browserPhones, onConnect }) {
  const features = [
    [Bell, 'Notifications', 'See them here, reply, copy one-time codes'],
    [ClipboardPaste, 'Clipboard', 'Copy on one, paste on the other'],
    [BellRing, 'Find my phone', 'Ring it, even on silent'],
    [MousePointer2, 'Touchpad & Deck', 'Use the phone as this PC’s mouse, keyboard and remote'],
  ];
  return (
    <div className="mt-6 overflow-hidden rounded-[26px] border border-line bg-raised/60">
      <div className="relative grid gap-8 p-8 [grid-template-columns:200px_minmax(0,1fr)] max-[900px]:[grid-template-columns:minmax(0,1fr)]">
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full opacity-30 blur-3xl grad-bg" />
        <PhoneArt battery={null} />
        <div className="relative">
          <div className="font-display text-[22px] font-semibold tracking-tight">Connect the DropWave Android app</div>
          <p className="mt-1.5 max-w-[520px] text-[13.5px] text-muted">
            Your phone shows up here with its battery, notifications and music. Everything stays on your Wi-Fi, encrypted, with no account.
          </p>
          <div className="mt-5 grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            {features.map(([Icon, t, d]) => (
              <div key={t} className="flex items-start gap-3 rounded-2xl border border-line bg-bg-2/50 p-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent"><Icon className="h-[18px] w-[18px]" /></span>
                <div className="min-w-0"><div className="text-[13.5px] font-semibold">{t}</div><div className="mt-0.5 text-[12px] text-faint">{d}</div></div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Button variant="primary" className="h-10 px-4" onClick={onConnect}><QrCode className="h-4 w-4" /> Connect phone</Button>
            <Button variant="soft" className="h-10 px-4" onClick={() => api.openLink(RELEASES)}><Download className="h-4 w-4" /> Get the Android app</Button>
          </div>
          {browserPhones.length > 0 && (
            <div className="mt-4 text-[12.5px] text-faint">
              {browserPhones.map((p) => p.name).join(', ')} {browserPhones.length > 1 ? 'are' : 'is'} connected from a browser. Files and chat work there; open DropWave in the Android app for the rest.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// A drawn phone with a battery ring on its screen.
function PhoneArt({ battery, charging, small }) {
  const pct = battery == null ? null : Math.max(0, Math.min(100, battery));
  const r = 30, c = 2 * Math.PI * r;
  const color = pct == null ? 'var(--accent)' : pct <= 15 && !charging ? 'var(--bad)' : pct <= 30 && !charging ? 'var(--warn)' : 'var(--good)';
  return (
    <div className={`relative mx-auto ${small ? 'h-[150px] w-[78px]' : 'h-[210px] w-[108px]'} shrink-0 rounded-[22px] border-[3px] border-fg/85 bg-gradient-to-b from-accent/25 via-bg-2 to-accent-2/20 p-1 shadow-[0_24px_50px_-24px_var(--glow)]`}>
      <div className="absolute left-1/2 top-2 h-1.5 w-8 -translate-x-1/2 rounded-full bg-fg/70" />
      <div className="grid h-full place-items-center">
        <svg viewBox="0 0 80 80" className={small ? 'h-14 w-14' : 'h-[72px] w-[72px]'}>
          <circle cx="40" cy="40" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="6" />
          {pct != null && (
            <circle cx="40" cy="40" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 40 40)" style={{ transition: 'stroke-dashoffset .6s' }} />
          )}
          <text x="40" y="45" textAnchor="middle" className="fill-[var(--fg)] font-display text-[15px] font-semibold">{pct == null ? '' : `${pct}%`}</text>
        </svg>
      </div>
      {pct == null && <Smartphone className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 text-accent" />}
      {charging && <BatteryCharging className="absolute bottom-4 left-1/2 h-4 w-4 -translate-x-1/2 text-good" />}
      <div className="absolute bottom-1.5 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-fg/60" />
    </div>
  );
}

function PhoneHero({ phone }) {
  const s = phone.status || {};
  return (
    <section className="relative overflow-hidden rounded-[26px] border border-line bg-raised/60 p-5">
      <div className="pointer-events-none absolute -left-24 -top-28 h-72 w-72 rounded-full opacity-25 blur-3xl grad-bg" />
      <div className="relative">
        <div className="flex min-w-0 flex-1 items-center gap-5">
        <PhoneArt battery={s.battery} charging={s.charging} small />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[26px] font-semibold tracking-tight">{phone.name}</div>
          <div className="mt-0.5 truncate text-[13px] text-muted">{[s.model, s.android && `Android ${s.android}`].filter(Boolean).join(' · ') || 'Android'}</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chip><span className="h-1.5 w-1.5 rounded-full bg-good shadow-[0_0_8px_var(--good)]" /> Connected</Chip>
            {s.battery != null && <Chip>{s.charging ? <BatteryCharging className="h-3.5 w-3.5 text-good" /> : null}{s.battery}%{s.charging ? ' · charging' : ''}</Chip>}
            <Chip><ShieldCheck className="h-3.5 w-3.5 text-good" /> Encrypted</Chip>
            {s.unrestricted === false && (
              <span title="Android pauses DropWave a few minutes after the phone locks. On the phone: DropWave › Home › “Keep working when the phone is locked” › Allow.">
                <Chip><Lock className="h-3.5 w-3.5 text-warn" /> May sleep when locked</Chip>
              </span>
            )}
            {s.off?.length > 0 && (
              <span title={`Switched off on the phone (DropWave › Privacy): ${s.off.join(', ')}`}>
                <Chip><Lock className="h-3.5 w-3.5 text-warn" /> {s.off.length} switched off on the phone</Chip>
              </span>
            )}
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}

function Chip({ children }) {
  return <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-bg-2/70 px-2.5 text-[12px] font-medium text-muted">{children}</span>;
}

const fmtTime = (s) => (s == null || !isFinite(s) ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

// The phone's media volume: - / slider / +, and mute.
function VolumeRow({ phone }) {
  const s = phone.status || {};
  const [drag, setDrag] = useState(null); // value while the slider is held
  if (s.volume == null || !s.volumeMax) return null;
  const v = drag ?? s.volume;
  const send = (cmd) => api.phoneCmd(phone.id, { type: 'volume', ...cmd }).catch(() => {});
  const Icon = s.muted || v === 0 ? VolumeX : v < s.volumeMax / 2 ? Volume1 : Volume2;
  return (
    <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3">
      <IconBtn title={s.muted ? 'Unmute' : 'Mute'} onClick={() => send({ action: 'mute' })}><Icon className={`h-4 w-4 ${s.muted ? 'text-bad' : ''}`} /></IconBtn>
      <IconBtn title="Volume down" onClick={() => send({ action: 'down' })}><Minus className="h-3.5 w-3.5" /></IconBtn>
      <input type="range" min="0" max={s.volumeMax} step="1" value={s.muted ? 0 : v} aria-label="Phone volume"
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={(e) => { send({ action: 'set', value: Number(e.currentTarget.value) }); setTimeout(() => setDrag(null), 400); }}
        onKeyUp={(e) => { send({ action: 'set', value: Number(e.currentTarget.value) }); setTimeout(() => setDrag(null), 400); }}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]" />
      <IconBtn title="Volume up" onClick={() => send({ action: 'up' })}><Plus className="h-3.5 w-3.5" /></IconBtn>
      <span className="w-9 text-right text-[11px] text-faint tabular">{s.muted ? 'muted' : `${Math.round((v / s.volumeMax) * 100)}%`}</span>
    </div>
  );
}

function MediaCard({ phone }) {
  const m = phone.media;
  const now = useNow(1000);
  const cmd = (action, extra) => api.phoneCmd(phone.id, { type: 'media', action, ...extra }).catch(() => {});
  if (!m) {
    return (
      <div className="rounded-[22px] border border-line bg-raised/60 p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[var(--line)] text-faint"><Music2 className="h-5 w-5" /></span>
          <div className="min-w-0"><div className="text-[13.5px] font-semibold">Nothing playing</div><div className="text-[12px] text-faint">Music and videos on the phone show up here</div></div>
        </div>
        <VolumeRow phone={phone} />
      </div>
    );
  }
  const pos = m.pos != null ? Math.min(m.dur || Infinity, m.pos + (m.playing ? (now - m.at) / 1000 : 0)) : null;
  return (
    <div className="rounded-[22px] border border-line bg-raised/60 p-4">
      <div className="flex items-center gap-3">
        {m.art ? <img src={m.art} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" draggable={false} />
          : <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl grad-bg text-white"><Music2 className="h-5 w-5" /></span>}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold" title={m.title}>{m.title || 'Playing'}</div>
          <div className="truncate text-[12px] text-faint">{[m.artist, m.app].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      {m.dur > 0 && pos != null && (
        <div className="mt-3 flex items-center gap-2 text-[10.5px] text-faint tabular">
          <span>{fmtTime(pos)}</span>
          <div title={m.canSeek ? 'Click to jump' : undefined}
            onClick={(e) => { if (!m.canSeek) return; const r = e.currentTarget.getBoundingClientRect(); cmd('seek', { pos: ((e.clientX - r.left) / r.width) * m.dur }); }}
            className={`group/seek flex h-3 flex-1 items-center ${m.canSeek ? 'cursor-pointer' : ''}`}>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--line-strong)] group-hover/seek:h-1.5"><div className="h-full rounded-full grad-bg" style={{ width: `${(pos / m.dur) * 100}%` }} /></div>
          </div>
          <span>{fmtTime(m.dur)}</span>
        </div>
      )}
      <div className="mt-2 flex items-center justify-center gap-2">
        <IconBtn title="Previous" onClick={() => cmd('prev')}><SkipBack className="h-4 w-4" /></IconBtn>
        <button title={m.playing ? 'Pause' : 'Play'} onClick={() => cmd('toggle')}
          className="no-drag grid h-10 w-10 place-items-center rounded-full grad-bg text-white shadow-[0_8px_20px_-8px_var(--glow)] active:scale-95">
          {m.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
        </button>
        <IconBtn title="Next" onClick={() => cmd('next')}><SkipForward className="h-4 w-4" /></IconBtn>
      </div>
      <VolumeRow phone={phone} />
    </div>
  );
}

function IconBtn({ children, className = '', ...rest }) {
  return <button className={`no-drag grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-[var(--line)] hover:text-fg active:scale-95 ${className}`} {...rest}>{children}</button>;
}

function Tiles({ phone, onPick, onText, onCall, toast }) {
  const peer = { id: phone.id, name: phone.name, web: true, kind: 'phone' };
  const sendClip = async () => {
    const text = await api.readClipboard();
    if (!text) return toast('The clipboard is empty', 'error');
    try { await api.phoneCmd(phone.id, { type: 'clip', text }); toast(`Clipboard sent to ${phone.name}`); } catch (e) { toast(e.message, 'error'); }
  };
  const ring = async () => {
    try { await api.phoneCmd(phone.id, { type: 'ring', on: !phone.ringing }); } catch (e) { toast(e.message, 'error'); }
  };
  const tiles = [
    { Icon: MonitorSmartphone, label: 'Screen', sub: 'see and control it', onClick: () => api.mirrorStart(phone.id).catch((e) => toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')) },
    { Icon: Send, label: 'Send files', sub: 'or drop them here', onClick: () => onPick(peer, 'files') },
    { Icon: ClipboardCopy, label: 'Clipboard', sub: 'send what you copied', onClick: sendClip },
    { Icon: BellRing, label: phone.ringing ? 'Stop' : 'Find phone', sub: phone.ringing ? 'ringing now…' : 'even on silent', onClick: ring, on: phone.ringing },
    { Icon: Phone, label: 'Call', sub: 'voice over Wi-Fi', onClick: () => onCall(peer, 'audio') },
  ];
  return (
    <div className="@container"><div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(96px,1fr))]">
      {tiles.map(({ Icon, label, sub, onClick, on }) => (
        <button key={label} onClick={onClick}
          className={`no-drag group flex h-[104px] min-w-0 flex-col justify-between rounded-2xl border p-3.5 text-left transition active:scale-[.98] ${on ? 'border-accent bg-accent/12 shadow-[0_0_0_3px_var(--glow)]' : 'border-line bg-raised/60 hover:border-line-strong hover:bg-raised'}`}>
          <span className={`grid h-9 w-9 place-items-center rounded-xl ${on ? 'grad-bg text-white' : 'bg-accent/12 text-accent'}`}>
            <Icon className={`h-[18px] w-[18px] ${on ? 'animate-pulse' : ''}`} />
          </span>
          <span>
            <span className="block truncate text-[13px] font-semibold" title={label}>{label}</span>
            <span className="hidden truncate text-[11.5px] text-faint @[780px]:block">{sub}</span>
          </span>
        </button>
      ))}
    </div></div>
  );
}

// ---------- notifications ----------

function AppIcon({ phone, n, size = 36 }) {
  const src = phone.icons?.[n.pkg];
  if (src) return <img src={src} alt="" style={{ width: size, height: size }} className="shrink-0 self-start rounded-xl bg-white/85 object-contain p-1" draggable={false} />;
  return <Avatar id={n.pkg || n.app} name={n.app || '?'} size={size} />;
}

function Notifications({ phone, toast }) {
  const list = phone.notifs || [];
  const s = phone.status || {};
  const clear = () => api.phoneCmd(phone.id, { type: 'notif', action: 'clear' }).catch((e) => toast(e.message, 'error'));
  return (
    <section className="rounded-[22px] border border-line bg-raised/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 font-display text-[15px] font-semibold">Notifications{list.length > 0 && <span className="rounded-full bg-accent/15 px-2 text-[11px] font-semibold text-accent tabular">{list.length}</span>}</div>
        {list.length > 1 && <Button variant="ghost" className="h-8" onClick={clear}><X className="h-4 w-4" /> Clear all</Button>}
      </div>
      {!s.notifAccess ? (
        <div className="flex items-start gap-3 rounded-2xl border border-dashed border-line-strong p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--line)] text-faint"><BellOff className="h-[18px] w-[18px]" /></span>
          <div className="text-[13px] text-muted">
            <div className="font-semibold text-fg">Turn on notification access on the phone</div>
            In the DropWave app, tap <b>Show phone notifications on PC</b> and allow DropWave. Android asks once; you can turn it off there any time.
          </div>
        </div>
      ) : list.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-faint">No notifications. You’re all caught up.</div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {list.map((n) => <NotifRow key={n.key} phone={phone} n={n} toast={toast} />)}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

function NotifRow({ phone, n, toast }) {
  const [replying, setReplying] = useState(null); // action index
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const send = (cmd) => api.phoneCmd(phone.id, { type: 'notif', key: n.key, ...cmd }).catch((e) => toast(e.message, 'error'));
  const copy = async () => { await api.writeClipboard(n.code); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const reply = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    await send({ action: 'reply', i: replying, text: text.trim() });
    setReplying(null); setText('');
    toast('Reply sent');
  };
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 30 }}
      className="group flex gap-3 rounded-2xl border border-line bg-bg-2/50 p-3.5">
      <AppIcon phone={phone} n={n} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
          <span className="truncate font-medium">{n.app}</span><span>·</span><span className="shrink-0">{timeAgo(n.time)}</span>
        </div>
        {n.title && <div className="truncate text-[13.5px] font-semibold">{n.title}</div>}
        {n.text && <div className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] text-muted select-text">{n.text}</div>}
        {(n.code || n.actions.length > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {n.code && (
              <button onClick={copy} className="no-drag inline-flex h-8 items-center gap-1.5 rounded-lg grad-bg px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_-6px_var(--glow)] active:scale-95">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : `Copy code ${n.code}`}
              </button>
            )}
            {n.actions.map((a) => (
              <button key={a.i} onClick={() => (a.reply ? setReplying(replying === a.i ? null : a.i) : send({ action: 'act', i: a.i }))}
                className="no-drag inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-raised px-3 text-[12.5px] font-medium hover:border-line-strong active:scale-95">
                {a.reply && <Reply className="h-3.5 w-3.5" />} {a.title}
              </button>
            ))}
          </div>
        )}
        {replying != null && (
          <form onSubmit={reply} className="mt-2 flex gap-2">
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${n.title || n.app}…`}
              className="h-9 min-w-0 flex-1 rounded-xl border border-line-strong bg-raised px-3 text-[13px] outline-none focus:border-accent" />
            <Button type="submit" variant="primary" className="h-9"><Send className="h-4 w-4" /></Button>
          </form>
        )}
      </div>
      <IconBtn title="Dismiss" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => send({ action: 'dismiss' })}><X className="h-4 w-4" /></IconBtn>
    </motion.div>
  );
}

// ---------- side column ----------

function RemoteCard({ phone }) {
  const r = phone.remote || {};
  return (
    <section className={`rounded-[22px] border p-5 ${r.active ? 'border-warn/60 bg-warn/10' : 'border-line bg-raised/60'}`}>
      <div className="flex items-center gap-3">
        <span className={`grid h-10 w-10 place-items-center rounded-xl ${r.allowed ? 'grad-bg text-white' : 'bg-[var(--line)] text-faint'}`}><MousePointer2 className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">Phone as touchpad</div>
          <div className="text-[12px] text-faint">{r.active ? `${phone.name} is using your mouse` : r.allowed ? (r.always ? 'Always allowed' : 'Allowed until DropWave restarts') : 'Asks you first'}</div>
        </div>
      </div>
      <p className="mt-3 text-[12px] text-muted">
        In the app, <b>Control PC</b> turns the phone into a touchpad, keyboard and a Deck of shortcuts (media, volume, lock, sleep).
      </p>
      {r.allowed && (
        <Button variant={r.active ? 'primary' : 'soft'} className="mt-3 w-full" onClick={() => api.remoteRevoke(phone.id)}>
          <Lock className="h-4 w-4" /> {r.active ? 'Stop now' : 'Stop allowing'}
        </Button>
      )}
    </section>
  );
}

const TL_ICON = { 'clip-in': ClipboardPaste, 'clip-out': ClipboardCopy, ring: BellRing, remote: Keyboard, in: ArrowDownLeft, out: ArrowUpRight, missed: Phone, dial: Phone, backup: ArrowDownLeft };

function TimelineCard({ timeline, history, onSeeAll }) {
  useNow(30000);
  const items = useMemo(() => {
    const transfers = history.slice(0, 12).map((t) => ({
      id: t.id, at: t.finishedAt || t.startedAt, kind: t.direction,
      title: t.count === 1 ? t.files?.[0]?.name?.split(/[\\/]/).pop() : `${t.count} files`,
      sub: `${t.direction === 'out' ? 'To' : 'From'} ${(t.direction === 'out' ? t.to : t.from)?.name || ''}${t.status !== 'completed' ? ` · ${t.status}` : ''}`,
    }));
    const events = timeline.map((e) => ({
      id: e.id, at: e.at, kind: e.kind,
      title: { 'clip-in': 'Clipboard from phone', 'clip-out': 'Clipboard to phone', ring: 'Find phone', remote: 'Touchpad', missed: 'Missed call', dial: 'Call from PC', backup: 'Photo backup' }[e.kind] || 'Event',
      sub: `${e.peer?.name ? `${e.peer.name} · ` : ''}${e.text || ''}`,
    }));
    return [...transfers, ...events].sort((a, b) => b.at - a.at).slice(0, 8);
  }, [timeline, history]);
  return (
    <section className="rounded-[22px] border border-line bg-raised/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 font-display text-[15px] font-semibold"><History className="h-4 w-4 text-faint" /> Timeline</div>
        <button onClick={onSeeAll} className="no-drag text-[12px] font-medium text-accent hover:underline">View all</button>
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center text-[12.5px] text-faint">Files, clipboard and more will show up here.</div>
      ) : (
        <div className="relative space-y-3 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-[var(--line-strong)]">
          {items.map((i) => {
            const Icon = TL_ICON[i.kind] || Sparkles;
            return (
              <div key={i.id} className="relative flex items-start gap-3">
                <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-panel-solid text-accent"><Icon className="h-3.5 w-3.5" /></span>
                <div className="min-w-0 pt-0.5">
                  <div className="truncate text-[13px] font-medium" title={i.title}>{i.title}</div>
                  <div className="truncate text-[11.5px] text-faint" title={i.sub}>{i.sub} · {timeAgo(i.at)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Title bar: who is using (or may use, until restart) this PC's mouse and keyboard, with Stop.
export function RemotePill({ remote }) {
  const show = remote.filter((r) => r.active || !r.always);
  if (!show.length) return null;
  const r = show.find((x) => x.active) || show[0];
  return (
    <div className={`no-drag flex h-8 items-center gap-2 rounded-xl border pl-2.5 pr-1 text-[12px] font-medium ${r.active ? 'border-warn/60 bg-warn/15 text-fg' : 'border-line bg-raised/60 text-muted'}`}>
      <MousePointer2 className={`h-3.5 w-3.5 ${r.active ? 'text-warn' : ''}`} />
      <span className="max-w-[220px] truncate">{r.active ? `${r.name} is using your mouse` : `${r.name} can use your mouse`}</span>
      <button onClick={() => api.remoteRevoke(r.id)} className="h-6 rounded-lg bg-bad px-2 text-[11.5px] font-semibold text-white hover:brightness-110">Stop</button>
    </div>
  );
}

// ---------- "may this phone use your mouse?" ----------

export function RemoteAskModal({ ask }) {
  const answer = (allow, always) => api.remoteRespond(ask.id, allow, always);
  return (
    <Modal onClose={() => answer(false)}>
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-2xl grad-bg text-white shadow-[0_10px_26px_-10px_var(--glow)]"><MousePointer2 className="h-6 w-6" /></span>
        <div className="min-w-0">
          <div className="font-display text-[18px] font-semibold">{ask.name} wants to use your mouse and keyboard</div>
          <div className="text-[12.5px] text-muted">As a touchpad, keyboard and Deck (media, volume, lock, sleep).</div>
        </div>
      </div>
      <p className="mt-4 rounded-xl border border-line bg-bg-2/60 p-3 text-[12.5px] text-muted">
        Only allow your own phone. You can stop it any time from Home.
      </p>
      <div className="mt-5 grid grid-cols-3 gap-2">
        <Button variant="soft" onClick={() => answer(false)}>Deny</Button>
        <Button variant="soft" onClick={() => answer(true, false)}>Allow once</Button>
        <Button variant="primary" onClick={() => answer(true, true)}>Always allow</Button>
      </div>
    </Modal>
  );
}
