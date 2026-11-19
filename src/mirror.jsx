// Phone screen window: decodes the phone's H.264 stream with WebCodecs (hardware) and draws it.
// Mouse: click = tap, hold = long press, drag = swipe, wheel = scroll, right-click = Back.
// Keyboard: type into the focused field, Enter, Backspace; Esc = Back; Ctrl+V pastes the PC clipboard.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Circle, Square, Camera, X, Loader2, MousePointer2, Smartphone, Bell } from 'lucide-react';
import { api } from './lib.js';

// "avc1.PPCCLL" from the SPS (first NAL of type 7 in the Annex B config).
function codecFrom(config) {
  for (let i = 0; i + 4 < config.length; i++) {
    if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3] & 0x1f) === 7) {
      const h = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${h(config[i + 4])}${h(config[i + 5])}${h(config[i + 6])}`;
    }
  }
  return 'avc1.42E029';
}

export function MirrorApp() {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get('mirror');
  const name = params.get('name') || 'Phone';
  const canvas = useRef(null);
  const [state, setState] = useState({ state: 'asking' });
  const [size, setSize] = useState(null);
  const [fps, setFps] = useState(0);
  const [control, setControl] = useState(null); // phone's controlAccess
  const [toast, setToast] = useState('');

  useEffect(() => { document.title = `${name} · DropWave`; document.documentElement.classList.add('dark'); }, [name]);

  // Is control from the PC turned on, on the phone?
  useEffect(() => {
    const pick = (p) => p?.id === id && setControl(!!p.status?.controlAccess);
    api.phoneList().then((r) => pick(r.phones.find((p) => p.id === id)));
    return api.onPhone(pick);
  }, [id]);

  // Decode and draw.
  useEffect(() => {
    let decoder = null, config = null, needKey = true, frames = 0;
    const ctx = canvas.current.getContext('2d', { alpha: false, desynchronized: true });
    const fpsTimer = setInterval(() => { setFps(frames); frames = 0; }, 1000);
    const make = () => {
      decoder?.close?.();
      decoder = new VideoDecoder({
        output: (f) => {
          const c = canvas.current;
          if (c.width !== f.displayWidth || c.height !== f.displayHeight) { c.width = f.displayWidth; c.height = f.displayHeight; }
          ctx.drawImage(f, 0, 0);
          f.close();
          frames++;
        },
        error: (e) => { console.warn('decoder', e); needKey = true; },
      });
      decoder.configure({ codec: codecFrom(config), optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      needKey = true;
    };
    const offs = [
      api.onMirrorFrame(({ type, pts, data }) => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (type === 3) { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); setSize({ w: v.getUint32(0), h: v.getUint32(4) }); return; }
        if (type === 1) { config = bytes.slice(); make(); setState({ state: 'on' }); return; }
        if (!decoder || decoder.state !== 'configured') return;
        if (type === 2) {
          const both = new Uint8Array(config.length + bytes.length); both.set(config); both.set(bytes, config.length);
          decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: pts, data: both }));
          needKey = false;
        } else if (!needKey) {
          if (decoder.decodeQueueSize > 12) { needKey = true; return; } // falling behind: wait for the next key frame
          decoder.decode(new EncodedVideoChunk({ type: 'delta', timestamp: pts, data: bytes }));
        }
      }),
      api.onMirrorState((s) => setState(s)),
    ];
    return () => { offs.forEach((f) => f()); clearInterval(fpsTimer); decoder?.close?.(); };
  }, []);

  const send = (ev) => api.mirrorInput(id, ev);
  const flash = (t) => { setToast(t); setTimeout(() => setToast(''), 1800); };

  // Mouse -> touch
  useEffect(() => {
    const c = canvas.current;
    let down = null, lastWheel = 0;
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
    const pd = (e) => { if (e.button === 2) return; c.setPointerCapture(e.pointerId); down = { ...pos(e), t: Date.now() }; };
    const pu = (e) => {
      if (!down || e.button === 2) return;
      const p = pos(e), dt = Date.now() - down.t, dist = Math.hypot(p.x - down.x, p.y - down.y);
      if (dist < 0.012) send({ t: dt > 500 ? 'long' : 'tap', x: down.x, y: down.y });
      else send({ t: 'swipe', x: down.x, y: down.y, x2: p.x, y2: p.y, ms: Math.min(1500, Math.max(80, dt)) });
      down = null;
    };
    const ctxm = (e) => { e.preventDefault(); send({ t: 'back' }); };
    const wheel = (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel < 180) return;
      lastWheel = now;
      const p = pos(e), dy = Math.max(-0.35, Math.min(0.35, e.deltaY / 900));
      send({ t: 'swipe', x: p.x, y: Math.min(0.85, Math.max(0.15, p.y)), x2: p.x, y2: Math.min(0.95, Math.max(0.05, p.y - dy)), ms: 160 });
    };
    c.addEventListener('pointerdown', pd); c.addEventListener('pointerup', pu); c.addEventListener('contextmenu', ctxm); c.addEventListener('wheel', wheel, { passive: false });
    return () => { c.removeEventListener('pointerdown', pd); c.removeEventListener('pointerup', pu); c.removeEventListener('contextmenu', ctxm); c.removeEventListener('wheel', wheel); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard -> typing (letters are batched into one "text" event)
  useEffect(() => {
    let pending = '', timer = null;
    const flush = () => { if (pending) send({ t: 'text', s: pending }); pending = ''; };
    const key = async (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'v') { e.preventDefault(); const t = await api.readClipboard(); if (t) { flush(); send({ t: 'text', s: t.slice(0, 500) }); } return; }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Escape') { e.preventDefault(); flush(); send({ t: 'back' }); return; }
      if (e.key === 'Enter') { e.preventDefault(); flush(); send({ t: 'enter' }); return; }
      if (e.key === 'Backspace') { e.preventDefault(); flush(); send({ t: 'backspace' }); return; }
      if (e.key.length === 1) { e.preventDefault(); pending += e.key; clearTimeout(timer); timer = setTimeout(flush, 120); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shot = async () => {
    const f = await api.mirrorShot(name, canvas.current.toDataURL('image/png'));
    if (f) { flash('Screenshot saved'); api.showInFolder(f); }
  };

  const live = state.state === 'on';
  const Btn = ({ title, onClick, children, danger }) => (
    <button title={title} onClick={onClick} className={`no-drag grid h-10 w-10 place-items-center rounded-full transition active:scale-95 ${danger ? 'bg-[#e5484d] text-white' : 'text-white/85 hover:bg-white/12'}`}>{children}</button>
  );

  return (
    <div className="flex h-full flex-col bg-[#05060a] text-white select-none">
      <div className="drag flex h-10 shrink-0 items-center gap-2 pl-3 pr-[140px] text-[12.5px]">
        <Smartphone className="h-4 w-4 text-white/60" />
        <span className="truncate font-semibold">{name}</span>
        {live && <span className="text-white/45 tabular">{size ? `${size.w}×${size.h} · ` : ''}{fps} fps</span>}
      </div>
      <div className="relative grid min-h-0 flex-1 place-items-center p-2">
        <canvas ref={canvas} width={360} height={780} className={`max-h-full max-w-full rounded-[18px] bg-black shadow-2xl ${live ? '' : 'opacity-0'} ${control ? 'cursor-pointer' : ''}`} style={{ aspectRatio: size ? `${size.w}/${size.h}` : undefined }} />
        {!live && (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div>
              {state.state === 'asking' ? <Loader2 className="mx-auto h-8 w-8 animate-spin text-white/60" /> : <Smartphone className="mx-auto h-8 w-8 text-white/50" />}
              <div className="mt-4 font-display text-[16px] font-semibold">
                {{ asking: 'Waiting for the phone…', declined: 'The phone said no', off: 'Stopped', error: 'Couldn’t show the screen' }[state.state] || 'Connecting…'}
              </div>
              <div className="mt-1 text-[12.5px] text-white/60">
                {state.state === 'asking' ? `On ${name}, tap “Start now” (or tap DropWave’s notification first).` : state.error || 'Close this window, or start again from Home.'}
              </div>
              {['declined', 'off', 'error'].includes(state.state) && (
                <button onClick={() => { setState({ state: 'asking' }); api.mirrorStart(id).catch((e) => setState({ state: 'error', error: e.message })); }}
                  className="no-drag mt-4 h-9 rounded-xl bg-white/15 px-4 text-[13px] font-semibold hover:bg-white/25">Try again</button>
              )}
            </div>
          </div>
        )}
        {live && control === false && (
          <div className="absolute left-3 right-3 top-3 flex items-start gap-2 rounded-xl bg-black/75 px-3 py-2 text-[11.5px] text-white/85 backdrop-blur">
            <MousePointer2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            To control the phone from here, turn on “DropWave: control from PC” on the phone (Settings › Accessibility).
          </div>
        )}
        {toast && <div className="absolute bottom-4 rounded-xl bg-white/15 px-3 py-1.5 text-[12px] backdrop-blur">{toast}</div>}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-center gap-2">
        <Btn title="Back (right-click, Esc)" onClick={() => send({ t: 'back' })}><ArrowLeft className="h-5 w-5" /></Btn>
        <Btn title="Home" onClick={() => send({ t: 'home' })}><Circle className="h-5 w-5" /></Btn>
        <Btn title="Recent apps" onClick={() => send({ t: 'recents' })}><Square className="h-4.5 w-4.5" /></Btn>
        <Btn title="Notifications" onClick={() => send({ t: 'notifications' })}><Bell className="h-5 w-5" /></Btn>
        <Btn title="Screenshot to this PC" onClick={shot}><Camera className="h-5 w-5" /></Btn>
        <Btn title="Stop showing the screen" danger onClick={() => { api.mirrorStop(id); window.close(); }}><X className="h-5 w-5" /></Btn>
      </div>
    </div>
  );
}
