// Messages: the phone's SMS on the PC. Conversations on the left, the open one on the right,
// reply or start a new message (sent by the phone with its SIM).
import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquareText, Search, PenSquare, Send, Phone, Copy, Check, Loader2, Smartphone, MessageSquareOff, RefreshCw, AlertCircle } from 'lucide-react';
import { api, timeAgo } from './lib.js';
import { Avatar, Button } from './components.jsx';

const dayOf = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const hhmm = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
// SMS parts: 160 characters (GSM) or 70 (Unicode, e.g. Hindi / emoji); longer messages are split.
const parts = (t) => { const uni = /[^\x00-\x7f]/.test(t); const one = uni ? 70 : 160, many = uni ? 67 : 153; return t.length <= one ? 1 : Math.ceil(t.length / many); };

export function MessagesView({ phones, selected, onSelect, toast }) {
  const list = Object.values(phones);
  const phone = phones[selected] || list[0] || null;
  const id = phone?.id;
  const [m, setM] = useState(null);
  const [q, setQ] = useState('');
  const [composeTo, setComposeTo] = useState(null); // '' = new message
  const access = m?.access ?? phone?.status?.smsAccess ?? null;
  const fail = (e) => toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');

  useEffect(() => {
    if (!id) return;
    setM(null);
    api.smsGet(id).then((d) => { setM(d); if (d && !d.threads.length && !d.loading) api.smsLoad(id).catch(() => {}); });
    return api.onSms((d) => d.id === id && setM(d));
  }, [id]);

  // Messages were just allowed on the phone: load.
  const prev = useRef(access);
  useEffect(() => { if (id && prev.current !== 'all' && phone?.status?.smsAccess === 'all') api.smsLoad(id); prev.current = phone?.status?.smsAccess; }, [phone?.status?.smsAccess, id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Switched on again in DropWave › Privacy on the phone: load.
  const smsOff = !!phone?.status?.off?.includes('sms');
  const wasOff = useRef(smsOff);
  useEffect(() => { if (id && wasOff.current && !smsOff) api.smsLoad(id).catch(() => {}); wasOff.current = smsOff; }, [smsOff, id]);

  const threads = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (m?.threads || []).filter((t) => !s || `${t.name} ${t.address} ${t.snippet}`.toLowerCase().includes(s));
  }, [m, q]);
  const open = m?.open;

  if (!phone) return <Empty Icon={Smartphone} title="No phone connected" text="Open the DropWave app on your Android phone. Its text messages show up here." />;
  if (smsOff) return <Empty Icon={MessageSquareOff} title="Switched off on the phone" text={`Messages sharing is off in DropWave › Privacy on ${phone.name}. Turn it on there and this page fills in by itself.`} />;
  if (access && access !== 'all' && !(m?.threads || []).length) {
    return <Empty Icon={MessageSquareOff} title="Allow messages on the phone" text={`In the DropWave app on ${phone.name}, tap “Allow messages” on Home. Android asks for SMS and Contacts (for names).`} />;
  }

  return (
    <div className="flex h-full">
      {/* conversations */}
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-line">
        <div className="px-5 pb-3 pt-6">
          <div className="flex items-center justify-between">
            <h1 className="font-display text-[22px] font-semibold tracking-tight">Messages</h1>
            <div className="flex gap-1">
              <Button variant="ghost" className="h-8 w-8 !px-0" title="Refresh" onClick={() => api.smsLoad(id).catch(fail)}><RefreshCw className={`h-4 w-4 ${m?.loading ? 'animate-spin' : ''}`} /></Button>
              <Button variant="soft" className="h-8" onClick={() => { setComposeTo(''); api.smsOpen(id, null, '').catch(fail); }}><PenSquare className="h-4 w-4" /> New</Button>
            </div>
          </div>
          {list.length > 1 && (
            <select value={id} onChange={(e) => onSelect(e.target.value)} className="no-drag mt-2 h-8 w-full rounded-lg border border-line bg-raised px-2 text-[12.5px]">
              {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <div className="mt-3 flex h-9 items-center gap-2 rounded-xl border border-line bg-bg-2/60 px-3">
            <Search className="h-4 w-4 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none focus-visible:outline-none" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
          {!m || (m.loading && !m.threads.length) ? (
            <div className="space-y-2 px-2">{Array.from({ length: 8 }, (_, i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-[var(--line)]" />)}</div>
          ) : m.error ? (
            <div className="px-3 py-6 text-[12.5px] text-bad">{m.error}</div>
          ) : threads.length === 0 ? (
            <div className="px-3 py-10 text-center text-[12.5px] text-faint">{q ? 'No matches.' : 'No messages.'}</div>
          ) : threads.map((t) => {
            const on = open && !composeTo && open.address === t.address;
            return (
              <button key={`${t.thread}-${t.address}`} onClick={() => { setComposeTo(null); api.smsOpen(id, t.thread, t.address).catch(fail); }}
                className={`no-drag flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${on ? 'bg-accent/12' : 'hover:bg-[var(--line)]'}`}>
                <Avatar id={t.address} name={t.name || t.address} size={38} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className={`truncate text-[13.5px] ${t.unread ? 'font-bold' : 'font-semibold'}`}>{t.name || t.address}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">{timeAgo(t.date).replace(' ago', '')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-[12.5px] ${t.unread ? 'text-fg' : 'text-faint'}`}>{t.out ? 'You: ' : ''}{t.snippet}</span>
                    {t.unread > 0 && <span className="ml-auto grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-accent px-1 text-[10.5px] font-bold text-white">{t.unread}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* conversation */}
      <section className="flex min-w-0 flex-1 flex-col">
        {composeTo != null || open ? (
          <Conversation key={composeTo != null ? 'new' : open.address} phone={phone} open={composeTo != null ? { address: '', messages: [] } : open}
            thread={m?.threads.find((t) => t.address === open?.address)} isNew={composeTo != null}
            onSent={(to) => { setComposeTo(null); }} toast={toast} />
        ) : (
          <div className="grid flex-1 place-items-center text-center">
            <div>
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[var(--line)]"><MessageSquareText className="h-7 w-7 text-faint" /></div>
              <div className="mt-4 font-display text-[16px] font-semibold">Pick a conversation</div>
              <div className="mt-1 text-[12.5px] text-muted">Messages are sent by {phone.name} with its SIM.</div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Conversation({ phone, open, thread, isNew, onSent, toast }) {
  const [to, setTo] = useState(open.address || '');
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(null);
  const box = useRef(null);
  const name = thread?.name || open.address;
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [open.messages.length]);
  const send = async (e) => {
    e?.preventDefault();
    const dest = isNew ? to.trim() : open.address;
    if (!dest || !text.trim()) return;
    try { await api.smsSend(phone.id, dest, text.trim()); setText(''); if (isNew) onSent(dest); } catch (err) { toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); }
  };
  const copy = async (code, key) => { await api.writeClipboard(code); setCopied(key); setTimeout(() => setCopied(null), 1400); };
  let lastDay = '';
  return (
    <>
      <div className="flex h-[68px] shrink-0 items-center gap-3 border-b border-line px-6">
        {isNew ? (
          <div className="flex flex-1 items-center gap-3">
            <span className="text-[13px] font-semibold text-muted">To</span>
            <input autoFocus value={to} onChange={(e) => setTo(e.target.value.replace(/[^\d+ ]/g, '').slice(0, 20))} inputMode="tel" placeholder="Phone number"
              className="h-10 min-w-0 flex-1 rounded-xl border border-line-strong bg-raised px-3 text-[14px] outline-none focus:border-accent tabular" />
          </div>
        ) : (
          <>
            <Avatar id={open.address} name={name} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-[15.5px] font-semibold">{name}</div>
              {thread?.name && <div className="truncate text-[12px] text-faint tabular">{open.address}</div>}
            </div>
            {phone.status?.callsAccess === 'all' && /\d{3,}/.test(open.address) && (
              <Button variant="soft" onClick={() => api.phoneCmd(phone.id, { type: 'dial', number: open.address })}><Phone className="h-4 w-4" /> Call</Button>
            )}
          </>
        )}
      </div>
      <div ref={box} className="min-h-0 flex-1 space-y-1.5 overflow-auto px-6 py-4">
        {open.loading && !open.messages.length && <div className="grid place-items-center py-10"><Loader2 className="h-5 w-5 animate-spin text-faint" /></div>}
        {open.error && <div className="mx-auto max-w-[420px] rounded-2xl border border-bad/40 bg-bad/10 px-4 py-3 text-center text-[12.5px]">{open.error}</div>}
        {open.messages.map((msg) => {
          const day = dayOf(msg.date);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={msg.id}>
              {showDay && <div className="my-3 text-center text-[11px] font-semibold uppercase tracking-wider text-faint">{day}</div>}
              <div className={`flex ${msg.out ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed ${msg.out ? 'rounded-br-md grad-bg text-white' : 'rounded-bl-md border border-line bg-raised'} ${msg.pending ? 'opacity-70' : ''}`}>
                  <div className="whitespace-pre-wrap break-words select-text">{msg.body}</div>
                  <div className={`mt-0.5 flex items-center justify-end gap-1.5 text-[10.5px] ${msg.out ? 'text-white/75' : 'text-faint'}`}>
                    {msg.failed && <span className="flex items-center gap-1 font-semibold text-bad"><AlertCircle className="h-3 w-3" /> Not sent</span>}
                    {msg.pending && !msg.failed && <span>Sending…</span>}
                    <span>{hhmm(msg.date)}</span>
                  </div>
                  {msg.code && (
                    <button onClick={() => copy(msg.code, msg.id)} className="no-drag mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-lg grad-bg px-2.5 text-[12px] font-semibold text-white">
                      {copied === msg.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === msg.id ? 'Copied' : `Copy ${msg.code}`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <form onSubmit={send} className="flex shrink-0 items-end gap-2 border-t border-line p-4">
        <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 2000))} rows={1} placeholder="Text message"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e); }}
          className="max-h-40 min-h-[42px] flex-1 resize-none rounded-2xl border border-line-strong bg-raised px-3.5 py-2.5 text-[13.5px] outline-none focus:border-accent" />
        <div className="flex flex-col items-end gap-1">
          {text && <span className="text-[10.5px] text-faint tabular">{text.length} · {parts(text)} SMS</span>}
          <Button type="submit" variant="primary" className="h-[42px] w-[42px] !px-0" disabled={!text.trim() || (isNew && !to.trim())}><Send className="h-4 w-4" /></Button>
        </div>
      </form>
    </>
  );
}

function Empty({ Icon, title, text }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div>
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[var(--line)]"><Icon className="h-7 w-7 text-faint" /></div>
        <div className="mt-4 font-display text-[17px] font-semibold">{title}</div>
        <div className="mx-auto mt-1 max-w-[420px] text-[13px] text-muted">{text}</div>
      </div>
    </div>
  );
}
