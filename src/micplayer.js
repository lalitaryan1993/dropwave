// Phone as microphone: plays the phone's mic (48 kHz mono 16-bit PCM, 20 ms frames) on the output
// the user picks. Pick a virtual cable (VB-CABLE's "CABLE Input") and every app can use the phone
// as a mic ("CABLE Output"). Lives outside React so it keeps playing when the page changes.
import { api } from './lib.js';

const load = (k, d) => { try { const v = localStorage.getItem(`dw_mic_${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(`dw_mic_${k}`, JSON.stringify(v)); } catch {} };

const subs = new Set();
const st = { id: null, state: 'off', error: '', notified: false, level: 0, sink: load('sink', ''), volume: load('volume', 1), listen: false };
const emit = () => { for (const f of subs) f({ ...st }); };

let ctx = null, gain = null, next = 0, rate = 48000, lastLevel = 0;

async function ensureCtx() {
  if (ctx) return ctx;
  ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  gain = ctx.createGain();
  gain.gain.value = st.volume;
  gain.connect(ctx.destination);
  next = 0;
  if (st.sink) await ctx.setSinkId(st.sink).catch(() => { st.sink = ''; save('sink', ''); });
  return ctx;
}

function closeCtx() {
  if (ctx) ctx.close().catch(() => {});
  ctx = null; gain = null; next = 0;
  st.level = 0;
}

function play(bytes) {
  if (!ctx || ctx.state === 'closed') return;
  const n = bytes.byteLength >> 1;
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, n);
  const buf = ctx.createBuffer(1, n, rate);
  const ch = buf.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm[i] / 32768; ch[i] = v; sum += v * v; }
  const now = ctx.currentTime;
  // Small jitter buffer: start 60 ms ahead; if we fall more than 250 ms behind the phone, skip ahead.
  if (next < now + 0.01) next = now + 0.06;
  else if (next > now + 0.25) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(gain);
  src.start(next);
  next += buf.duration;
  const rms = Math.sqrt(sum / n); // meter in dB: -60 dBFS (quiet room) .. -6 dBFS (loud voice)
  const level = rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 54)) : 0;
  st.level = Math.max(level, st.level * 0.8);
  if (performance.now() - lastLevel > 80) { lastLevel = performance.now(); emit(); }
}

api?.onMicFrame?.(({ id, type, data }) => {
  if (id !== st.id || st.state === 'off' || st.state === 'error' || !data) return;
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (type === 3 && b.byteLength >= 8) {
    const r = new DataView(b.buffer, b.byteOffset, 8).getUint32(0);
    if (r && r !== rate) { rate = r; closeCtx(); }
    ensureCtx();
  } else if (type === 6) {
    if (!ctx) ensureCtx().then(() => play(b)); else play(b);
  }
});

api?.onMic?.((s) => {
  if (!s || (st.id && s.id !== st.id)) return;
  st.id = s.id;
  st.state = s.state;
  st.error = s.error || '';
  st.notified = !!s.notified;
  if (s.state === 'off' || s.state === 'error') closeCtx();
  emit();
});

export const mic = {
  get: () => ({ ...st }),
  subscribe(f) { subs.add(f); f({ ...st }); return () => subs.delete(f); },
  async start(id) {
    if (st.id && st.id !== id && st.state !== 'off') await api.micStop(st.id).catch(() => {});
    Object.assign(st, { id, state: 'asking', error: '', notified: false });
    emit();
    await ensureCtx(); // created on the click, so the browser lets it play
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    setTimeout(() => {
      if (st.id === id && st.state === 'asking' && !st.notified) {
        Object.assign(st, { state: 'error', error: 'The phone didn’t answer. Open DropWave on the phone (it may need the latest version).' });
        api.micStop(id).catch(() => {}); closeCtx(); emit();
      }
    }, 20000);
    try { await api.micStart(id); } catch (e) { Object.assign(st, { state: 'error', error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); closeCtx(); emit(); }
  },
  async stop() {
    const id = st.id;
    Object.assign(st, { state: 'off', error: '' });
    closeCtx(); emit();
    if (id) await api.micStop(id).catch(() => {});
  },
  async setSink(id) {
    st.sink = id; save('sink', id);
    if (ctx) await ctx.setSinkId(id).catch(() => {});
    emit();
  },
  setVolume(v) {
    st.volume = v; save('volume', v);
    if (gain) gain.gain.value = v;
    emit();
  },
  /** Audio outputs on this PC, with the virtual cable (if any) first. */
  async outputs() {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const outs = all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
    return outs.map((d) => ({ id: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || 'Speaker', cable: /cable input|virtual/i.test(d.label) }));
  },
};
