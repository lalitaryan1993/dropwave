import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Tv, Power, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Undo2, House, Play, Pause, SkipBack, SkipForward, Rewind, FastForward, Square,
  Volume2, VolumeX, Plus, Minus, Settings as Cog, Keyboard, Pencil, Trash2, Loader2, Search, Info, Captions, AudioLines, LayoutGrid, Menu, Mic, Unplug, RefreshCw, Link2,
} from 'lucide-react';
import { api } from './lib.js';
import { Button } from './components.jsx';

// Android key codes (what the TV understands).
const K = { UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, OK: 23, BACK: 4, HOME: 3, MENU: 82, VOL_UP: 24, VOL_DOWN: 25, MUTE: 164, POWER: 26, PLAY_PAUSE: 85, PLAY: 126, PAUSE: 127,
  NEXT: 87, PREV: 88, REW: 89, FF: 90, STOP: 86, CH_UP: 166, CH_DOWN: 167, INPUT: 178, SETTINGS: 176, SEARCH: 84, DEL: 67, ENTER: 66, INFO: 165, GUIDE: 172, CAPTIONS: 175, AUDIO: 222,
  ALL_APPS: 284, LAST_CH: 229, RED: 183, GREEN: 184, YELLOW: 185, BLUE: 186, MOVE_END: 123 };
const L = (pkg) => `market://launch?id=${pkg}`;
const APPS = [['YouTube', 'https://www.youtube.com', '#ff0033'], ['Netflix', 'https://www.netflix.com/title', '#e50914'], ['Prime Video', 'https://app.primevideo.com', '#1a98ff'],
  ['JioHotstar', 'https://www.hotstar.com', '#1f3bd6'], ['Spotify', 'https://open.spotify.com', '#1db954'], ['YT Music', 'https://music.youtube.com', '#ff4e45'],
  ['JioCinema', 'https://www.jiocinema.com', '#d6007e'], ['Zee5', 'https://www.zee5.com', '#8230c6'], ['SonyLIV', 'https://www.sonyliv.com', '#334155']];
const PKG = { 'com.google.android.youtube.tv': 'YouTube', 'com.netflix.ninja': 'Netflix', 'com.amazon.amazonvideo.livingroom': 'Prime Video', 'in.startv.hotstar': 'JioHotstar', 'com.spotify.tv.android': 'Spotify', 'com.google.android.tvlauncher': 'Home', 'com.google.android.apps.tv.launcherx': 'Home', 'com.mitv.tvhome.atv': 'Home', 'com.android.tv.settings': 'Settings' };
const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// A key that repeats while held (arrows, volume).
function useHold(code, send, repeat) {
  const t = useRef([]);
  const stop = () => { clearTimeout(t.current[0]); clearInterval(t.current[1]); };
  const start = (e) => { e.preventDefault(); send(code); if (repeat) t.current[0] = setTimeout(() => { t.current[1] = setInterval(() => send(code), 110); }, 380); };
  useEffect(() => stop, []);
  return { onPointerDown: start, onPointerUp: stop, onPointerLeave: stop };
}

function Key({ code, send, repeat, className = '', children, title }) {
  const h = useHold(code, send, repeat);
  return <button {...h} title={title} aria-label={title} className={`no-drag grid place-items-center rounded-2xl border border-line bg-raised text-fg transition active:scale-95 active:bg-[var(--line)] ${className}`}>{children}</button>;
}

function Dpad({ send }) {
  const dir = (code, cls, Icon, title) => {
    const h = useHold(code, send, true);
    return <button {...h} title={title} aria-label={title} className={`absolute grid place-items-center text-muted transition hover:text-fg active:scale-90 active:text-accent ${cls}`}><Icon className="h-8 w-8" /></button>;
  };
  return (
    <div className="relative mx-auto aspect-square w-[min(260px,72cqw)] rounded-full border border-line-strong bg-gradient-to-b from-raised to-[var(--panel)] shadow-[0_30px_60px_-30px_rgba(0,0,0,.6)]">
      {dir(K.UP, 'left-[30%] top-0 h-[30%] w-[40%]', ChevronUp, 'Up (↑)')}
      {dir(K.DOWN, 'bottom-0 left-[30%] h-[30%] w-[40%]', ChevronDown, 'Down (↓)')}
      {dir(K.LEFT, 'left-0 top-[30%] h-[40%] w-[30%]', ChevronLeft, 'Left (←)')}
      {dir(K.RIGHT, 'right-0 top-[30%] h-[40%] w-[30%]', ChevronRight, 'Right (→)')}
      <button onPointerDown={() => send(K.OK)} title="OK (Enter)" className="grad-bg absolute inset-[31%] rounded-full text-[17px] font-extrabold tracking-wide text-white shadow-[0_16px_30px_-14px_var(--glow)] transition active:scale-95">OK</button>
    </div>
  );
}

function Rocker({ up, down, label, send }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-3xl border border-line bg-raised">
      <Key code={up} send={send} repeat className="h-14 rounded-none border-0" title={`${label} up`}><Plus className="h-5 w-5" /></Key>
      <div className="py-1 text-center text-[10.5px] font-extrabold tracking-[.1em] text-faint">{label}</div>
      <Key code={down} send={send} repeat className="h-14 rounded-none border-0" title={`${label} down`}><Minus className="h-5 w-5" /></Key>
    </div>
  );
}

// Mouse pad: drag to move the TV's selection, wheel to scroll, click = OK, right-click = Back.
// (Android TV has no mouse pointer over the remote protocol; this works on every TV.)
function MousePad({ send }) {
  const ref = useRef(null);
  const st = useRef({ down: false, x: 0, y: 0, moved: false, wheel: 0 });
  const [dot, setDot] = useState(null);
  const step = 46;
  const onDown = (e) => { if (e.button === 2) return; ref.current.setPointerCapture(e.pointerId); Object.assign(st.current, { down: true, x: e.clientX, y: e.clientY, moved: false }); };
  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect(); setDot({ x: e.clientX - r.left, y: e.clientY - r.top });
    const s = st.current; if (!s.down) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= step) { s.moved = true; send(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? K.RIGHT : K.LEFT) : (dy > 0 ? K.DOWN : K.UP)); s.x = e.clientX; s.y = e.clientY; }
  };
  const onUp = () => { const s = st.current; if (s.down && !s.moved) send(K.OK); s.down = false; };
  const onWheel = (e) => { const s = st.current; s.wheel += e.deltaY; if (Math.abs(s.wheel) >= 60) { send(s.wheel > 0 ? K.DOWN : K.UP); s.wheel = 0; } };
  return (
    <div ref={ref} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => { setDot(null); st.current.down = false; }} onWheel={onWheel}
      onContextMenu={(e) => { e.preventDefault(); send(K.BACK); }}
      className="relative mx-auto grid aspect-[4/3] w-[min(340px,80cqw)] cursor-none select-none place-items-center overflow-hidden rounded-[28px] border border-line-strong bg-gradient-to-b from-raised to-[var(--panel)] text-center shadow-[0_30px_60px_-30px_rgba(0,0,0,.6)]">
      <div className="pointer-events-none px-6 text-[12.5px] leading-relaxed text-faint"><b className="block text-[14px] text-fg">Mouse pad</b>Drag to move on the TV · scroll for up / down<br />Click = OK · right-click = Back</div>
      {dot && <span className="pointer-events-none absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,var(--accent),transparent_70%)] opacity-60" style={{ left: dot.x, top: dot.y }} />}
    </div>
  );
}

export function TvView({ toast }) {
  const [list, setList] = useState({ saved: [], found: [], active: null, state: {} });
  const [pair, setPair] = useState(null); // { host, name, stage: 'asking'|'code', err }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  const [state, setState] = useState({});
  const [typed, setTyped] = useState('');
  const [mode, setMode] = useState(() => { try { return localStorage.getItem('dw_tv_pc_mode') || 'dpad'; } catch { return 'dpad'; } });
  const pickMode = (m) => { setMode(m); try { localStorage.setItem('dw_tv_pc_mode', m); } catch {} };
  const sentRef = useRef('');
  const panel = useRef(null);

  useEffect(() => {
    api.tvFind(true).then(setList).catch(() => {});
    const off = api.onTv((e) => {
      if (e.type === 'list') setList(e);
      if (e.type === 'state') setState({ ...e.state });
      if (e.type === 'closed') toast?.('The TV disconnected', 'error');
    });
    return () => { off(); api.tvFind(false).catch(() => {}); };
  }, [toast]);

  const active = list.saved.find((t) => t.host === list.active);
  const send = useCallback((code, dir) => { api.tvKey(code, dir).catch((e) => toast?.(clean(e), 'error')); }, [toast]);

  const open = async (t) => {
    setBusy(t.host);
    try { setList(await api.tvOpen(t.host)); setState({}); }
    catch (e) { if (clean(e) === 'pair') startPair(t); else toast?.(clean(e), 'error'); }
    finally { setBusy(null); }
  };
  const startPair = async (t) => {
    setPair({ host: t.host, name: t.name, stage: 'asking' }); setCode('');
    try { await api.tvPair(t.host, t.name); setPair({ host: t.host, name: t.name, stage: 'code' }); }
    catch (e) { setPair({ host: t.host, name: t.name, stage: 'code', err: clean(e) }); }
  };
  const finishPair = async (c) => {
    try { await api.tvCode(c); const t = { host: pair.host, name: pair.name }; setPair(null); toast?.(`Paired with ${t.name}`); await open(t); }
    catch (e) { setPair((p) => ({ ...p, err: clean(e) })); setCode(''); }
  };

  // PC keyboard drives the TV while the remote is focused (not while typing in the text box).
  useEffect(() => {
    if (!active) return;
    const map = { ArrowUp: K.UP, ArrowDown: K.DOWN, ArrowLeft: K.LEFT, ArrowRight: K.RIGHT, Enter: K.OK, Backspace: K.BACK, Escape: K.BACK, Home: K.HOME, ' ': K.PLAY_PAUSE, '+': K.VOL_UP, '=': K.VOL_UP, '-': K.VOL_DOWN, m: K.MUTE, M: K.MUTE, PageUp: K.CH_UP, PageDown: K.CH_DOWN };
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
      if (!panel.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      const c = map[e.key] ?? (/^[0-9]$/.test(e.key) ? 7 + Number(e.key) : null);
      if (c == null || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault(); send(c);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, send]);

  // Typing: only what changed reaches the TV (new letters typed, removed ones deleted).
  const onType = (v) => {
    setTyped(v);
    const old = sentRef.current; let k = 0;
    while (k < v.length && k < old.length && v[k] === old[k]) k++;
    for (let d = old.length - k; d > 0; d--) send(K.DEL);
    const add = v.slice(k); if (add) api.tvText(add).catch(() => {});
    sentRef.current = v;
  };
  const clearTv = () => { send(K.MOVE_END); for (let k = 0; k < 60; k++) send(K.DEL); sentRef.current = ''; setTyped(''); };
  const searchYouTube = () => { if (!typed.trim()) return; api.tvLaunch(`https://www.youtube.com/results?search_query=${encodeURIComponent(typed.trim())}`).then(() => toast?.(`Searching YouTube for “${typed.trim()}”`)).catch((e) => toast?.(clean(e), 'error')); };

  const rename = async (t) => { const n = prompt('Name this TV', t.name); if (n && n.trim()) setList(await api.tvRename(t.host, n.trim())); };
  const forget = async (t) => { if (confirm(`Forget ${t.name}? You’ll need its code again to pair.`)) setList(await api.tvForget(t.host)); };

  const vol = state.volume;
  const appName = state.app ? PKG[state.app] || state.app.split('.').pop() : null;

  return (
    <div className="flex h-full min-h-0">
      {/* TVs */}
      <aside className="flex w-[240px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-line p-4 2xl:w-[300px] 2xl:p-5">
        <div className="mb-1 flex items-center gap-2">
          <div className="font-display text-[20px] font-semibold tracking-tight">TVs</div>
          <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-faint"><RefreshCw className="h-3.5 w-3.5 animate-spin [animation-duration:3s]" />Looking</span>
        </div>
        {list.saved.map((t) => (
          <motion.div layout key={t.host} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            className={`group flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition ${t.active ? 'border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]' : 'border-line bg-raised hover:border-line-strong'}`}>
            <button onClick={() => (t.active ? null : open(t))} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <span className="grad-bg relative grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white">
                {busy === t.host ? <Loader2 className="h-5 w-5 animate-spin" /> : <Tv className="h-5 w-5" />}
                <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-[var(--panel-solid)] ${t.on || t.active ? 'bg-good' : 'bg-[var(--line-strong)]'}`} />
              </span>
              <span className="min-w-0"><span className="block truncate text-[14px] font-semibold">{t.name}</span><span className="block truncate text-[11.5px] text-faint">{t.active ? 'Controlling now' : t.on ? 'On · click to control' : t.host}</span></span>
            </button>
            <div className="hidden shrink-0 group-hover:flex">
              <button onClick={() => rename(t)} title="Rename" className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-[var(--line)] hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
              <button onClick={() => forget(t)} title="Forget" className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-[var(--line)] hover:text-bad"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </motion.div>
        ))}
        {list.found.length > 0 && <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-faint">Found on this network</div>}
        {list.found.map((t) => (
          <motion.button layout key={t.host} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} onClick={() => startPair(t)}
            className="flex items-center gap-3 rounded-2xl border border-dashed border-line-strong px-3 py-2.5 text-left transition hover:border-accent">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--line)]"><Tv className="h-5 w-5 text-accent" /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold">{t.name}</span><span className="text-[11.5px] text-faint">Click to pair</span></span>
            <Link2 className="h-4 w-4 text-accent" />
          </motion.button>
        ))}
        {!list.saved.length && !list.found.length && (
          <div className="mt-2 rounded-2xl border border-line bg-raised p-4 text-[12.5px] leading-relaxed text-muted">
            Turn your Android TV or Google TV on, on the same Wi-Fi as this PC. It shows up here by itself. The first time, type the code the TV shows.
          </div>
        )}
      </aside>

      {/* remote */}
      <section ref={panel} tabIndex={-1} className="@container relative min-w-0 flex-1 overflow-y-auto p-5 outline-none @4xl:p-6">
        {!active ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="grad-bg mx-auto grid h-24 w-36 place-items-center rounded-2xl text-white shadow-[0_30px_60px_-30px_var(--glow)]"><Tv className="h-10 w-10" /></motion.div>
              <div className="mx-auto mt-2 h-2 w-12 rounded bg-[var(--line-strong)]" />
              <div className="mt-5 font-display text-[22px] font-semibold tracking-tight">Control your TV from this PC</div>
              <div className="mx-auto mt-1 max-w-sm text-[13px] text-muted">Android TV and Google TV: Sony, Mi, OnePlus, TCL, Hisense, Chromecast… Pick a TV on the left. Arrow keys, Enter and Backspace work like the remote.</div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[920px]">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-[22px] font-semibold tracking-tight">{active.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-faint">
                  <span className="h-2 w-2 rounded-full bg-good shadow-[0_0_8px_var(--good)]" />{state.on === false ? 'TV is off' : 'Connected'}
                  {appName && <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-[11px] font-semibold text-muted">{appName}</span>}
                  {vol && <span className="flex items-center gap-1.5">{vol.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}<span className="h-1.5 w-20 overflow-hidden rounded bg-[var(--line)]"><span className="grad-bg block h-full transition-all" style={{ width: `${vol.max ? (vol.level / vol.max) * 100 : 0}%` }} /></span>{vol.level}</span>}
                </div>
              </div>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={async () => setList(await api.tvClose())} title="Disconnect"><Unplug className="h-4 w-4" /></Button>
                <Key code={K.POWER} send={send} title="Power" className="h-10 w-10 text-bad"><Power className="h-5 w-5" /></Key>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 items-start gap-5 @xl:grid-cols-2 @5xl:grid-cols-[minmax(230px,1fr)_auto_minmax(230px,1fr)] @5xl:gap-6">
              {/* left: system + numbers */}
              <div className="order-2 min-w-0 space-y-3 @5xl:order-1">
                <div className="grid grid-cols-3 gap-2">
                  <Key code={K.BACK} send={send} className="h-14 flex-col gap-0.5 text-[11px] font-semibold text-muted" title="Back (Backspace)"><Undo2 className="h-5 w-5 text-fg" />Back</Key>
                  <Key code={K.HOME} send={send} className="h-14 flex-col gap-0.5 text-[11px] font-semibold text-muted" title="Home"><House className="h-5 w-5 text-fg" />Home</Key>
                  <Key code={K.MENU} send={send} className="h-14 flex-col gap-0.5 text-[11px] font-semibold text-muted" title="Menu"><Menu className="h-5 w-5 text-fg" />Menu</Key>
                  <Key code={K.INPUT} send={send} className="h-12 text-[12px] font-semibold" title="Input">Input</Key>
                  <Key code={K.ALL_APPS} send={send} className="h-12 flex-col gap-0.5 text-[11px] font-semibold" title="All apps"><LayoutGrid className="h-4 w-4" /></Key>
                  <button onClick={() => { send(K.SETTINGS); toast?.('Sent Settings. If nothing opens: Home, then the ⚙️ at the top.'); }} title="Settings" className="grid h-12 place-items-center rounded-2xl border border-line bg-raised transition active:scale-95"><Cog className="h-5 w-5" /></button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => <Key key={d} code={7 + d} send={send} className="h-11 text-[17px] font-bold" title={String(d)}>{d}</Key>)}
                  <Key code={K.LAST_CH} send={send} className="h-11 text-[11px] font-semibold" title="Last channel">Last</Key>
                  <Key code={7} send={send} className="h-11 text-[17px] font-bold" title="0">0</Key>
                  <Key code={K.INFO} send={send} className="h-11" title="Info"><Info className="h-4 w-4" /></Key>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[[K.RED, '#ef4444'], [K.GREEN, '#22c55e'], [K.YELLOW, '#eab308'], [K.BLUE, '#3b82f6']].map(([c, col]) => <Key key={c} code={c} send={send} className="h-9" title="Colour button"><span className="h-4 w-8 rounded" style={{ background: col }} /></Key>)}
                </div>
              </div>

              {/* middle: D-pad */}
              <div className="order-1 pt-2 @xl:col-span-2 @5xl:order-2 @5xl:col-span-1">
                <div className="mx-auto mb-3 flex w-max gap-1 rounded-xl border border-line bg-[var(--line)] p-1 text-[12px] font-semibold">
                  {[['dpad', 'Buttons'], ['pad', 'Mouse pad']].map(([m, n]) => <button key={m} onClick={() => pickMode(m)} className={`rounded-lg px-3 py-1.5 transition ${mode === m ? 'bg-raised text-fg shadow' : 'text-muted hover:text-fg'}`}>{n}</button>)}
                </div>
                {mode === 'pad' ? <MousePad send={send} /> : <Dpad send={send} />}
                <div className="mx-auto mt-3 max-w-[300px] text-center text-[11px] leading-relaxed text-faint">Keyboard: ↑ ↓ ← → · Enter = OK · Backspace = Back · Space = Play · + / − volume</div>
              </div>

              {/* right: volume, channel, media */}
              <div className="order-3 min-w-0 space-y-3">
                <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
                  <Rocker up={K.VOL_UP} down={K.VOL_DOWN} label="VOL" send={send} />
                  <div className="flex flex-col gap-2">
                    <Key code={K.MUTE} send={send} className="h-[60px] w-14" title="Mute (M)"><VolumeX className="h-5 w-5" /></Key>
                    <Key code={K.GUIDE} send={send} className="h-[60px] w-14 text-[11px] font-semibold" title="Guide">Guide</Key>
                  </div>
                  <Rocker up={K.CH_UP} down={K.CH_DOWN} label="CH" send={send} />
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <Key code={K.PREV} send={send} className="h-11" title="Previous"><SkipBack className="h-4 w-4" /></Key>
                  <Key code={K.REW} send={send} className="h-11" title="Rewind"><Rewind className="h-4 w-4" /></Key>
                  <Key code={K.FF} send={send} className="h-11" title="Fast forward"><FastForward className="h-4 w-4" /></Key>
                  <Key code={K.NEXT} send={send} className="h-11" title="Next"><SkipForward className="h-4 w-4" /></Key>
                  <Key code={K.PLAY} send={send} className="h-11" title="Play"><Play className="h-4 w-4" /></Key>
                  <Key code={K.PLAY_PAUSE} send={send} className="grad-bg h-11 border-0 text-white" title="Play / pause (Space)"><Play className="h-4 w-4" /><Pause className="-ml-1 h-4 w-4" /></Key>
                  <Key code={K.PAUSE} send={send} className="h-11" title="Pause"><Pause className="h-4 w-4" /></Key>
                  <Key code={K.STOP} send={send} className="h-11" title="Stop"><Square className="h-4 w-4" /></Key>
                  <Key code={K.CAPTIONS} send={send} className="col-span-2 h-11 gap-1.5 text-[12px] font-semibold" title="Subtitles"><Captions className="h-4 w-4" />Subtitles</Key>
                  <Key code={K.AUDIO} send={send} className="col-span-2 h-11 gap-1.5 text-[12px] font-semibold" title="Audio track"><AudioLines className="h-4 w-4" />Audio</Key>
                </div>
              </div>
            </div>

            {/* typing */}
            <div className="mt-7 rounded-3xl border border-line bg-raised p-4">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><Keyboard className="h-4 w-4 text-accent" />Type on the TV<span className="text-[11.5px] font-normal text-faint">· open a search box on the TV first, or search YouTube straight away</span></div>
              <div className="flex flex-wrap gap-2">
                <input value={typed} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { send(K.ENTER); } }}
                  placeholder="Type here… letters appear on the TV as you type" className="h-11 min-w-[220px] flex-1 basis-[260px] rounded-xl border border-line-strong bg-bg-2 px-3.5 text-[14px] outline-none transition focus:border-accent focus:shadow-[0_0_0_4px_var(--glow)]" />
                <Button variant="soft" className="h-11" onClick={clearTv} title="Empty the box on the TV">Clear TV box</Button>
                <Button variant="soft" className="h-11" onClick={() => send(K.ENTER)}>Enter</Button>
                <Button variant="primary" className="h-11" onClick={searchYouTube} disabled={!typed.trim()}><Search className="h-4 w-4" />YouTube</Button>
              </div>
            </div>

            {/* apps */}
            <div className="mt-6 mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-faint">Open on TV</div>
            <div className="grid grid-cols-2 gap-2 @xl:grid-cols-3 @5xl:grid-cols-5">
              {APPS.map(([n, link, c], k) => (
                <motion.button key={n} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: k * 0.03 }}
                  onClick={() => api.tvLaunch(link).then(() => toast?.(`Opening ${n} on the TV`)).catch((e) => toast?.(clean(e), 'error'))}
                  className="flex items-center gap-2.5 rounded-2xl border border-line bg-raised px-3 py-2.5 text-left text-[13px] font-semibold transition hover:border-line-strong active:scale-95">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px] font-black text-white" style={{ background: c }}>{n === 'Settings' ? <Cog className="h-4 w-4" /> : n[0]}</span>
                  <span className="truncate">{n}</span>
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* pairing */}
        <AnimatePresence>
          {pair && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-10 grid place-items-center bg-[color-mix(in_oklab,var(--bg)_80%,transparent)] backdrop-blur-sm">
              <motion.div initial={{ y: 16, scale: 0.97 }} animate={{ y: 0, scale: 1 }} className="w-[420px] rounded-3xl border border-line bg-raised p-6 text-center shadow-2xl">
                <div className="mx-auto grid h-20 w-32 place-items-center rounded-xl border-4 border-fg font-mono text-[20px] font-extrabold tracking-[.2em] text-accent">{pair.stage === 'asking' ? <Loader2 className="h-6 w-6 animate-spin" /> : 'A1B2C3'}</div>
                <div className="mt-4 font-display text-[19px] font-semibold">{pair.stage === 'asking' ? `Asking ${pair.name} for a code…` : 'Type the code on your TV'}</div>
                <div className="mt-1 text-[12.5px] text-muted">The TV shows 6 letters and numbers. Only needed the first time.</div>
                <input autoFocus value={code} maxLength={6} disabled={pair.stage === 'asking'}
                  onChange={(e) => { const v = e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6); setCode(v); setPair((p) => ({ ...p, err: null })); if (v.length === 6) finishPair(v); }}
                  className="mt-4 h-14 w-full rounded-2xl border border-line-strong bg-bg-2 text-center font-mono text-[26px] font-extrabold uppercase tracking-[.45em] outline-none focus:border-accent focus:shadow-[0_0_0_4px_var(--glow)]" placeholder="••••••" />
                <div className="mt-2 min-h-5 text-[12.5px] text-bad">{pair.err}</div>
                <div className="mt-2 flex justify-center gap-2">
                  <Button variant="ghost" onClick={() => setPair(null)}>Cancel</Button>
                  <Button variant="soft" onClick={() => startPair({ host: pair.host, name: pair.name })}><RefreshCw className="h-4 w-4" />New code</Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
