// Contacts: the phone's address book on the PC — search, call (rings out from the phone), text.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Contact, Search, Star, Phone, MessageSquareText, Mail, RefreshCw, Smartphone, Copy, UserX } from 'lucide-react';
import { api } from './lib.js';
import { Avatar, Button } from './components.jsx';

const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function ContactsView({ phones, selected, onSelect, onMessage, toast }) {
  const list = Object.values(phones);
  const phone = phones[selected] || list[0] || null;
  const id = phone?.id;
  const [data, setData] = useState(null); // { list } | { error }
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null);
  const [photos, setPhotos] = useState({});
  const off = !!phone?.status?.off?.includes('contacts');

  const load = () => {
    if (!id) return;
    setLoading(true);
    api.phoneRpc(id, 'contacts')
      .then((r) => { setData({ list: Array.isArray(r.list) ? r.list : [] }); })
      .catch((e) => setData({ error: clean(e) }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { setData(null); setPick(null); setPhotos({}); if (!off) load(); }, [id, off]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D/g, '');
    const all = data?.list || [];
    const hit = !s ? all : all.filter((c) => c.name.toLowerCase().includes(s)
      || (digits.length >= 3 && c.numbers.some((n) => n.n.replace(/\D/g, '').includes(digits)))
      || c.emails?.some((m) => m.toLowerCase().includes(s)));
    return { starred: s ? [] : hit.filter((c) => c.starred), rest: hit };
  }, [data, q]);

  const current = pick && (data?.list || []).find((c) => c.id === pick);
  // Photos, a few at a time, for the open contact.
  const asked = useRef(new Set());
  useEffect(() => {
    if (!current?.photo || asked.current.has(current.id)) return;
    asked.current.add(current.id);
    api.phoneRpc(id, 'contactPhoto', { id: current.id }).then((r) => r.data && setPhotos((p) => ({ ...p, [current.id]: r.data }))).catch(() => {});
  }, [current, id]);

  const dial = (n) => api.phoneCmd(id, { type: 'dial', number: n }).then(() => toast(`Calling ${n} on ${phone.name}`)).catch((e) => toast(clean(e), 'error'));
  const copy = (t) => { navigator.clipboard.writeText(t); toast('Copied'); };

  if (!phone) return <Empty Icon={Smartphone} title="No phone connected" text="Open the DropWave app on your Android phone. Its contacts show up here." />;
  if (off) return <Empty Icon={UserX} title="Switched off on the phone" text={`Contacts sharing is off in DropWave › Privacy on ${phone.name}. Turn it on there and this page fills in by itself.`} />;
  if (data?.error && !data.list) {
    const allow = /Allow contacts/.test(data.error);
    return <Empty Icon={UserX} title={allow ? 'Allow contacts on the phone' : 'Couldn’t read contacts'} text={allow ? `In DropWave on ${phone.name}, open Privacy and tap Allow next to Contacts.` : data.error}
      action={<Button variant="soft" onClick={load}><RefreshCw className="h-4 w-4" /> Try again</Button>} />;
  }

  const Row = ({ c }) => (
    <button onClick={() => setPick(c.id)}
      className={`no-drag flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition ${pick === c.id ? 'bg-accent/12' : 'hover:bg-[var(--line)]'}`}>
      {photos[c.id] ? <img src={photos[c.id]} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <Avatar id={String(c.id)} name={c.name} size={36} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{c.name}</span>
        <span className="block truncate text-[12px] text-faint">{c.numbers[0]?.n}{c.numbers.length > 1 ? ` · +${c.numbers.length - 1}` : ''}</span>
      </span>
      {c.starred && <Star className="h-3.5 w-3.5 shrink-0 fill-warn text-warn" />}
    </button>
  );

  return (
    <div className="flex h-full">
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <div className="px-5 pb-3 pt-6">
          <div className="flex items-center justify-between">
            <h1 className="font-display text-[22px] font-semibold tracking-tight">Contacts</h1>
            <div className="flex items-center gap-1">
              {list.length > 1 && (
                <select value={id} onChange={(e) => onSelect(e.target.value)} className="no-drag h-8 rounded-lg border border-line bg-raised px-2 text-[12px]">
                  {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              <Button variant="ghost" className="h-8 w-8 !px-0" title="Refresh" onClick={load}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
            </div>
          </div>
          <div className="mt-3 flex h-9 items-center gap-2 rounded-xl border border-line bg-raised px-3">
            <Search className="h-4 w-4 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${data?.list?.length ?? ''} contacts`} style={{ outline: 'none' }}
              className="no-drag min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-faint" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {!data && <div className="px-4 py-6 text-[13px] text-muted">{loading ? `Reading contacts from ${phone.name}…` : ''}</div>}
          {shown.starred.length > 0 && <>
            <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Favourites</div>
            {shown.starred.map((c) => <Row key={`s${c.id}`} c={c} />)}
            <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-faint">All</div>
          </>}
          {shown.rest.slice(0, 1500).map((c) => <Row key={c.id} c={c} />)}
          {data?.list && !shown.rest.length && <div className="px-4 py-6 text-[13px] text-muted">{q ? 'No match.' : 'No contacts with a phone number.'}</div>}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {!current ? (
          <Empty Icon={Contact} title="Pick a contact" text="Call from the phone, send an SMS, or copy a number." />
        ) : (
          <div className="mx-auto max-w-[560px] px-7 py-10">
            <div className="flex flex-col items-center text-center">
              {photos[current.id] ? <img src={photos[current.id]} alt="" className="h-24 w-24 rounded-full object-cover" /> : <Avatar id={String(current.id)} name={current.name} size={96} />}
              <h2 className="mt-4 font-display text-[24px] font-semibold tracking-tight">{current.name}</h2>
              <div className="mt-4 flex gap-2">
                <Button variant="primary" onClick={() => dial(current.numbers[0].n)}><Phone className="h-4 w-4" /> Call</Button>
                <Button variant="soft" onClick={() => onMessage(current.numbers[0].n)}><MessageSquareText className="h-4 w-4" /> Message</Button>
              </div>
            </div>
            <div className="mt-8 space-y-2">
              {current.numbers.map((n) => (
                <div key={n.n} className="flex items-center gap-3 rounded-2xl border border-line bg-raised/60 px-4 py-3">
                  <Phone className="h-4 w-4 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium tabular">{n.n}</div>
                    <div className="text-[12px] text-faint">{n.t}</div>
                  </div>
                  <Button variant="ghost" className="h-8 w-8 !px-0" title="Call" onClick={() => dial(n.n)}><Phone className="h-4 w-4" /></Button>
                  <Button variant="ghost" className="h-8 w-8 !px-0" title="Message" onClick={() => onMessage(n.n)}><MessageSquareText className="h-4 w-4" /></Button>
                  <Button variant="ghost" className="h-8 w-8 !px-0" title="Copy" onClick={() => copy(n.n)}><Copy className="h-4 w-4" /></Button>
                </div>
              ))}
              {(current.emails || []).map((m) => (
                <div key={m} className="flex items-center gap-3 rounded-2xl border border-line bg-raised/60 px-4 py-3">
                  <Mail className="h-4 w-4 text-accent" />
                  <div className="min-w-0 flex-1 truncate text-[14px]">{m}</div>
                  <Button variant="ghost" className="h-8 w-8 !px-0" title="Copy" onClick={() => copy(m)}><Copy className="h-4 w-4" /></Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function Empty({ Icon, title, text, action }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div>
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[var(--line)]"><Icon className="h-7 w-7 text-faint" /></div>
        <div className="mt-4 font-display text-[17px] font-semibold">{title}</div>
        <div className="mx-auto mt-1 max-w-[440px] text-[13px] text-muted">{text}</div>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
