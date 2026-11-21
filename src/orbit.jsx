// Nearby, as a little 3D universe: this PC is a turning dotted globe that sends out waves; the devices
// it can reach circle it on a tilted orbit (computers inside, phones / tablets / TVs outside), bigger
// in front, smaller and dimmer behind the globe. Each is joined to the globe by a beam that runs faster
// while files move. Drop files on a device to send; click one for files, folder, chat and calls.
// The orbit stops while you drag files, hover a device or have its menu open.
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { FileUp, FolderUp, MessageCircle, Phone, Video, MonitorUp, Monitor, Loader2 } from 'lucide-react';
import { api, hueFor, initials } from './lib.js';
import { PlatformIcon } from './components.jsx';

const TILT = 0.54;   // how flat the orbit looks (1 = seen from above)
const SPEED = 0.07;  // radians a second (a lap in ~90 s)
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Points of a dotted world on a sphere: deterministic value noise decides land, so it never changes.
const WORLD = (() => {
  const rnd = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x, y, wrap) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, sm = (t) => t * t * (3 - 2 * t);
    const w = (v) => ((v % wrap) + wrap) % wrap;
    const a = rnd(w(xi), yi), b = rnd(w(xi + 1), yi), c = rnd(w(xi), yi + 1), d = rnd(w(xi + 1), yi + 1);
    return a + (b - a) * sm(xf) + (c - a) * sm(yf) + (a - b - c + d) * sm(xf) * sm(yf);
  };
  const pts = [];
  const rows = 34;
  for (let r = 1; r < rows; r++) {
    const lat = Math.PI * (r / rows - 0.5);
    const n = Math.max(6, Math.round(72 * Math.cos(lat))); // fewer points near the poles: even spacing
    for (let i = 0; i < n; i++) {
      const lon = (i / n) * Math.PI * 2;
      const u = (lon / (Math.PI * 2)) * 8, v = (r / rows) * 4;
      const val = noise(u, v, 8) * 0.68 + noise(u * 2, v * 2, 16) * 0.32;
      const land = val > 0.5 + Math.abs(lat) * 0.06;
      pts.push([Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon), land]);
    }
  }
  return pts;
})();

/** A 3D dotted globe on a canvas: land bright, sea faint, the far side fading out. */
export function Globe({ size = 132, name }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr; c.height = size * dpr;
    const ctx = c.getContext('2d');
    let raf = 0;
    const t0 = performance.now();
    const tilt = 0.32; // axis leaning toward the viewer
    const draw = (now) => {
      const a = still() ? 0.6 : ((now - t0) / 1000) * 0.25;
      const R = (size / 2) * dpr * 0.98, cx = (size / 2) * dpr, cy = cx;
      ctx.clearRect(0, 0, c.width, c.height);
      const ca = Math.cos(a), sa = Math.sin(a), ct = Math.cos(tilt), st = Math.sin(tilt);
      ctx.fillStyle = '#fff';
      for (const [x0, y0, z0, isLand] of WORLD) {
        const x = x0 * ca + z0 * sa, z1 = -x0 * sa + z0 * ca;  // spin
        const y = y0 * ct - z1 * st, z = y0 * st + z1 * ct;    // tilt
        if (z < -0.15 && !isLand) continue;
        const depth = (z + 1) / 2;
        ctx.globalAlpha = isLand ? 0.15 + depth * 0.85 : 0.05 + depth * 0.15;
        const r = (isLand ? 1.25 : 0.8) * dpr * (0.55 + depth * 0.7) * (size / 132);
        ctx.beginPath(); ctx.arc(cx + x * R, cy - y * R, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!still()) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <div className="globe-glow absolute -inset-8 rounded-full blur-2xl" style={{ background: 'radial-gradient(circle, color-mix(in oklab, var(--accent) 60%, transparent), transparent 68%)' }} />
      <div className="absolute inset-0 rounded-full" style={{
        background: 'radial-gradient(circle at 34% 30%, color-mix(in oklab, var(--accent-2) 70%, white) 0%, var(--accent-2) 18%, var(--accent) 58%, color-mix(in oklab, var(--accent) 45%, black) 100%)',
        boxShadow: '0 24px 70px -20px var(--glow), inset -10px -14px 30px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.2)',
      }} />
      <canvas ref={ref} className="relative" style={{ width: size, height: size }} />
      <div className="pointer-events-none absolute inset-0 rounded-full" style={{ background: 'radial-gradient(circle at 30% 24%, rgba(255,255,255,.4), transparent 30%)' }} />
      {name && <div className="absolute -bottom-10 whitespace-nowrap rounded-full border border-line bg-raised/85 px-3 py-1 text-[12px] font-semibold shadow-sm backdrop-blur">{name}</div>}
    </div>
  );
}

const isPc = (p) => !p.web && !['phone', 'tablet', 'tv'].includes(p.platform);

export function Orbit({ me, peers, dragging, busyPeers, onDropPaths, onPick, onText, onCall }) {
  const box = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [open, setOpen] = useState(null);
  const [over, setOver] = useState(null);
  const [hover, setHover] = useState(null);
  const nodeEls = useRef(new Map()), beamEls = useRef(new Map()), dotEls = useRef(new Map());
  const spin = useRef(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!dragging) setOver(null); }, [dragging]);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!e.target.closest?.('[data-orbit-node]')) setOpen(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const cx = size.w / 2, cy = size.h / 2 + 10;
  // Fit: the orbit is wide and flat; keep every device and its name inside the box.
  const R = Math.max(120, Math.min(size.w / 2 - 78, (size.h / 2 - 70) / TILT));
  const pcs = peers.filter(isPc), others = peers.filter((p) => !isPc(p));
  const r1 = others.length ? R * 0.68 : R * 0.9, r2 = pcs.length ? R : R * 0.9;
  const globe = Math.round(Math.min(150, Math.max(96, R * 0.46)));
  const ring = (list, r, offset) => list.map((p, i) => ({ p, r, base: offset + (i * 2 * Math.PI) / Math.max(1, list.length) }));
  const items = [...ring(pcs, r1, Math.PI / 2), ...ring(others, r2, Math.PI / 2 + (others.length > 1 ? Math.PI / others.length : Math.PI / 3))];
  const paused = dragging || !!open || !!hover;

  // Move devices along the orbit every frame without re-rendering React.
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (!paused && !still()) spin.current += dt * SPEED;
      for (const it of items) {
        const a = it.base + spin.current;
        const x = cx + Math.cos(a) * it.r, y = cy + Math.sin(a) * it.r * TILT;
        const depth = (Math.sin(a) + 1) / 2;              // 0 = far side, 1 = nearest
        const scale = 0.72 + depth * 0.42;
        const behind = Math.sin(a) < -0.15 && Math.abs(x - cx) < globe * 0.62;
        const el = nodeEls.current.get(it.p.id);
        if (el) {
          el.style.left = `${x}px`; el.style.top = `${y}px`;
          el.style.setProperty('--s', scale.toFixed(3));
          el.style.zIndex = String(open === it.p.id ? 60 : behind ? 4 : 20 + Math.round(depth * 20));
          el.style.opacity = String(behind ? 0.35 : 0.6 + depth * 0.4);
          el.style.filter = depth < 0.35 ? `blur(${((0.35 - depth) * 2.2).toFixed(2)}px)` : '';
        }
        const b = beamEls.current.get(it.p.id);
        if (b) { b.setAttribute('x2', x); b.setAttribute('y2', y); b.style.opacity = behind ? '0.12' : String(0.35 + depth * 0.6); }
        const d = dotEls.current.get(it.p.id);
        if (d) d.setAttribute('path', `M${cx},${cy} L${x},${y}`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  const waveW = 2 * R + 120;
  return (
    <div ref={box} className="relative h-full min-h-[460px] w-full select-none overflow-hidden">
      {/* waves rolling out across the orbit plane */}
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="orbit-wave" style={{ left: cx, top: cy, width: waveW, height: waveW * TILT, animationDelay: `${i * 1.2}s` }} />
      ))}
      <svg className="pointer-events-none absolute inset-0" width={size.w} height={size.h} style={{ zIndex: 3 }}>
        <defs>
          <linearGradient id="beam" gradientUnits="userSpaceOnUse" x1={cx - R} y1="0" x2={cx + R} y2="0">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--accent-2)" />
          </linearGradient>
          <radialGradient id="plate" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="var(--accent)" stopOpacity=".16" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={R + 40} ry={(R + 40) * TILT} fill="url(#plate)" />
        {[r1, r2].filter((r, k, a) => a.indexOf(r) === k).map((r, k) => (
          <ellipse key={k} className={k ? 'orbit-spin-rev' : 'orbit-spin'} cx={cx} cy={cy} rx={r} ry={r * TILT} fill="none" stroke="var(--line-strong)" strokeWidth="1.3" strokeDasharray={k ? '2 10' : '1.5 7'} strokeLinecap="round" />
        ))}
        {items.map(({ p }) => {
          const busy = busyPeers.has(p.id), hot = over === p.id || hover === p.id;
          return (
            <g key={p.id}>
              <line ref={(e) => (e ? beamEls.current.set(p.id, e) : beamEls.current.delete(p.id))} x1={cx} y1={cy} x2={cx} y2={cy}
                stroke="url(#beam)" strokeWidth={busy || hot ? 2.6 : 1.5} strokeLinecap="round" className={`orbit-beam ${busy ? 'busy' : ''}`} />
              {busy && (
                <circle r="4" fill="var(--accent-2)" style={{ filter: 'drop-shadow(0 0 6px var(--accent-2))' }}>
                  <animateMotion ref={(e) => (e ? dotEls.current.set(p.id, e) : dotEls.current.delete(p.id))} dur="1s" repeatCount="indefinite" path={`M${cx},${cy} L${cx},${cy}`} />
                </circle>
              )}
            </g>
          );
        })}
      </svg>

      <div className="absolute" style={{ left: cx, top: cy, transform: 'translate(-50%, -50%)', zIndex: 10 }}>
        <Globe size={globe} name={me?.name} />
      </div>

      {items.map(({ p }) => (
        <Node key={p.id} p={p} nodeRef={(e) => (e ? nodeEls.current.set(p.id, e) : nodeEls.current.delete(p.id))}
          busy={busyPeers.has(p.id)} dragging={dragging} over={over === p.id} open={open === p.id}
          setOpen={(v) => setOpen(v ? p.id : null)} setOver={(v) => setOver((o) => (v ? p.id : o === p.id ? null : o))}
          setHover={(v) => setHover((o) => (v ? p.id : o === p.id ? null : o))}
          onDropPaths={onDropPaths} onPick={onPick} onText={onText} onCall={onCall} />
      ))}

      <AnimatePresence>
        {dragging && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="pointer-events-none absolute left-1/2 top-3 z-[70] -translate-x-1/2 rounded-full border border-line bg-raised/90 px-4 py-1.5 text-[12.5px] font-medium shadow-lg backdrop-blur">
            Drop on a device to send
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Node({ p, nodeRef, busy, dragging, over, open, setOpen, setOver, setHover, onDropPaths, onPick, onText, onCall }) {
  const h = hueFor(p.id);
  const handlers = {
    onDragEnter: (e) => { e.preventDefault(); setOver(true); },
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!over) setOver(true); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); },
    onDrop: (e) => {
      e.preventDefault();
      e.nativeEvent.dwHandled = true;
      setOver(false);
      onDropPaths(p, api.pathsFromFiles([...e.dataTransfer.files]));
    },
  };
  const act = (fn) => () => { setOpen(false); fn(); };
  return (
    <div ref={nodeRef} data-orbit-node className="orbit-node" {...handlers}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
      style={{ left: '50%', top: '50%' }}>
      <div className="orbit-bob">
        <motion.button
          initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: over ? 1.2 : 1 }} transition={{ type: 'spring', stiffness: 380, damping: 22 }}
          onClick={() => setOpen(!open)} className="no-drag group flex flex-col items-center gap-2 outline-none"
          title={dragging ? `Drop to send to ${p.name}` : `${p.name}: click for files, chat and calls`}
        >
          <div className="relative">
            <div className="absolute -inset-3 rounded-full blur-xl transition-opacity" style={{ background: `hsl(${h} 85% 60% / .5)`, opacity: over || open || busy ? 1 : 0.4 }} />
            {/* a small sphere, lit from the top left like the globe */}
            <div className="relative grid place-items-center rounded-full font-display font-semibold text-white transition-transform group-hover:scale-105"
              style={{ width: 64, height: 64, fontSize: 21, textShadow: '0 1px 4px rgba(0,0,0,.35)',
                background: `radial-gradient(circle at 32% 28%, hsl(${h} 90% 80%) 0%, hsl(${h} 80% 60%) 30%, hsl(${(h + 50) % 360} 85% 45%) 75%, hsl(${(h + 50) % 360} 85% 30%) 100%)`,
                boxShadow: over ? `0 0 0 3px var(--bg), 0 0 0 6px hsl(${h} 85% 62%), 0 14px 30px -10px hsl(${h} 80% 40% / .8)` : `0 14px 30px -12px hsl(${h} 80% 40% / .85), inset 0 0 0 1px rgba(255,255,255,.25)` }}>
              {initials(p.name)}
              <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-raised text-fg shadow ring-2 ring-[var(--bg)]">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <PlatformIcon platform={p.web && !p.platform ? 'phone' : p.platform} className="h-3.5 w-3.5" />}
              </span>
            </div>
          </div>
          <div className="max-w-[150px] truncate rounded-full bg-raised/80 px-2.5 py-0.5 text-[12px] font-semibold shadow-sm backdrop-blur">{p.name}</div>
        </motion.button>
      </div>

      <AnimatePresence>
        {open && !dragging && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
            className="glass absolute left-1/2 top-full mt-2 w-56 -translate-x-1/2 rounded-2xl p-2 shadow-2xl"
          >
            <div className="px-2 pb-1.5 pt-0.5 text-[11.5px] text-faint">{p.ip}{p.outdated ? ' · needs an update' : ''}</div>
            <MenuItem Icon={FileUp} onClick={act(() => onPick(p, 'files'))}>Send files</MenuItem>
            <MenuItem Icon={FolderUp} onClick={act(() => onPick(p, 'folder'))}>Send a folder</MenuItem>
            <MenuItem Icon={MessageCircle} onClick={act(() => onText(p))}>Chat</MenuItem>
            {onCall && !p.outdated && <>
              <div className="my-1 h-px bg-[var(--line)]" />
              <MenuItem Icon={Phone} onClick={act(() => onCall(p, 'audio'))}>Voice call</MenuItem>
              <MenuItem Icon={Video} onClick={act(() => onCall(p, 'video'))}>Video call</MenuItem>
              <MenuItem Icon={MonitorUp} onClick={act(() => onCall(p, 'screen', 'caller'))}>Show my screen</MenuItem>
              {!p.web && <MenuItem Icon={Monitor} onClick={act(() => onCall(p, 'screen', 'callee'))}>See its screen</MenuItem>}
            </>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({ Icon, children, onClick }) {
  return (
    <button onClick={onClick} className="no-drag flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] hover:bg-[var(--line)]">
      <Icon className="h-4 w-4 text-accent" /> {children}
    </button>
  );
}
