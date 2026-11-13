import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Radar as RadarIcon, History, Settings as SettingsIcon, FolderOpen, Plus, Trash2, Sun, Moon, MonitorSmartphone,
  ShieldCheck, X, Pencil, Check, ArrowUpRight, ArrowDownLeft, Inbox, UploadCloud, QrCode, RefreshCw,
  Stethoscope, Loader2, Info, AlertTriangle, Sparkles, RotateCw, MessagesSquare,
} from 'lucide-react';
import { api, fmtSize } from './lib.js';
import appIcon from '../electron/web/icon-192.png';
import { Avatar, Button, DeviceCard, Radar, TransferRow, IncomingModal, AddDeviceModal, PhoneModal, SendToModal, Toasts } from './components.jsx';
import { ChatsView } from './chat.jsx';

const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function useTheme(theme) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

export default function App() {
  const [state, setState] = useState(null);
  const [peers, setPeers] = useState([]);
  const [active, setActive] = useState({}); // id -> transfer
  const [history, setHistory] = useState([]);
  const [pending, setPending] = useState([]);
  const [view, setView] = useState('nearby');
  const [dragging, setDragging] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  const [checkSignal, setCheckSignal] = useState(0); // bump to open Settings and run the network check
  const [update, setUpdate] = useState({ state: 'idle' });
  useEffect(() => {
    api.updateState().then(setUpdate);
    return api.onUpdate((u) => setUpdate((prev) => ({ ...prev, ...u })));
  }, []);
  // Chats
  const [chatList, setChatList] = useState([]);
  const [chatPeer, setChatPeer] = useState(null);
  const where = useRef({ view: 'nearby', chatPeer: null });
  const openChatWith = useCallback((id) => { setChatPeer(id); setView('chats'); }, []);
  const [toSend, setToSend] = useState(null); // paths from Explorer's "Send with DropWave"
  useEffect(() => {
    api.pendingSend().then((p) => p?.length && setToSend(p));
    return api.onSendRequest((p) => p?.length && setToSend(p));
  }, []);
  const [toasts, setToasts] = useState([]);
  const dragDepth = useRef(0);

  const toast = useCallback((text, kind = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  useEffect(() => {
    api.getState().then((s) => {
      setState(s); setPeers(s.peers); setHistory(s.history); setPending(s.pending);
      setActive(Object.fromEntries(s.transfers.map((t) => [t.id, t])));
    });
    const offs = [
      api.onState((s) => setState(s)),
      api.onPeers(setPeers),
      api.onIncoming((r) => setPending((p) => [...p.filter((x) => x.id !== r.id), r])),
      api.onRequestClosed((id) => setPending((p) => p.filter((x) => x.id !== id))),
      api.onTransfer((t) => {
        const done = ['completed', 'failed', 'rejected', 'cancelled'].includes(t.status);
        setActive((a) => {
          const n = { ...a };
          if (done) delete n[t.id]; else n[t.id] = t;
          return n;
        });
        if (done) {
          setHistory((h) => [t, ...h.filter((x) => x.id !== t.id)]);
          if (t.status === 'failed' && t.direction === 'out') toast(t.error || 'Transfer failed', 'error');
          if (t.status === 'rejected' && t.direction === 'out') toast(`${t.to.name} declined the files`, 'error');
        }
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [toast]);

  useTheme(state?.settings.theme || 'system');

  // Chat list + "message arrived" toast when that conversation isn't on screen.
  where.current = { view, chatPeer };
  useEffect(() => {
    const refresh = () => api.chatList().then(setChatList);
    refresh();
    const offs = [
      api.onChat((e) => {
        refresh();
        const w = where.current;
        if (!e.update && e.message.dir === 'in' && !(w.view === 'chats' && w.chatPeer === e.peerId)) {
          toast(`💬 ${e.peer.name}: ${e.message.text.length > 60 ? `${e.message.text.slice(0, 57)}…` : e.message.text}`);
        }
      }),
      api.onChatRead(refresh),
      api.onOpenChat(openChatWith),
    ];
    return () => offs.forEach((f) => f());
  }, [toast, openChatWith]);

  // Window-wide drag tracking so every card can show its drop state.
  useEffect(() => {
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (!isFiles(e)) return; dragDepth.current++; setDragging(true); };
    const leave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); };
    const end = () => { dragDepth.current = 0; setDragging(false); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
    };
  }, []);

  useEffect(() => { if (dragging && view !== 'nearby') setView('nearby'); }, [dragging, view]);

  const sendPaths = async (peer, paths) => {
    try { await api.sendPaths(peer.id, paths); } catch (e) { toast(cleanErr(e), 'error'); }
  };
  const pick = async (peer, kind) => {
    try { await api.pickAndSend(peer.id, kind); } catch (e) { toast(cleanErr(e), 'error'); }
  };
  const respond = (id, accept, trust) => {
    setPending((p) => p.filter((x) => x.id !== id));
    api.respond(id, accept, trust);
  };
  const updateSettings = async (patch) => setState(await api.updateSettings(patch));

  if (!state) return <div className="aurora h-full" />;

  const activeList = Object.values(active).sort((a, b) => b.startedAt - a.startedAt);
  const busyPeers = new Set(activeList.map((t) => (t.direction === 'out' ? t.to.id : t.from.id)));
  const nav = [
    { id: 'nearby', label: 'Nearby', Icon: RadarIcon, badge: peers.length || null },
    { id: 'chats', label: 'Chats', Icon: MessagesSquare, badge: chatList.reduce((a, c) => a + (c.unread || 0), 0) || null },
    { id: 'activity', label: 'Activity', Icon: History, badge: activeList.length || null },
    { id: 'settings', label: 'Settings', Icon: SettingsIcon },
  ];

  return (
    <div className="aurora flex h-full flex-col">
      {/* title bar */}
      <header className="drag flex h-11 shrink-0 items-center gap-2.5 pl-4 pr-[150px]">
        <Logo />
        <span className="font-display text-[14px] font-semibold tracking-tight">DropWave</span>
        <span className="ml-2 rounded-md border border-line px-1.5 py-px text-[10.5px] text-faint">v{state.version}</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <aside className="flex w-[228px] shrink-0 flex-col px-3 pb-3">
          <nav className="mt-2 flex flex-col gap-1">
            {nav.map(({ id, label, Icon, badge }) => (
              <button
                key={id}
                onClick={() => setView(id)}
                className={`no-drag relative flex h-10 items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium transition-colors ${view === id ? 'text-fg' : 'text-muted hover:text-fg hover:bg-[var(--line)]'}`}
              >
                {view === id && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-xl border border-line bg-raised shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                <Icon className={`relative h-[18px] w-[18px] ${view === id ? 'text-accent' : ''}`} />
                <span className="relative flex-1 text-left">{label}</span>
                {badge && <span className="relative rounded-full bg-accent/15 px-2 text-[11px] font-semibold text-accent tabular">{badge}</span>}
              </button>
            ))}
          </nav>

          <div className="mt-auto space-y-2">
            <AnimatePresence>
              {(update.state === 'ready' || update.state === 'downloading') && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="rounded-2xl border border-accent/40 bg-accent/10 p-3">
                  <div className="flex items-center gap-2 text-[12.5px] font-semibold">
                    <Sparkles className="h-4 w-4 text-accent" />
                    {update.state === 'ready' ? `DropWave ${update.version} is ready` : `Downloading update… ${update.percent || 0}%`}
                  </div>
                  {update.state === 'ready' && (
                    <Button variant="primary" className="no-drag mt-2.5 h-8 w-full" onClick={() => api.installUpdate()}>
                      <RotateCw className="h-3.5 w-3.5" /> Restart to update
                    </Button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
            <button onClick={() => api.openSaveDir()} className="no-drag flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-muted transition hover:bg-[var(--line)] hover:text-fg">
              <FolderOpen className="h-[18px] w-[18px] shrink-0" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">Received files</span>
                <span className="block truncate text-[11px] text-faint" title={state.settings.saveDir}>{state.settings.saveDir}</span>
              </span>
            </button>
            <div className="glass flex items-center gap-3 rounded-2xl p-3">
              <Avatar id={state.me.id} name={state.me.name} size={36} />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{state.me.name}</div>
                <div className="flex items-center gap-1.5 truncate text-[11px] text-faint tabular">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-good shadow-[0_0_8px_var(--good)]" />
                  {state.me.ips[0] || 'Offline'}
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* main */}
        <main className="min-w-0 flex-1 pb-3 pr-3">
          <div className="glass relative h-full overflow-hidden rounded-[22px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={view}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18 }}
                className="h-full"
              >
                {view === 'nearby' && (
                  <Nearby
                    me={state.me} peers={peers} dragging={dragging} busyPeers={busyPeers}
                    activeList={activeList} recent={history.slice(0, 4)}
                    onDropPaths={sendPaths} onPick={pick} onAdd={() => setShowAdd(true)} onPhone={() => setShowPhone(true)} onSeeAll={() => setView('activity')}
                    onCheck={() => { setView('settings'); setCheckSignal((n) => n + 1); }}
                    onText={(p) => openChatWith(p.id)}
                  />
                )}
                {view === 'chats' && <ChatsView peers={peers} list={chatList} selected={chatPeer} onSelect={setChatPeer} />}
                {view === 'activity' && <Activity activeList={activeList} history={history} onClear={async () => setHistory(await api.clearHistory())} />}
                {view === 'settings' && <Settings state={state} update={updateSettings} chooseDir={async () => setState(await api.chooseSaveDir())} checkSignal={checkSignal} appUpdate={update} setAppUpdate={setUpdate} />}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      <AnimatePresence>
        {pending[0] && <IncomingModal key={pending[0].id} req={pending[0]} onRespond={respond} />}
        {showAdd && <AddDeviceModal onClose={() => setShowAdd(false)} onAdded={(p) => toast(`Connected to ${p.name}`)} />}
        {toSend && !pending[0] && (
          <SendToModal
            key="send-to" paths={toSend} peers={peers}
            onSend={async (peer) => { const p = toSend; setToSend(null); api.pendingSendDone(); await sendPaths(peer, p); setView('nearby'); }}
            onClose={() => { setToSend(null); api.pendingSendDone(); }}
            onPhone={() => setShowPhone(true)}
          />
        )}
        {showPhone && <PhoneModal onClose={() => setShowPhone(false)} onOpenSettings={() => { setShowPhone(false); setView('settings'); }} />}
      </AnimatePresence>
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function Logo() {
  return <img src={appIcon} alt="" width="22" height="22" className="rounded-[6px]" draggable={false} />;
}

function SectionTitle({ title, sub, right }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-[26px] font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-[13px] text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

// ---------- Nearby ----------

function Nearby({ me, peers, dragging, busyPeers, activeList, recent, onDropPaths, onPick, onAdd, onPhone, onSeeAll, onCheck, onText }) {
  // Computers first, then phones/TVs; alphabetical inside each group.
  const sorted = useMemo(() => [...peers].sort((a, b) => Number(!!a.web) - Number(!!b.web) || a.name.localeCompare(b.name)), [peers]);
  return (
    <div className="flex h-full">
      <section className="relative min-w-0 flex-1 overflow-auto p-7">
        {sorted.length === 0 ? (
          <Radar me={me} onAdd={onAdd} onPhone={onPhone} onCheck={onCheck} />
        ) : (
          <>
            <SectionTitle
              title="Nearby devices"
              sub={dragging ? 'Drop on a device to send' : 'Drag files or folders onto a device to send them'}
              right={
                <div className="flex gap-2">
                  <Button variant="soft" onClick={onPhone}><QrCode className="h-4 w-4" /> Phone or TV</Button>
                  <Button variant="ghost" onClick={onAdd}><Plus className="h-4 w-4" /> Add by IP</Button>
                </div>
              }
            />
            <motion.div layout className="mt-6 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
              <AnimatePresence>
                {sorted.map((p) => (
                  <DeviceCard key={p.id} peer={p} dragging={dragging} busy={busyPeers.has(p.id)} onDropPaths={onDropPaths} onPick={onPick} onText={onText} />
                ))}
              </AnimatePresence>
            </motion.div>
          </>
        )}

        <AnimatePresence>
          {dragging && sorted.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="pointer-events-none absolute inset-4 grid place-items-center rounded-3xl border-2 border-dashed border-line-strong bg-bg/70 backdrop-blur-sm"
            >
              <div className="text-center">
                <UploadCloud className="mx-auto h-10 w-10 text-faint" />
                <div className="mt-3 font-display text-[17px] font-semibold">No devices to send to yet</div>
                <div className="mt-1 text-[13px] text-muted">Open DropWave on another computer first</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <aside className="flex w-[330px] shrink-0 flex-col border-l border-line">
        <div className="flex items-center justify-between px-5 pb-3 pt-6">
          <div className="font-display text-[15px] font-semibold">Transfers</div>
          <button onClick={onSeeAll} className="no-drag text-[12px] text-muted hover:text-fg">See all</button>
        </div>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-auto px-4 pb-4">
          <AnimatePresence initial={false}>
            {activeList.map((t) => <TransferRow key={t.id} t={t} compact />)}
          </AnimatePresence>
          {activeList.length > 0 && recent.length > 0 && <div className="px-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-faint">Recent</div>}
          <AnimatePresence initial={false}>
            {recent.map((t) => <TransferRow key={t.id} t={t} compact />)}
          </AnimatePresence>
          {activeList.length === 0 && recent.length === 0 && (
            <div className="grid place-items-center px-6 pt-16 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[var(--line)]"><Inbox className="h-6 w-6 text-faint" /></div>
              <div className="mt-3 text-[13px] font-medium">No transfers yet</div>
              <div className="mt-1 text-[12px] text-faint">Files you send and receive will show up here.</div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------- Activity ----------

function Activity({ activeList, history, onClear }) {
  const [filter, setFilter] = useState('all');
  const list = [...activeList, ...history].filter((t) => filter === 'all' || t.direction === filter);
  const sent = history.filter((t) => t.direction === 'out' && t.status === 'completed').reduce((a, t) => a + t.total, 0);
  const recv = history.filter((t) => t.direction === 'in' && t.status === 'completed').reduce((a, t) => a + t.total, 0);

  return (
    <div className="h-full overflow-auto p-7">
      <SectionTitle
        title="Activity"
        sub="Everything you've sent and received"
        right={history.length > 0 && <Button variant="danger" onClick={onClear}><Trash2 className="h-4 w-4" /> Clear history</Button>}
      />

      <div className="mt-6 grid grid-cols-2 gap-4">
        <Stat Icon={ArrowUpRight} label="Sent" value={fmtSize(sent)} color="var(--accent)" />
        <Stat Icon={ArrowDownLeft} label="Received" value={fmtSize(recv)} color="var(--accent-2)" />
      </div>

      <div className="mt-6 inline-flex rounded-xl border border-line bg-bg-2/60 p-1">
        {[['all', 'All'], ['out', 'Sent'], ['in', 'Received']].map(([id, l]) => (
          <button key={id} onClick={() => setFilter(id)} className={`relative h-8 rounded-lg px-4 text-[12.5px] font-medium ${filter === id ? 'text-fg' : 'text-muted hover:text-fg'}`}>
            {filter === id && <motion.span layoutId="filter-pill" className="absolute inset-0 rounded-lg bg-raised shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
            <span className="relative">{l}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-2.5">
        <AnimatePresence initial={false}>
          {list.map((t) => <TransferRow key={t.id} t={t} />)}
        </AnimatePresence>
        {list.length === 0 && <div className="py-16 text-center text-[13px] text-faint">Nothing here yet.</div>}
      </div>
    </div>
  );
}

function Stat({ Icon, label, value, color }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-raised/70 p-5">
      <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full blur-2xl" style={{ background: color, opacity: 0.18 }} />
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted"><Icon className="h-4 w-4" style={{ color }} /> {label}</div>
      <div className="mt-2 font-display text-[28px] font-semibold tracking-tight tabular">{value}</div>
    </div>
  );
}

// ---------- Settings ----------

function NetworkCheck({ signal }) {
  const [checks, setChecks] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(null);
  const [note, setNote] = useState('');
  const ref = useRef(null);
  const run = useCallback(async () => {
    setBusy(true); setNote('');
    try { setChecks(await api.runChecks()); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    if (!signal) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    run();
  }, [signal, run]);
  const fix = async (id) => {
    setFixing(id); setNote('');
    try {
      const r = await api.fixCheck(id);
      setChecks(r.checks);
      if (!r.ran) setNote('The fix needs administrator permission. Click "Yes" when Windows asks.');
    } finally { setFixing(null); }
  };
  const problems = checks?.filter((c) => !c.ok && !c.info).length || 0;

  return (
    <section ref={ref} className="rounded-2xl border border-line bg-raised/60 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[11.5px] font-semibold uppercase tracking-wider text-faint">Network check</div>
        <Button variant="soft" onClick={run} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />} {checks ? 'Check again' : 'Run check'}
        </Button>
      </div>
      {!checks && !busy && <div className="text-[13px] text-muted">Can’t see your other devices? This finds the usual causes (Public network, firewall) and fixes them in one click.</div>}
      {busy && !checks && <div className="text-[13px] text-muted">Checking network, firewall and ports…</div>}
      {checks && (
        <div className="space-y-2">
          {checks.map((c) => (
            <div key={c.id} className="flex items-start gap-3 rounded-xl border border-line px-3.5 py-3">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full"
                style={{ background: c.ok ? 'color-mix(in oklab, var(--good) 18%, transparent)' : c.info ? 'var(--line)' : 'color-mix(in oklab, var(--warn) 20%, transparent)' }}>
                {c.ok ? <Check className="h-3 w-3 text-good" /> : c.info ? <Info className="h-3 w-3 text-faint" /> : <AlertTriangle className="h-3 w-3 text-warn" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{c.title}</div>
                {c.detail && <div className="mt-0.5 text-[12px] text-faint">{c.detail}</div>}
              </div>
              {c.fix && (
                <Button variant="primary" className="h-8 shrink-0" onClick={() => fix(c.id)} disabled={!!fixing}>
                  {fixing === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {c.fix}
                </Button>
              )}
            </div>
          ))}
          <div className="pt-1 text-[12px] text-faint">
            {note || (problems ? `${problems} problem(s) found. Fixes ask for administrator permission.` : 'Everything looks good on this PC. If a device is still missing, run this check on that device too.')}
          </div>
        </div>
      )}
    </section>
  );
}

function UpdatesCard({ version, appUpdate, setAppUpdate }) {
  const [busy, setBusy] = useState(false);
  const u = appUpdate || {};
  const status = {
    checking: 'Checking for updates…',
    downloading: `Downloading version ${u.version || ''}… ${u.percent || 0}%`,
    ready: `Version ${u.version} is downloaded and installs on restart.`,
    latest: 'You have the latest version.',
    error: `Couldn’t check for updates${u.error ? `: ${u.error}` : ''}.`,
  }[u.state] || (u.supported === false ? 'Updates are checked automatically in the installed app.' : 'DropWave checks for updates automatically.');
  const check = async () => { setBusy(true); try { setAppUpdate(await api.checkUpdate()); } finally { setBusy(false); } };
  return (
    <Card title="Updates">
      <Row label={`DropWave ${version}`} hint={status}>
        {u.state === 'ready'
          ? <Button variant="primary" onClick={() => api.installUpdate()}><RotateCw className="h-4 w-4" /> Restart to update</Button>
          : <Button variant="soft" onClick={check} disabled={busy || u.state === 'checking' || u.state === 'downloading'}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check for updates
            </Button>}
      </Row>
    </Card>
  );
}

function Settings({ state, update, chooseDir, checkSignal, appUpdate, setAppUpdate }) {
  const s = state.settings;
  const [name, setName] = useState(s.deviceName);
  const [editing, setEditing] = useState(false);
  const saveName = () => { setEditing(false); if (name.trim() && name !== s.deviceName) update({ deviceName: name }); else setName(s.deviceName); };

  return (
    <div className="h-full overflow-auto p-7">
      <SectionTitle title="Settings" sub="Personalise how DropWave works on this computer" />

      <div className="mt-6 max-w-[720px] space-y-4">
        <Card title="This device">
          <div className="flex items-center gap-4">
            <Avatar id={state.me.id} name={editing ? name : s.deviceName} size={56} />
            <div className="min-w-0 flex-1">
              {editing ? (
                <form onSubmit={(e) => { e.preventDefault(); saveName(); }} className="flex gap-2">
                  <input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={saveName}
                    className="h-10 flex-1 rounded-xl border border-line-strong bg-bg-2 px-3 text-[14px] outline-none focus:border-accent" />
                  <Button type="submit" variant="primary"><Check className="h-4 w-4" /></Button>
                </form>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="truncate font-display text-[17px] font-semibold">{s.deviceName}</div>
                  <button onClick={() => setEditing(true)} className="grid h-7 w-7 place-items-center rounded-lg text-faint hover:bg-[var(--line)] hover:text-fg" title="Rename"><Pencil className="h-3.5 w-3.5" /></button>
                </div>
              )}
              <div className="mt-1 text-[12.5px] text-faint tabular">
                IP {state.me.ips.join(', ') || '—'} · port {state.me.port}
              </div>
            </div>
          </div>
          <Row label="Security code" hint="Transfers between PCs are end-to-end encrypted. Compare this code with the other PC to be sure you're talking to the right device.">
            <span className="shrink-0 whitespace-nowrap rounded-lg border border-line bg-bg-2/60 px-3 py-1.5 font-mono text-[13px] tracking-wider tabular">{state.me.fingerprint || '—'}</span>
          </Row>
          <Row label="Forget remembered devices" hint="Use this if a device shows a security warning because DropWave was reinstalled on it.">
            <Button variant="soft" onClick={async () => { await api.forgetKeys(); }}><ShieldCheck className="h-4 w-4" /> Forget</Button>
          </Row>
        </Card>

        <NetworkCheck signal={checkSignal} />

        <UpdatesCard version={state.version} appUpdate={appUpdate} setAppUpdate={setAppUpdate} />

        <Card title="Phones & TVs">
          <Row label="Allow phones, tablets and TVs" hint="They connect from their web browser using a QR code or PIN">
            <Toggle on={s.webEnabled} set={(v) => update({ webEnabled: v })} />
          </Row>
          {s.webEnabled && (
            <Row label="Connection PIN" hint={state.web.error || (state.web.primary ? `Open ${state.web.primary.replace('http://', '')} on the phone` : 'Not connected to a network')}>
              <div className="flex items-center gap-2">
                <span className="rounded-lg border border-line bg-bg-2/60 px-3 py-1.5 font-display text-[16px] font-semibold tracking-[.18em] tabular">{s.webPin}</span>
                <Button variant="ghost" onClick={() => api.resetPin()} title="New PIN (disconnects phones)"><RefreshCw className="h-4 w-4" /></Button>
              </div>
            </Row>
          )}
        </Card>

        <Card title="Received files">
          <Row label="Save to" hint={s.saveDir}>
            <Button variant="soft" onClick={chooseDir}><FolderOpen className="h-4 w-4" /> Change</Button>
          </Row>
        </Card>

        <Card title="Appearance">
          <div className="grid grid-cols-3 gap-2.5">
            {[['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', MonitorSmartphone]].map(([id, l, Icon]) => (
              <button key={id} onClick={() => update({ theme: id })}
                className={`flex h-20 flex-col items-center justify-center gap-2 rounded-2xl border text-[13px] font-medium transition ${s.theme === id ? 'border-accent bg-accent/10 text-fg shadow-[0_0_0_3px_var(--glow)]' : 'border-line text-muted hover:border-line-strong hover:text-fg'}`}>
                <Icon className="h-5 w-5" /> {l}
              </button>
            ))}
          </div>
        </Card>

        <Card title="Behaviour">
          <Row label="Start with Windows" hint="Run quietly in the tray so others can always send to you">
            <Toggle on={s.autoStart} set={(v) => update({ autoStart: v })} />
          </Row>
          <Row label="Keep running when closed" hint="Closing the window hides DropWave to the system tray">
            <Toggle on={s.closeToTray} set={(v) => update({ closeToTray: v })} />
          </Row>
          <Row label="Notifications" hint="Show a Windows notification for incoming files">
            <Toggle on={s.notifications} set={(v) => update({ notifications: v })} />
          </Row>
        </Card>

        <Card title="Trusted devices">
          <Row label="Auto-accept from trusted devices" hint="Files from these devices are saved without asking">
            <Toggle on={s.autoAcceptTrusted} set={(v) => update({ autoAcceptTrusted: v })} />
          </Row>
          {s.trusted.length === 0 ? (
            <div className="flex items-center gap-2 pt-2 text-[12.5px] text-faint"><ShieldCheck className="h-4 w-4" /> No trusted devices. Tick "Always accept" when receiving files to add one.</div>
          ) : (
            <div className="space-y-1.5 pt-2">
              {s.trusted.map((d) => (
                <div key={d.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
                  <Avatar id={d.id} name={d.name} size={28} />
                  <span className="flex-1 text-[13px]">{d.name}</span>
                  <button onClick={() => update({ trusted: s.trusted.filter((x) => x.id !== d.id) })} className="grid h-7 w-7 place-items-center rounded-lg text-faint hover:bg-[var(--line)] hover:text-bad" title="Remove"><X className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className="rounded-2xl border border-line bg-raised/60 p-5">
      <div className="mb-4 text-[11.5px] font-semibold uppercase tracking-wider text-faint">{title}</div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 truncate text-[12px] text-faint" title={hint}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, set }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => set(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'grad-bg' : 'bg-[var(--line-strong)]'}`}>
      <motion.span layout transition={{ type: 'spring', stiffness: 600, damping: 35 }}
        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow" style={{ left: on ? 22 : 2 }} />
    </button>
  );
}
