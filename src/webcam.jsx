// Phone-as-webcam window: the phone's camera, decoded with WebCodecs and drawn full-window.
// Front / back, mirror, rotate, torch, snapshot, keep on top, and a clean view (H) with no
// buttons, so video-call and streaming apps can share this window as a camera source.
import { useEffect, useRef, useState } from 'react';
import { Camera, SwitchCamera, FlipHorizontal2, RotateCw, Flashlight, Pin, PinOff, EyeOff, X, Loader2, Video, Webcam } from 'lucide-react';
import { api } from './lib.js';

function codecFrom(config) {
  for (let i = 0; i + 4 < config.length; i++) {
    if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3] & 0x1f) === 7) {
      const h = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${h(config[i + 4])}${h(config[i + 5])}${h(config[i + 6])}`;
    }
  }
  return 'avc1.42E029';
}

// RGBA (canvas) -> NV12 1280x720, BT.601 limited range, for the Windows camera.
const VW = 1280, VH = 720;
function toNV12(rgba, out) {
  const uvBase = VW * VH;
  for (let y = 0; y < VH; y++) {
    let i = y * VW * 4, o = y * VW;
    const uvRow = uvBase + (y >> 1) * VW;
    for (let x = 0; x < VW; x++, i += 4, o++) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      out[o] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
      if (!(y & 1) && !(x & 1)) {
        out[uvRow + x] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
        out[uvRow + x + 1] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
      }
    }
  }
  return out;
}

const load = (k, d) => { try { const v = localStorage.getItem(`dw_cam_${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(`dw_cam_${k}`, JSON.stringify(v)); } catch {} };

export function WebcamApp() {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get('webcam');
  const name = params.get('name') || 'Phone';
  const canvas = useRef(null);
  const [state, setState] = useState({ state: 'asking' });
  const [size, setSize] = useState(null);
  const [fps, setFps] = useState(0);
  const [front, setFront] = useState(false);
  const [flip, setFlip] = useState(() => load('flip', null)); // null = auto (front camera mirrored)
  const [rot, setRot] = useState(() => load('rot', 0));
  const [torch, setTorch] = useState(false);
  const [top, setTop] = useState(false);
  const [clean, setClean] = useState(false);
  const [toast, setToast] = useState('');
  const flash = (t) => { setToast(t); setTimeout(() => setToast(''), 1800); };
  const [vcam, setVcam] = useState({ status: null, on: false, busy: false });
  const view = useRef({ rot: 0, mirrored: false, on: false });
  const pushVcam = useRef(null);

  useEffect(() => { document.title = `${name} camera · DropWave`; document.documentElement.classList.add('dark'); }, [name]);
  useEffect(() => save('flip', flip), [flip]);
  useEffect(() => save('rot', rot), [rot]);

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
          pushVcam.current?.();
        },
        error: () => { needKey = true; },
      });
      decoder.configure({ codec: codecFrom(config), optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      needKey = true;
    };
    const offs = [
      api.onMirrorFrame(({ type, pts, data }) => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (type === 3) { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); setSize({ w: v.getUint32(0), h: v.getUint32(4) }); return; }
        if (type === 1) { config = bytes.slice(); make(); setState((s) => ({ ...s, state: 'on' })); return; }
        if (!decoder || decoder.state !== 'configured') return;
        if (type === 2) {
          const both = new Uint8Array(config.length + bytes.length); both.set(config); both.set(bytes, config.length);
          decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: pts, data: both }));
          needKey = false;
        } else if (type === 0 && !needKey) {
          if (decoder.decodeQueueSize > 8) { needKey = true; return; }
          decoder.decode(new EncodedVideoChunk({ type: 'delta', timestamp: pts, data: bytes }));
        }
      }),
      api.onMirrorState((s) => {
        if (s.state === 'live') { setFront(!!s.front); setState((x) => (x.state === 'on' ? x : { state: 'connecting', stage: s.stage })); return; }
        setState(s);
      }),
    ];
    return () => { offs.forEach((f) => f()); clearInterval(fpsTimer); decoder?.close?.(); };
  }, []);

  // H: clean view (no buttons) · Esc: back to normal
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'h' || e.key === 'H') setClean((c) => !c);
      else if (e.key === 'Escape') setClean(false);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const live = state.state === 'on';
  const mirrored = flip === null ? front : flip;
  const sideways = rot % 180 !== 0;
  view.current = { rot, mirrored, on: vcam.on };

  // The Windows camera ("DropWave Camera"): what this window shows, at most 30 times a second.
  useEffect(() => {
    api.vcamStatus().then((s) => setVcam((v) => ({ ...v, ...s })));
    const off = api.onVcam((s) => setVcam((v) => ({ ...v, ...s })));
    const oc = new OffscreenCanvas(VW, VH);
    const g = oc.getContext('2d', { willReadFrequently: true });
    const nv12 = new Uint8Array(VW * VH * 3 / 2);
    let last = 0;
    pushVcam.current = () => {
      const v = view.current;
      if (!v.on) return;
      const now = performance.now();
      if (now - last < 32) return;
      last = now;
      const src = canvas.current;
      const sw = v.rot % 180 ? src.height : src.width, sh = v.rot % 180 ? src.width : src.height;
      const k = Math.min(VW / sw, VH / sh);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#000'; g.fillRect(0, 0, VW, VH);
      g.translate(VW / 2, VH / 2); g.rotate((v.rot * Math.PI) / 180); g.scale(v.mirrored ? -k : k, k);
      g.drawImage(src, -src.width / 2, -src.height / 2);
      api.vcamFrame(toNV12(g.getImageData(0, 0, VW, VH).data, nv12));
    };
    return () => { off(); pushVcam.current = null; api.vcamStop(); };
  }, []);

  const toggleVcam = async () => {
    if (vcam.busy) return;
    if (vcam.on) { setVcam((v) => ({ ...v, on: false })); api.vcamStop(); flash('DropWave Camera is off'); return; }
    setVcam((v) => ({ ...v, busy: true }));
    let s = await api.vcamStatus();
    if (s.status === 'not-installed') {
      flash('Windows will ask for permission once, to add DropWave Camera');
      s = await api.vcamInstall();
    }
    if (s.status === 'installed') s = await api.vcamStart();
    setVcam({ ...s, busy: false });
    if (s.on) flash('In Zoom, Meet or Teams, pick “DropWave Camera”');
    else flash({ unsupported: 'Needs Windows 11', missing: 'This build has no camera driver', 'not-installed': 'DropWave Camera wasn’t added' }[s.status] || s.error || 'Couldn’t start DropWave Camera');
  };
  const switchCam = () => { setTorch(false); api.webcamSet(id, { front: !front }); setFront((f) => !f); };
  const snap = async () => {
    // Save what's on screen, with the same flip and rotation.
    const src = canvas.current;
    const c = document.createElement('canvas');
    c.width = sideways ? src.height : src.width; c.height = sideways ? src.width : src.height;
    const g = c.getContext('2d');
    g.translate(c.width / 2, c.height / 2); g.rotate((rot * Math.PI) / 180); if (mirrored) g.scale(-1, 1);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    const f = await api.mirrorShot(`${name} camera`, c.toDataURL('image/png'));
    if (f) { flash('Photo saved'); api.showInFolder(f); }
  };
  const restart = () => { setState({ state: 'asking' }); api.webcamStart(id, front).catch((e) => setState({ state: 'error', error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })); };

  const Btn = ({ title, onClick, children, on, danger, disabled }) => (
    <button title={title} onClick={onClick} disabled={disabled}
      className={`no-drag grid h-10 w-10 place-items-center rounded-full transition active:scale-95 disabled:opacity-35 ${danger ? 'bg-[#e5484d] text-white' : on ? 'bg-white text-black' : 'text-white/85 hover:bg-white/12'}`}>{children}</button>
  );

  return (
    <div className="flex h-full flex-col bg-black text-white select-none">
      {!clean && (
        <div className="drag flex h-9 shrink-0 items-center gap-2 pl-3 pr-[140px] text-[12.5px]">
          <Video className="h-4 w-4 text-white/60" />
          <span className="truncate font-semibold">{name} camera</span>
          {live && <span className="text-white/45 tabular">{size ? `${size.w}×${size.h} · ` : ''}{fps} fps · {front ? 'front' : 'back'}</span>}
          {vcam.on && <span className="rounded-full bg-[#3ddc97]/20 px-2 py-px text-[11px] font-semibold text-[#3ddc97]">DropWave Camera on</span>}
        </div>
      )}
      <div className={`relative min-h-0 flex-1 overflow-hidden ${clean ? 'drag' : ''}`} style={{ containerType: 'size' }}>
        <canvas ref={canvas} width={1280} height={720}
          className={`absolute left-1/2 top-1/2 ${live ? '' : 'opacity-0'}`}
          style={{
            transform: `translate(-50%, -50%) rotate(${rot}deg) scaleX(${mirrored ? -1 : 1})`,
            // Turned sideways, the picture's width follows the window's height (container units).
            ...(sideways ? { width: '100cqh', height: '100cqw' } : { width: '100cqw', height: '100cqh' }),
            objectFit: 'contain',
          }} />
        {!live && (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div>
              {['asking', 'connecting'].includes(state.state) ? <Loader2 className="mx-auto h-8 w-8 animate-spin text-white/60" /> : <Camera className="mx-auto h-8 w-8 text-white/50" />}
              <div className="mt-4 font-display text-[16px] font-semibold">
                {{ asking: 'Waiting for the phone…', connecting: 'Starting the camera…', off: 'Camera stopped', error: 'Couldn’t start the camera' }[state.state] || 'Connecting…'}
              </div>
              <div className="mt-1 max-w-[420px] text-[12.5px] text-white/60">
                {state.state === 'asking' ? (state.notified ? `Tap DropWave’s notification on ${name} to turn the camera on.` : `Turning on ${name}’s camera. Android may ask for the camera permission once.`)
                  : state.state === 'connecting' ? (state.stage ? `Phone: ${state.stage}…` : 'The camera is on, waiting for the first picture.')
                  : state.error || 'Start it again, or close this window.'}
              </div>
              {['off', 'error'].includes(state.state) && <button onClick={restart} className="no-drag mt-4 h-9 rounded-xl bg-white/15 px-4 text-[13px] font-semibold hover:bg-white/25">Start again</button>}
            </div>
          </div>
        )}
        {toast && <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl bg-white/15 px-3 py-1.5 text-[12px] backdrop-blur">{toast}</div>}
        {clean && <div className="pointer-events-none absolute bottom-2 right-3 text-[10.5px] text-white/0 hover:text-white/40">H: show buttons</div>}
      </div>
      {!clean && (
        <div className="flex h-14 shrink-0 items-center justify-center gap-2">
          <Btn title={front ? 'Use the back camera' : 'Use the front camera'} onClick={switchCam} disabled={!live}><SwitchCamera className="h-5 w-5" /></Btn>
          <Btn title="Mirror the picture" on={mirrored} onClick={() => setFlip(!mirrored)}><FlipHorizontal2 className="h-5 w-5" /></Btn>
          <Btn title="Rotate" onClick={() => setRot((r) => (r + 90) % 360)}><RotateCw className="h-5 w-5" /></Btn>
          <Btn title={front ? 'Torch works with the back camera' : torch ? 'Torch off' : 'Torch on'} on={torch} disabled={!live || front} onClick={() => { api.webcamSet(id, { torch: !torch }); setTorch((t) => !t); }}><Flashlight className="h-5 w-5" /></Btn>
          <Btn title="Save a photo to this PC" onClick={snap} disabled={!live}><Camera className="h-5 w-5" /></Btn>
          <Btn title={vcam.on ? 'DropWave Camera is on: pick it in Zoom, Meet, Teams… (click to turn off)' : 'Use in Zoom, Meet, Teams…: adds “DropWave Camera” to Windows'} on={vcam.on} disabled={vcam.busy || vcam.status === 'unsupported'} onClick={toggleVcam}>
            {vcam.busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Webcam className="h-5 w-5" />}
          </Btn>
          <Btn title={top ? 'Stop keeping on top' : 'Keep this window on top'} on={top} onClick={() => api.setOnTop(!top).then(setTop)}>{top ? <PinOff className="h-5 w-5" /> : <Pin className="h-5 w-5" />}</Btn>
          <Btn title="Clean view: no buttons (press H to bring them back)" onClick={() => { setClean(true); flash('Press H to show the buttons again'); }}><EyeOff className="h-5 w-5" /></Btn>
          <Btn title="Turn the camera off" danger onClick={() => { api.webcamStop(id); window.close(); }}><X className="h-5 w-5" /></Btn>
        </div>
      )}
    </div>
  );
}
