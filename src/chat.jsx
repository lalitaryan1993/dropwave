import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, ClipboardPaste, Copy, Check, AlertCircle, Loader2, MessagesSquare, Trash2, ExternalLink } from 'lucide-react';
import { api } from './lib.js';
import { Avatar, Button, PlatformIcon } from './components.jsx';

const URL_RE = /(https?:\/\/[^\s<>"']+)/gi;

// Message text with clickable links (opened in the default browser).
function Linkified({ text }) {
  const parts = text.split(URL_RE);
  return parts.map((p, i) => (i % 2 === 1
    ? <button key={i} onClick={() => api.openLink(p)} className="break-all text-left underline decoration-current/40 underline-offset-2 hover:decoration-current" title="Open link">{p}</button>
    : <span key={i}>{p}</span>));
}

const dayLabel = (ts) => {
  const d = new Date(ts), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};
const timeOf = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function Bubble({ m }) {
  const [copied, setCopied] = useState(false);
  const out = m.dir === 'out';
  const copy = async () => { await api.writeClipboard(m.text); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}
      className={`group flex items-end gap-1.5 ${out ? 'justify-end' : 'justify-start'}`}>
      {out && (
        <button onClick={copy} title="Copy" className="mb-1 grid h-7 w-7 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-[var(--line)] hover:text-fg group-hover:opacity-100">
          {copied ? <Check className="h-3.5 w-3.5 text-good" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
      <div className={`max-w-[72%] select-text whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed shadow-sm ${out
        ? 'grad-bg rounded-br-md text-white'
        : 'rounded-bl-md border border-line bg-raised text-fg'}`}>
        <Linkified text={m.text} />
        <div className={`mt-0.5 flex items-center justify-end gap-1 text-[10.5px] ${out ? 'text-white/75' : 'text-faint'}`}>
          {timeOf(m.at)}
          {out && m.status === 'sending' && <Loader2 className="h-3 w-3 animate-spin" />}
          {out && m.status === 'sent' && <Check className="h-3 w-3" />}
          {out && m.status === 'failed' && <AlertCircle className="h-3 w-3" />}
        </div>
      </div>
      {!out && (
        <button onClick={copy} title="Copy" className="mb-1 grid h-7 w-7 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-[var(--line)] hover:text-fg group-hover:opacity-100">
          {copied ? <Check className="h-3.5 w-3.5 text-good" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
    </motion.div>
  );
}

function Conversation({ peer, online }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const scroller = useRef(null);
  const input = useRef(null);

  useEffect(() => {
    let alive = true;
    api.chatGet(peer.id).then((m) => alive && setMessages(m));
    api.chatOpen(peer.id);
    const off = api.onChat((e) => {
      if (e.peerId !== peer.id) return;
      setMessages((list) => (e.update ? list.map((x) => (x.id === e.message.id ? e.message : x)) : [...list.filter((x) => x.id !== e.message.id), e.message]));
    });
    input.current?.focus();
    return () => { alive = false; off(); api.chatOpen(null); };
  }, [peer.id]);

  useLayoutEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || !online) return;
    setText('');
    await api.chatSend(peer.id, body);
    input.current?.focus();
  };
  const paste = async () => { const c = await api.readClipboard(); if (c) setText((t) => (t ? `${t}\n${c}` : c)); input.current?.focus(); };
  const lastFailed = [...messages].reverse().find((m) => m.dir === 'out')?.status === 'failed' ? [...messages].reverse().find((m) => m.dir === 'out') : null;

  let lastDay = '';
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-6 py-4">
        <Avatar id={peer.id} name={peer.name} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[16px] font-semibold">{peer.name}</div>
          <div className="flex items-center gap-1.5 text-[12px] text-faint">
            <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-good' : 'bg-[var(--line-strong)]'}`} />
            {online ? 'Online' : 'Offline — open DropWave on it to chat'}
            <PlatformIcon platform={peer.kind} className="ml-1 h-3.5 w-3.5" />
          </div>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" title="Clear this conversation" onClick={async () => { await api.chatClear(peer.id); setMessages([]); }}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-1.5 overflow-auto px-6 py-5">
        {messages.length === 0 && (
          <div className="grid h-full place-items-center text-center">
            <div>
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[var(--line)]"><MessagesSquare className="h-6 w-6 text-faint" /></div>
              <div className="mt-3 text-[13.5px] font-medium">Say hello to {peer.name}</div>
              <div className="mt-1 text-[12px] text-faint">Send links, notes or anything on your clipboard. It stays on your network.</div>
            </div>
          </div>
        )}
        {messages.map((m) => {
          const day = dayLabel(m.at);
          const sep = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id}>
              {sep && <div className="my-3 text-center text-[11px] font-semibold uppercase tracking-wider text-faint">{day}</div>}
              <Bubble m={m} />
            </div>
          );
        })}
        {lastFailed && <div className="pt-1 text-right text-[11.5px] text-bad">Not delivered: {lastFailed.error}</div>}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex items-end gap-2 border-t border-line px-4 py-3">
        <Button type="button" variant="ghost" className="h-10 w-10 shrink-0 px-0" onClick={paste} title="Paste clipboard"><ClipboardPaste className="h-[18px] w-[18px]" /></Button>
        <textarea
          ref={input} rows={1} value={text} disabled={!online}
          onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`; }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={online ? `Message ${peer.name}…  (Enter to send, Shift+Enter for a new line)` : `${peer.name} is offline`}
          className="max-h-[140px] min-h-10 flex-1 resize-none rounded-xl border border-line-strong bg-bg-2 px-3.5 py-2.5 text-[13.5px] outline-none transition focus:border-accent focus:shadow-[0_0_0_4px_var(--glow)] disabled:opacity-60"
        />
        <Button type="submit" variant="primary" className="h-10 shrink-0" disabled={!text.trim() || !online}><Send className="h-4 w-4" /></Button>
      </form>
    </div>
  );
}

export function ChatsView({ peers, list, selected, onSelect }) {
  // Conversations first (most recent), then nearby devices you haven't chatted with yet.
  const onlineIds = useMemo(() => new Set(peers.map((p) => p.id)), [peers]);
  const fresh = peers.filter((p) => !list.some((c) => c.peer.id === p.id));
  const current = selected && (peers.find((p) => p.id === selected) || list.find((c) => c.peer.id === selected)?.peer);

  return (
    <div className="flex h-full">
      <aside className="flex w-[290px] shrink-0 flex-col border-r border-line">
        <div className="px-5 pb-3 pt-6">
          <h1 className="font-display text-[22px] font-semibold tracking-tight">Chats</h1>
          <p className="mt-0.5 text-[12px] text-faint">Messages and links with nearby devices</p>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-auto px-3 pb-3">
          {list.map((c) => (
            <ChatRow key={c.peer.id} peer={c.peer} active={selected === c.peer.id} online={onlineIds.has(c.peer.id)}
              sub={c.last ? `${c.last.dir === 'out' ? 'You: ' : ''}${c.last.text}` : ''} unread={c.unread} onClick={() => onSelect(c.peer.id)} />
          ))}
          {fresh.length > 0 && <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-faint">Nearby</div>}
          {fresh.map((p) => (
            <ChatRow key={p.id} peer={p} active={selected === p.id} online sub="Start a conversation" onClick={() => onSelect(p.id)} />
          ))}
          {list.length === 0 && fresh.length === 0 && (
            <div className="px-3 pt-10 text-center text-[12.5px] text-faint">No devices nearby yet. Open DropWave on another PC or connect a phone.</div>
          )}
        </div>
      </aside>
      <AnimatePresence mode="wait">
        {current ? (
          <motion.div key={current.id} className="flex min-w-0 flex-1" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            <Conversation peer={current} online={onlineIds.has(current.id)} />
          </motion.div>
        ) : (
          <div className="grid flex-1 place-items-center text-center">
            <div>
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[var(--line)]"><MessagesSquare className="h-7 w-7 text-faint" /></div>
              <div className="mt-3 font-display text-[16px] font-semibold">Pick a device to chat with</div>
              <div className="mt-1 text-[12.5px] text-faint">Links you receive open with one click.</div>
            </div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ChatRow({ peer, active, online, sub, unread, onClick }) {
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition ${active ? 'bg-raised shadow-sm ring-1 ring-line' : 'hover:bg-[var(--line)]'}`}>
      <div className="relative">
        <Avatar id={peer.id} name={peer.name} size={38} />
        {online && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-good ring-2 ring-[var(--panel-solid)]" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium">{peer.name}</span>
        </div>
        <div className={`truncate text-[12px] ${unread ? 'font-medium text-fg' : 'text-faint'}`}>{sub}</div>
      </div>
      {unread > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white tabular">{unread}</span>}
    </button>
  );
}
