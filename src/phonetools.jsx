// Home cards: quick phone controls (torch, Do Not Disturb, ring mode, volumes, brightness, lock)
// and the camera (take a photo / video with the phone, it lands on this PC and in the clipboard).
import { useEffect, useRef, useState } from 'react';
import { Flashlight, MoonStar, Vibrate, Bell, Sun, Lock, Camera, Video, Copy, FolderOpen, Loader2, SlidersHorizontal, Webcam, Wifi, Bluetooth, Mic, MicOff, Volume2 } from 'lucide-react';
import { api } from './lib.js';
import { mic } from './micplayer.js';
import { Button } from './components.jsx';

const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function ControlsCard({ phone, toast }) {
  const id = phone.id;
  const off = !!phone.status?.off?.includes('controls');
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const timers = useRef({});

  const ask = (tries = 2) => api.phoneRpc(id, 'controls').then((r) => { setS(r); setErr(''); })
    .catch((e) => (tries > 1 ? setTimeout(() => ask(tries - 1), 3000) : setErr(clean(e))));
  useEffect(() => {
    setS(null); setErr('');
    if (off) return;
    ask();
    return api.onControls((d) => d.id === id && setS(d.state));
  }, [id, off]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (what, value) => api.phoneRpc(id, 'controlsSet', { what, value }).then((r) => {
    setS(r);
    if (r.launch === 'notified') toast(`Tap the notification on ${phone.name}`);
  }).catch((e) => toast(clean(e), 'error'));
  // Sliders: show the new value now, tell the phone once the slider rests.
  const slide = (what, value, local) => {
    setS((x) => local(x));
    clearTimeout(timers.current[what]);
    timers.current[what] = setTimeout(() => set(what, value), 180);
  };

  // Wi-Fi and Bluetooth: only over the USB cable (Android doesn't let apps switch them).
  const [radios, setRadios] = useState(null);
  useEffect(() => {
    const read = () => api.usbRadios?.().then(setRadios).catch(() => setRadios(null));
    read();
    const t = setInterval(read, 15000);
    const offUsb = api.onUsb?.(() => read());
    return () => { clearInterval(t); offUsb?.(); };
  }, [id]);
  const radio = (which) => api.usbRadio(which, !radios[which]).then((r) => setRadios({ usb: true, ...r })).catch((e) => toast(clean(e), 'error'));

  if (off) return null;
  return (
    <section className="rounded-3xl border border-line bg-raised/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <SlidersHorizontal className="h-4 w-4 text-accent" />
        <h3 className="text-[13.5px] font-semibold">Phone controls</h3>
      </div>
      {radios?.usb && (
        <div className="mb-2 grid grid-cols-2 gap-2">
          <Toggle Icon={Wifi} label="Wi-Fi" on={radios.wifi} title="Over the USB cable" onClick={() => radio('wifi')} />
          <Toggle Icon={Bluetooth} label="Bluetooth" on={radios.bluetooth} title="Over the USB cable" onClick={() => radio('bluetooth')} />
        </div>
      )}
      {!s ? (
        <div className="text-[12.5px] text-muted">{err || 'Asking the phone…'}{err && <button className="no-drag ml-2 text-accent" onClick={() => { setErr(''); ask(1); }}>Try again</button>}</div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2">
            <Toggle Icon={Flashlight} label="Torch" on={s.torch} disabled={!s.torchAvailable} onClick={() => set('torch', !s.torch)} />
            <Toggle Icon={MoonStar} label="DND" on={s.dnd} disabled={!s.dndAvailable} title={s.dndAvailable ? 'Do Not Disturb' : 'Needs notification access on the phone'} onClick={() => set('dnd', !s.dnd)} />
            <Toggle Icon={s.ringer === 'normal' ? Bell : Vibrate} label={s.ringer === 'normal' ? 'Ring' : s.ringer === 'vibrate' ? 'Vibrate' : 'Silent'} on={s.ringer !== 'normal'}
              onClick={() => set('ringer', s.ringer === 'normal' ? 'vibrate' : 'normal')} />
            <Toggle Icon={Lock} label="Lock" disabled={!s.control} title={s.control ? 'Lock the phone' : 'Needs “Control from PC” on the phone'} onClick={() => set('lock', true)} />
          </div>
          <div className="mt-4 space-y-2.5">
            {[['ring', 'Ringtone'], ['notification', 'Notifications'], ['alarm', 'Alarms']].map(([k, l]) => s.volumes?.[k] && (
              <Slider key={k} label={l} value={s.volumes[k].v} max={s.volumes[k].max}
                onChange={(v) => slide('volume', { stream: k, v }, (x) => ({ ...x, volumes: { ...x.volumes, [k]: { ...x.volumes[k], v } } }))} />
            ))}
            {s.canWrite ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Slider label="Brightness" Icon={Sun} value={s.brightness} max={255} disabled={s.autoBrightness}
                    onChange={(v) => slide('brightness', v, (x) => ({ ...x, brightness: v, autoBrightness: false }))} />
                </div>
                <button onClick={() => set('autoBrightness', !s.autoBrightness)}
                  className={`no-drag mt-4 rounded-lg px-2 py-1 text-[11px] font-semibold ${s.autoBrightness ? 'bg-accent/15 text-accent' : 'text-faint hover:bg-[var(--line)]'}`}>Auto</button>
              </div>
            ) : (
              <button onClick={() => set('allowSettings', true)} className="no-drag flex w-full items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-left text-[12px] text-muted hover:border-line-strong">
                <Sun className="h-4 w-4" /> Brightness from the PC: allow “Modify system settings” on the phone
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Toggle({ Icon, label, on, disabled, onClick, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title || label}
      className={`no-drag flex flex-col items-center gap-1 rounded-2xl border py-2.5 text-[11.5px] font-medium transition active:scale-[.97] disabled:opacity-40 ${on ? 'border-accent bg-accent/12 text-accent' : 'border-line hover:border-line-strong'}`}>
      <Icon className="h-[18px] w-[18px]" />{label}
    </button>
  );
}

function Slider({ label, value, max, onChange, disabled }) {
  return (
    <label className={`block ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex justify-between text-[11.5px] text-muted"><span>{label}</span><span className="tabular">{max ? Math.round((value / max) * 100) : 0}%</span></div>
      <input type="range" min={0} max={max} value={Math.max(0, value)} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}
        className="no-drag mt-1 w-full accent-[var(--accent)]" />
    </label>
  );
}

/** Continuity camera on Home: ask the phone for a photo / video; the result shows here and goes to the clipboard. */
export function CameraCard({ phone, toast }) {
  const id = phone.id;
  const off = !!phone.status?.off?.includes('camera');
  const [st, setSt] = useState(null); // { state, path, video, error }
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    setSt(null); setPreview(null);
    return api.onCamera((d) => {
      if (d.id !== id) return;
      setSt(d);
      if (d.state === 'done' && d.path && !d.video) api.imagePreview(d.path).then(setPreview).catch(() => {});
      else if (d.state === 'asking') setPreview(null);
    });
  }, [id]);

  const take = (mode) => api.cameraTake(id, mode).catch((e) => toast(clean(e), 'error'));
  if (off) return null;
  const busy = st?.state === 'asking' || st?.state === 'open' || st?.state === 'notified';
  return (
    <section className="rounded-3xl border border-line bg-raised/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Camera className="h-4 w-4 text-accent" />
        <h3 className="text-[13.5px] font-semibold">Camera</h3>
        <span className="ml-auto text-[11.5px] text-faint">photo, video or live webcam</span>
      </div>
      {st?.state === 'done' && preview && (
        <img src={preview} alt="" className="mb-3 max-h-48 w-full cursor-pointer rounded-2xl bg-black/20 object-contain" onClick={() => api.openPath(st.path)} title="Open" />
      )}
      {st?.state === 'done' && st.video && <div className="mb-3 text-[12.5px] text-muted">Video saved. <button className="no-drag text-accent" onClick={() => api.openPath(st.path)}>Play it</button></div>}
      {busy && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-accent/10 px-3 py-2 text-[12.5px]">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          {st.state === 'notified' ? `Tap the notification on ${phone.name} to open the camera` : `Take the ${st.video ? 'video' : 'photo'} on ${phone.name}…`}
        </div>
      )}
      {st?.state === 'cancelled' && <div className="mb-3 text-[12.5px] text-muted">{st.error || 'Cancelled on the phone.'}</div>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => take('photo')}><Camera className="h-4 w-4" /> Take photo</Button>
        <Button variant="soft" disabled={busy} onClick={() => take('video')}><Video className="h-4 w-4" /> Video</Button>
        <Button variant="soft" title="Live camera in a window: use it in calls and streams" onClick={() => api.webcamStart(id, false).catch((e) => toast(clean(e), 'error'))}><Webcam className="h-4 w-4" /> Webcam</Button>
        {st?.state === 'done' && st.path && <>
          {!st.video && <Button variant="ghost" title="Copy again" onClick={() => api.cameraCopy(st.path).then(() => toast('Copied — paste with Ctrl+V'))}><Copy className="h-4 w-4" /></Button>}
          <Button variant="ghost" title="Show in folder" onClick={() => api.showInFolder(st.path)}><FolderOpen className="h-4 w-4" /></Button>
        </>}
      </div>
    </section>
  );
}


// Phone as microphone: the phone's mic plays on the output picked here. With a virtual cable
// (VB-CABLE: pick "CABLE Input" here, "CABLE Output" as the mic in Zoom / Meet / Discord) every
// app can use the phone as its microphone.
export function MicCard({ phone }) {
  const id = phone.id;
  const off = !!phone.status?.off?.includes('mic');
  const [s, setS] = useState(mic.get());
  const [outs, setOuts] = useState([]);
  useEffect(() => mic.subscribe(setS), []);
  useEffect(() => {
    const refresh = () => mic.outputs().then(setOuts);
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, []);
  if (off) return null;
  const mine = s.id === id;
  const live = mine && s.state === 'live';
  const asking = mine && s.state === 'asking';
  const cable = outs.find((o) => o.cable);
  const sinkLabel = outs.find((o) => o.id === s.sink)?.label;
  const onCable = !!cable && s.sink === cable.id;
  return (
    <section className="rounded-3xl border border-line bg-raised/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Mic className="h-4 w-4 text-accent" />
        <h3 className="text-[13.5px] font-semibold">Microphone</h3>
        <span className="ml-auto text-[11.5px] text-faint">phone as PC mic</span>
      </div>
      {asking && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-accent/10 px-3 py-2 text-[12.5px]">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          {s.notified ? `Tap the notification on ${phone.name} to turn on its microphone` : `Turning on the microphone on ${phone.name}…`}
        </div>
      )}
      {mine && s.state === 'error' && <div className="mb-3 text-[12.5px] text-bad">{s.error}</div>}
      {live && (
        <div className="mb-3 flex items-center gap-2.5">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-good" />
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-2">
            <div className="h-full rounded-full bg-good transition-[width] duration-75" style={{ width: `${Math.round(s.level * 100)}%` }} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {live || asking
          ? <Button variant="soft" onClick={() => mic.stop()}><MicOff className="h-4 w-4" /> Stop</Button>
          : <Button variant="primary" onClick={() => mic.start(id)}><Mic className="h-4 w-4" /> Use as mic</Button>}
        <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-muted" title="Where the phone’s sound plays on this PC">
          <Volume2 className="h-4 w-4 shrink-0" />
          <select value={s.sink} onChange={(e) => mic.setSink(e.target.value)}
            className="no-drag h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-2 text-[12.5px] text-fg outline-none focus:border-accent">
            {outs.map((o) => <option key={o.id || 'default'} value={o.id}>{o.label}</option>)}
            {!outs.some((o) => o.id === s.sink) && <option value={s.sink}>{sinkLabel || 'Default speaker'}</option>}
          </select>
        </label>
      </div>
      <div className="mt-2.5 text-[12px] leading-relaxed text-muted">
        {onCable
          ? <>In Zoom, Meet, Discord or OBS, pick <b className="font-semibold text-fg">CABLE Output</b> as the microphone.</>
          : cable
            ? <>To use it as a mic in other apps, play it on <button className="no-drag text-accent" onClick={() => mic.setSink(cable.id)}>{cable.label}</button>, then pick <b className="font-semibold text-fg">CABLE Output</b> as the microphone there.</>
            : <>Plays on the speaker now. To use it as a mic in Zoom, Meet or Discord, install the free <button className="no-drag text-accent" onClick={() => api.openLink('https://vb-audio.com/Cable/')}>VB-CABLE</button> once, then choose “CABLE Input” here.</>}
      </div>
    </section>
  );
}
