// Phone screen window: decodes the phone's H.264 stream with WebCodecs (hardware) and draws it.
// Mouse: click = tap, hold = long press, drag = swipe, wheel = scroll, right-click = Back.
// Keyboard: type into the focused field, Enter, Backspace; Esc = Back; Ctrl+V pastes the PC clipboard.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Circle, Square, Camera, X, Loader2, MousePointer2, Smartphone, Bell, Volume2, VolumeX, Upload } from 'lucide-react';
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
  // An app in its own window (Elevated, over USB): id is aw:<phone id>:<package>.
  const appMode = params.get('app') === '1';
  const phoneId = params.get('phone') || id;
  const pkg = appMode ? id.split(':').slice(2).join(':') : '';
  const canvas = useRef(null);
  const [state, setState] = useState({ state: 'asking' });
  const [size, setSize] = useState(null);
  const [fps, setFps] = useState(0);
  const [control, setControl] = useState(null); // phone's controlAccess
  const [toast, setToast] = useState('');
  const [muted, setMuted] = useState(false);
  const [hasSound, setHasSound] = useState(false);
  const audio = useRef({ ctx: null, gain: null, next: 0 });

  // The phone's sound: 16-bit stereo 48 kHz PCM chunks, played back to back with a little headroom.
  const play = (bytes) => {
    const a = audio.current;
    if (!a.ctx) {
      a.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      a.gain = a.ctx.createGain();
      a.gain.connect(a.ctx.destination);
      setHasSound(true);
    }
    const n = bytes.byteLength >> 2;
    if (!n) return;
    const v = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
    const buf = a.ctx.createBuffer(2, n, 48000);
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    for (let i = 0; i < n; i++) { l[i] = v.getInt16(i * 4, true) / 32768; r[i] = v.getInt16(i * 4 + 2, true) / 32768; }
    const src = a.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(a.gain);
    const now = a.ctx.currentTime;
    // Too far behind (or ahead after a hiccup): restart close to now so the sound stays in sync with the picture.
    if (a.next < now + 0.02 || a.next > now + 0.4) a.next = now + 0.08;
    src.start(a.next);
    a.next += buf.duration;
  };
  useEffect(() => { const a = audio.current; if (a.gain) a.gain.gain.value = muted ? 0 : 1; }, [muted]);
  useEffect(() => () => { audio.current.ctx?.close(); }, []);

  useEffect(() => { document.title = `${name} · DropWave`; document.documentElement.classList.add('dark'); }, [name]);

  // Is control from the PC turned on, on the phone?
  useEffect(() => {
    if (appMode) { setControl(true); return undefined; } // the helper taps on its own display, no Accessibility needed
    const pick = (p) => p?.id === id && setControl(!!p.status?.controlAccess);
    api.phoneList().then((r) => pick(r.phones.find((p) => p.id === id)));
    return api.onPhone(pick);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (type === 4) { playRef.current(bytes); return; }
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
    api.mirrorReady?.(); // frames may have started before this window was listening
    return () => { offs.forEach((f) => f()); clearInterval(fpsTimer); decoder?.close?.(); };
  }, []);

  // Files dropped on this window go to the phone (it asks there, like any file from the PC).
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDropping(true); };
    const over = (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDropping(false); };
    const drop = async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; setDropping(false);
      const paths = api.pathsFromFiles([...e.dataTransfer.files]);
      if (!paths.length) return;
      try { await api.sendPaths(phoneId, paths); flash(`Sending ${paths.length} item${paths.length > 1 ? 's' : ''} to ${name}…`); }
      catch (err) { flash(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, [id, name]); // eslint-disable-line react-hooks/exhaustive-deps

  const playRef = useRef(play);
  playRef.current = play;
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
        <canvas ref={canvas} width={360} height={780} className={`max-h-full max-w-full rounded-[18px] bg-black shadow-2xl ${live ? '' : 'opacity-0'} ${control ? 'cursor-pointer' : ''}`} style={{ aspectRatio: size ? `${size.w}/${size.h}` : undefined, maxHeight: 'calc(100vh - 112px)' }} />
        {!live && (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div>
              {state.state === 'asking' ? <Loader2 className="mx-auto h-8 w-8 animate-spin text-white/60" /> : <Smartphone className="mx-auto h-8 w-8 text-white/50" />}
              <div className="mt-4 font-display text-[16px] font-semibold">
                {{ asking: appMode ? `Opening ${name} on the phone…` : 'Waiting for the phone…', declined: 'The phone said no', off: appMode ? `${name} was closed` : 'Stopped', error: appMode ? `Couldn’t open ${name} here` : 'Couldn’t show the screen' }[state.state] || 'Connecting…'}
              </div>
              <div className="mt-1 text-[12.5px] text-white/60">
                {state.state === 'asking' ? (appMode ? 'Over the USB cable. It runs on the phone in the background, so you can keep using the phone.' : `On ${name}, tap “Start now” (or tap DropWave’s notification first).`) : state.error || (appMode ? 'Close this window, or open it again from Apps.' : 'Close this window, or start again from Home.')}
              </div>
              {['declined', 'off', 'error'].includes(state.state) && (
                <button onClick={() => { setState({ state: 'asking' }); (appMode ? api.appWinStart(phoneId, pkg, name) : api.mirrorStart(id)).catch((e) => setState({ state: 'error', error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })); }}
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
        {dropping && (
          <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-[22px] border-2 border-dashed border-white/50 bg-black/60 backdrop-blur-sm">
            <div className="text-center"><Upload className="mx-auto h-8 w-8" /><div className="mt-2 font-semibold">Drop to send to {name}</div></div>
          </div>
        )}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-center gap-2">
        <Btn title="Back (right-click, Esc)" onClick={() => send({ t: 'back' })}><ArrowLeft className="h-5 w-5" /></Btn>
        {!appMode && <Btn title="Home" onClick={() => send({ t: 'home' })}><Circle className="h-5 w-5" /></Btn>}
        {!appMode && <Btn title="Recent apps" onClick={() => send({ t: 'recents' })}><Square className="h-4.5 w-4.5" /></Btn>}
        {!appMode && <Btn title="Notifications" onClick={() => send({ t: 'notifications' })}><Bell className="h-5 w-5" /></Btn>}
        <Btn title="Screenshot to this PC" onClick={shot}><Camera className="h-5 w-5" /></Btn>
        <Btn title={hasSound ? (muted ? 'Unmute the phone’s sound' : 'Mute the phone’s sound') : 'No sound from the phone (allow the microphone on the phone to get it)'} onClick={() => setMuted((m) => !m)}>
          {muted || !hasSound ? <VolumeX className={`h-5 w-5 ${hasSound ? '' : 'opacity-40'}`} /> : <Volume2 className="h-5 w-5" />}
        </Btn>
        <Btn title={appMode ? `Close ${name}` : 'Stop showing the screen'} danger onClick={() => { if (!appMode) api.mirrorStop(id); window.close(); }}><X className="h-5 w-5" /></Btn>
      </div>
    </div>
  );
}
