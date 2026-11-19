// Phone calls on the PC: an incoming-call banner (Answer / Decline), "on a call" with Hang up,
// and the phone's recent calls.
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, PhoneOff, Copy, Check, Delete, Grid3x3, X } from 'lucide-react';
import { api, timeAgo } from './lib.js';
import { Avatar, Modal } from './components.jsx';

const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

function useTick(on) {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return; const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, [on]);
}

/** Floating banner while any phone rings or is on a call. */
export function CallBanner({ phones }) {
  const p = Object.values(phones).find((x) => x.call);
  const c = p?.call;
  useTick(!!c);
  // Phone-network calls go through Android's telecom API; app calls press their notification's button.
  const act = (action) => {
    if (c.key) {
      const i = c[action === 'end' ? 'end' : action];
      if (i >= 0) return api.phoneCmd(p.id, { type: 'notif', key: c.key, action: 'act', i }).catch(() => {});
      return api.phoneCmd(p.id, { type: 'notif', key: c.key, action: 'dismiss' }).catch(() => {});
    }
    return api.phoneCmd(p.id, { type: 'call', action }).catch(() => {});
  };
  const who = c ? c.name || c.number || 'Unknown number' : '';
  return (
    <AnimatePresence>
      {c && (
        <motion.div key={c.state} initial={{ opacity: 0, y: -18, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -12 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          className="fixed left-1/2 top-14 z-[58] -translate-x-1/2">
          {c.state === 'ringing' ? (
            <div className="flex w-[420px] items-center gap-4 rounded-[24px] border border-line-strong bg-panel-solid p-4 shadow-2xl">
              <div className="relative">
                <span className="absolute inset-0 animate-ping rounded-full bg-good/40" />
                <Avatar id={c.number || who} name={who} size={52} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] font-medium uppercase tracking-wider text-good">{c.app ? `${c.app} call` : 'Incoming call'} · {p.name}</div>
                <div className="truncate font-display text-[18px] font-semibold">{who}</div>
                {c.name && c.number && <div className="truncate text-[12px] text-faint tabular">{c.number}</div>}
              </div>
              <button onClick={() => act('decline')} title="Decline" className="no-drag grid h-12 w-12 place-items-center rounded-full bg-bad text-white shadow-lg active:scale-95"><PhoneOff className="h-5 w-5" /></button>
              {(!c.key || c.answer >= 0) && <button onClick={() => act('answer')} title="Answer on the phone" className="no-drag grid h-12 w-12 place-items-center rounded-full bg-good text-white shadow-lg active:scale-95"><Phone className="h-5 w-5" /></button>}
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-full border border-good/50 bg-panel-solid py-1.5 pl-4 pr-1.5 shadow-xl">
              <span className="h-2 w-2 animate-pulse rounded-full bg-good" />
              <span className="max-w-[220px] truncate text-[13px] font-semibold">{who}</span>
              <span className="text-[12px] text-faint tabular">{fmtDur(Math.floor((Date.now() - c.since) / 1000))} · {c.app ? `${c.app} · ` : ''}on {p.name}</span>
              <button onClick={() => act('end')} className="no-drag flex h-8 items-center gap-1.5 rounded-full bg-bad px-3 text-[12px] font-semibold text-white active:scale-95"><PhoneOff className="h-3.5 w-3.5" /> Hang up</button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const TYPE = {
  in: { Icon: PhoneIncoming, label: 'Incoming', cls: 'text-good' },
  out: { Icon: PhoneOutgoing, label: 'Outgoing', cls: 'text-accent' },
  missed: { Icon: PhoneMissed, label: 'Missed', cls: 'text-bad' },
  rejected: { Icon: PhoneOff, label: 'Declined', cls: 'text-faint' },
  blocked: { Icon: PhoneOff, label: 'Blocked', cls: 'text-faint' },
};

/** Home side card: the phone's last calls. */
export function RecentCalls({ phone }) {
  const access = phone.status?.callsAccess;
  const list = (phone.calls || []).slice(0, 8);
  const [copied, setCopied] = useState(null);
  const missed = list.filter((c) => c.type === 'missed' && Date.now() - c.date < 86400000).length;
  const copy = async (c) => { await api.writeClipboard(c.number); setCopied(c.id); setTimeout(() => setCopied(null), 1400); };
  const [pad, setPad] = useState(false);
  const dial = (number) => api.phoneCmd(phone.id, { type: 'dial', number }).catch(() => {});
  return (
    <section className="rounded-[22px] border border-line bg-raised/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 font-display text-[15px] font-semibold"><Phone className="h-4 w-4 text-faint" /> Recent calls</div>
        <div className="flex items-center gap-2">
          {missed > 0 && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-[11px] font-semibold text-bad">{missed} missed today</span>}
          {access === 'all' && (
            <button onClick={() => setPad(true)} title="Dial a number" className="no-drag flex h-8 items-center gap-1.5 rounded-lg bg-good/15 px-2.5 text-[12px] font-semibold text-good hover:bg-good/25">
              <Grid3x3 className="h-3.5 w-3.5" /> Dial
            </button>
          )}
        </div>
      </div>
      <AnimatePresence>{pad && <DialPad key="pad" phone={phone} onClose={() => setPad(false)} onDial={(n) => { dial(n); setPad(false); }} />}</AnimatePresence>
      {access !== 'all' ? (
        <div className="text-[12.5px] text-muted">In the DropWave app on {phone.name}, tap <b>Allow calls</b> to see who’s calling and answer from here.</div>
      ) : list.length === 0 ? (
        <div className="py-4 text-center text-[12.5px] text-faint">No recent calls.</div>
      ) : (
        <div className="-mx-2 space-y-0.5">
          {list.map((c) => {
            const t = TYPE[c.type] || TYPE.in;
            return (
              <div key={c.id} className="group flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-[var(--line)]">
                <t.Icon className={`h-4 w-4 shrink-0 ${t.cls}`} />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[13px] font-medium ${c.type === 'missed' ? 'text-bad' : ''}`}>{c.name || c.number || 'Unknown'}</div>
                  <div className="truncate text-[11.5px] text-faint">{t.label}{c.dur > 0 ? ` · ${fmtDur(c.dur)}` : ''} · {timeAgo(c.date)}</div>
                </div>
                {c.number && (
                  <>
                    <button onClick={() => copy(c)} title="Copy number" className="no-drag grid h-7 w-7 place-items-center rounded-lg text-faint opacity-0 hover:text-fg group-hover:opacity-100">
                      {copied === c.id ? <Check className="h-3.5 w-3.5 text-good" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button onClick={() => dial(c.number)} title={`Call ${c.name || c.number}`} className="no-drag grid h-7 w-7 place-items-center rounded-lg text-good opacity-0 hover:bg-good/15 group-hover:opacity-100">
                      <Phone className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

/** Dial pad: type or click a number, the phone calls it with its SIM. */
function DialPad({ phone, onClose, onDial }) {
  const [num, setNum] = useState('');
  const input = useRef(null);
  const clean = (s) => s.replace(/[^\d+*#]/g, '').slice(0, 20);
  const press = (k) => { setNum((n) => clean(n + k)); input.current?.focus(); };
  const valid = /^[+]?[\d*#]{2,20}$/.test(num);
  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between">
        <div>
          <div className="font-display text-[18px] font-semibold">Call from {phone.name}</div>
          <div className="text-[12px] text-faint">The phone dials with its SIM. Talk on the phone.</div>
        </div>
        <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-[var(--line)] hover:text-fg"><X className="h-4 w-4" /></button>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) onDial(num); }}>
        <div className="mt-5 flex items-center gap-2 border-b border-line pb-2">
          <input ref={input} autoFocus value={num} onChange={(e) => setNum(clean(e.target.value))} inputMode="tel" placeholder="Number"
            className="min-w-0 flex-1 bg-transparent text-center font-display text-[28px] font-semibold tracking-wide outline-none placeholder:text-faint/60 focus-visible:outline-none tabular" />
          {num && <button type="button" onClick={() => setNum((n) => n.slice(0, -1))} title="Delete" className="grid h-9 w-9 place-items-center rounded-lg text-faint hover:text-fg"><Delete className="h-5 w-5" /></button>}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2.5">
          {KEYS.map(([k, sub]) => (
            <button type="button" key={k} onClick={() => press(k)} onContextMenu={(e) => { if (k === '0') { e.preventDefault(); press('+'); } }}
              className="flex h-14 flex-col items-center justify-center rounded-2xl bg-[var(--line)] hover:bg-[var(--line-strong)] active:scale-95">
              <span className="font-display text-[20px] font-semibold leading-none">{k}</span>
              {sub && <span className="mt-0.5 text-[9.5px] font-semibold tracking-widest text-faint">{sub}</span>}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-center">
          <button type="submit" disabled={!valid} title="Call"
            className="grid h-14 w-14 place-items-center rounded-full bg-good text-white shadow-lg transition enabled:active:scale-95 disabled:opacity-40">
            <Phone className="h-6 w-6" />
          </button>
        </div>
      </form>
    </Modal>
  );
}
