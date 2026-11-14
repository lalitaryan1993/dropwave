// Calls and screen sharing on the PC: hook + the overlay UI. The WebRTC logic lives in
// electron/web/rtc.js, shared with the phone page.
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, MonitorUp, Loader2, MousePointer2 } from 'lucide-react';
import '../electron/web/rtc.js';
import { api } from './lib.js';
import { Avatar } from './components.jsx';

const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function useCalls(toast) {
  const [call, setCall] = useState(null);
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = window.DWCalls({
      send: (peerId, msg) => api.rtcSend(peerId, msg),
      onChange: setCall,
      onInput: (e) => api.inputEvent(e), // rtc.js only passes these on while control is allowed
    });
  }
  // Remote control runs only while: sharing my screen, the user allowed it, and the call is up.
  const controlOn = !!(call && call.sharing && call.control && call.status !== 'ended');
  useEffect(() => {
    api.inputControl(controlOn).catch((e) => { toast(cleanErr(e), 'error'); ref.current.setControl(false); });
  }, [controlOn, toast]);
  useEffect(() => api.onRtc(({ from, msg }) => ref.current.handle(from, msg)), []);
  // Dev builds only: lets test scripts read call stats over the debugging port.
  useEffect(() => { if (import.meta.env.DEV) window.__dwCalls = ref.current; }, []);
  const start = async (peer, media, share) => {
    try { await ref.current.start({ id: peer.id, name: peer.name }, media, share); } catch (e) { toast(cleanErr(e), 'error'); }
  };
  return { call, calls: ref.current, start };
}

function describe(c) {
  if (c.media === 'screen') {
    if (c.role === 'callee') return c.share === 'callee' ? 'wants to see your screen' : 'wants to show you their screen';
    return c.share === 'caller' ? 'Sharing your screen' : 'Their screen';
  }
  return c.role === 'callee' ? (c.media === 'video' ? 'is video calling you' : 'is calling you') : c.media === 'video' ? 'Video call' : 'Voice call';
}

function MediaEl({ stream, muted, className, audioOnly }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null; }, [stream]);
  return audioOnly
    ? <audio ref={ref} autoPlay />
    : <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

function Elapsed({ live }) {
  const [t0] = useState(Date.now());
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  if (!live) return null;
  const s = Math.floor((Date.now() - t0) / 1000);
  return <span className="tabular-nums">{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

const roundBtn = 'grid h-12 w-12 place-items-center rounded-full transition active:scale-95';

export function CallLayer({ call, calls }) {
  return <AnimatePresence>{call && <CallView key={call.id} c={call} calls={calls} />}</AnimatePresence>;
}

function CallView({ c, calls }) {
  const ended = c.status === 'ended';
  const statusText = ended ? (c.reason || 'Call ended') : c.status === 'ringing-out' ? 'Ringing…' : c.status === 'connecting' ? 'Connecting…' : null;

  // Incoming: ask first.
  if (c.status === 'ringing-in') {
    const screenAsk = c.media === 'screen' && c.share === 'callee';
    return (
      <motion.div className="fixed inset-0 z-[70] grid place-items-center bg-black/55 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <motion.div initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} className="w-[360px] rounded-3xl border border-line-strong bg-panel-solid p-7 text-center shadow-2xl">
          <div className="mx-auto w-fit animate-pulse"><Avatar id={c.peer.id} name={c.peer.name} size={76} /></div>
          <div className="mt-4 font-display text-[19px] font-semibold">{c.peer.name}</div>
          <div className="mt-1 text-[13.5px] text-muted">{describe(c)}</div>
          {screenAsk && <div className="mt-3 rounded-xl bg-warn/10 px-3 py-2 text-[12px] text-warn">They will see everything on your main screen until you stop sharing.</div>}
          <div className="mt-6 flex justify-center gap-10">
            <div className="flex flex-col items-center gap-1.5">
              <button onClick={() => calls.decline()} className={`${roundBtn} bg-bad text-white`} title="Decline"><PhoneOff className="h-5 w-5" /></button>
              <span className="text-[12px] text-muted">Decline</span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <button onClick={() => calls.accept()} className={`${roundBtn} bg-good text-white`} title="Accept">
                {screenAsk ? <MonitorUp className="h-5 w-5" /> : c.media === 'video' ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
              </button>
              <span className="text-[12px] text-muted">{screenAsk ? 'Share screen' : 'Accept'}</span>
            </div>
          </div>
        </motion.div>
      </motion.div>
    );
  }

  const seesVideo = c.media === 'video' || (c.media === 'screen' && !c.sharing);
  const controls = (
    <div className="flex items-center gap-3">
      {c.local && c.local.getAudioTracks().length > 0 && (
        <button onClick={() => calls.toggleMute()} className={`${roundBtn} ${c.muted ? 'bg-white text-black' : 'bg-white/15 text-white hover:bg-white/25'}`} title={c.muted ? 'Unmute' : 'Mute'}>
          {c.muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
      )}
      {c.media === 'video' && c.local && (
        <button onClick={() => calls.toggleCam()} className={`${roundBtn} ${c.camOff ? 'bg-white text-black' : 'bg-white/15 text-white hover:bg-white/25'}`} title={c.camOff ? 'Turn camera on' : 'Turn camera off'}>
          {c.camOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
        </button>
      )}
      <button onClick={() => calls.end()} disabled={ended} className={`${roundBtn} bg-bad text-white disabled:opacity-50`} title={c.sharing ? 'Stop sharing' : 'End'}>
        <PhoneOff className="h-5 w-5" />
      </button>
    </div>
  );

  // Watching a screen or on a video call: big view.
  if (seesVideo) {
    return (
      <motion.div className="fixed inset-4 z-[70] overflow-hidden rounded-3xl border border-line-strong bg-black shadow-2xl" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }}>
        {c.remote ? <MediaEl stream={c.remote} className="h-full w-full object-contain" /> : (
          <div className="grid h-full place-items-center text-white/80">
            <div className="text-center"><Avatar id={c.peer.id} name={c.peer.name} size={84} /><div className="mt-3 flex items-center justify-center gap-2 text-[14px]">{!ended && <Loader2 className="h-4 w-4 animate-spin" />}{statusText}</div></div>
          </div>
        )}
        {c.media === 'video' && c.local && !c.camOff && (
          <MediaEl stream={c.local} muted className="absolute right-4 top-4 h-36 w-56 rounded-2xl border border-white/20 bg-black object-cover shadow-xl [transform:scaleX(-1)]" />
        )}
        <div className="absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-5 py-4 text-white">
          <span className="font-semibold">{c.peer.name}</span>
          <span className="text-[13px] text-white/70">{describe(c)} {c.status === 'live' && <>· <Elapsed live /></>} {statusText && c.remote ? `· ${statusText}` : ''}</span>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/70 to-transparent pb-6 pt-10">{controls}</div>
      </motion.div>
    );
  }

  // Voice call, or sharing my own screen: a compact bar.
  return (
    <motion.div className="fixed bottom-6 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-4 rounded-full border border-line-strong bg-[#14151d] py-2 pl-2 pr-3 text-white shadow-2xl" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}>
      {c.remote && <MediaEl stream={c.remote} audioOnly />}
      <Avatar id={c.peer.id} name={c.peer.name} size={44} />
      {c.sharing && c.controlAsked && !ended && (
        <div className="flex items-center gap-2 rounded-full bg-warn/15 py-1.5 pl-3 pr-1.5 text-[12.5px]">
          <MousePointer2 className="h-4 w-4 text-warn" />
          <span>{c.peer.name} wants to control your mouse &amp; keyboard</span>
          <button onClick={() => calls.setControl(false)} className="rounded-full px-3 py-1 text-white/80 hover:bg-white/10">Deny</button>
          <button onClick={() => calls.setControl(true)} className="rounded-full bg-warn px-3 py-1 font-semibold text-black">Allow</button>
        </div>
      )}
      {c.sharing && c.control && !ended && (
        <button onClick={() => calls.setControl(false)} className="flex items-center gap-2 rounded-full bg-warn px-3.5 py-2 text-[12.5px] font-semibold text-black" title="Take back your mouse and keyboard">
          <MousePointer2 className="h-4 w-4" /> {c.peer.name} is in control · Stop
        </button>
      )}
      <div className="min-w-[150px]">
        <div className="text-[14px] font-semibold">{c.sharing ? <span className="flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-bad" /> Sharing your screen</span> : c.peer.name}</div>
        <div className="text-[12px] text-white/60">{c.sharing ? `with ${c.peer.name}` : describe(c)} {c.status === 'live' ? <>· <Elapsed live /></> : statusText ? `· ${statusText}` : ''}</div>
      </div>
      {controls}
    </motion.div>
  );
}
