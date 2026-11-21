// Apps: the phone's apps on the PC — open on the phone or in the screen window, app info,
// uninstall (Android asks on the phone), copy the APK to this PC.
import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Search, RefreshCw, Smartphone, MonitorSmartphone, Info, Trash2, Download, Play, PackageX, PackagePlus, Loader2 } from 'lucide-react';
import { api, fmtSize } from './lib.js';
import { Avatar, Button } from './components.jsx';
import { Empty } from './contacts.jsx';

const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const SORTS = [['name', 'Name'], ['used', 'Most used (7 days)'], ['updated', 'Recently updated'], ['installed', 'Recently installed'], ['size', 'Size']];
const mins = (ms) => (ms >= 3600000 ? `${Math.round(ms / 360000) / 10} h` : `${Math.max(1, Math.round(ms / 60000))} min`);

export function AppsView({ phones, selected, onSelect, toast }) {
  const list = Object.values(phones);
  const phone = phones[selected] || list[0] || null;
  const id = phone?.id;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('name');
  const [system, setSystem] = useState(false);
  const [icons, setIcons] = useState({});
  const [menu, setMenu] = useState(null);
  const off = !!phone?.status?.off?.includes('apps');

  const load = () => {
    if (!id) return;
    setLoading(true);
    api.phoneRpc(id, 'apps').then((r) => setData({ list: Array.isArray(r.list) ? r.list : [], usage: !!r.usage })).catch((e) => setData({ error: clean(e) })).finally(() => setLoading(false));
  };
  useEffect(() => { setData(null); setIcons({}); if (!off) load(); }, [id, off]); // eslint-disable-line react-hooks/exhaustive-deps

  // Icons in batches once the list is in.
  const asked = useRef(new Set());
  useEffect(() => {
    asked.current = new Set();
    if (!data?.list?.length) return;
    let stop = false;
    (async () => {
      const pkgs = data.list.map((a) => a.pkg);
      for (let i = 0; i < pkgs.length && !stop; i += 24) {
        const part = pkgs.slice(i, i + 24).filter((p) => !asked.current.has(p));
        part.forEach((p) => asked.current.add(p));
        try { const r = await api.phoneRpc(id, 'appIcons', { pkgs: part }); if (!stop) setIcons((x) => ({ ...x, ...r.icons })); } catch { break; }
      }
    })();
    return () => { stop = true; };
  }, [data, id]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const a = (data?.list || []).filter((x) => (system || !x.system) && (!s || x.name.toLowerCase().includes(s) || x.pkg.includes(s)));
    const by = { name: (x, y) => x.name.localeCompare(y.name), used: (x, y) => (y.usedMs || 0) - (x.usedMs || 0), updated: (x, y) => y.updated - x.updated, installed: (x, y) => y.installed - x.installed, size: (x, y) => y.size - x.size }[sort];
    return a.sort(by);
  }, [data, q, sort, system]);
  const hiddenSystem = (data?.list || []).filter((x) => x.system).length;
  const recent = useMemo(() => (q ? [] : (data?.list || []).filter((x) => x.lastUsed > Date.now() - 3 * 86400000).sort((x, y) => y.lastUsed - x.lastUsed).slice(0, 8)), [data, q]);

  // Install an APK from this PC (USB cable): the button, or drop the file on this page.
  const [installing, setInstalling] = useState(false);
  const install = async (file) => {
    setInstalling(true);
    try {
      const r = await api.usbInstall(file);
      if (r?.canceled) return;
      if (r.ok) { toast(`${r.name} is installed on ${phone.name}`); load(); }
      else toast(`Couldn’t install ${r.name}: ${r.error}`, 'error');
    } catch (e) { toast(clean(e), 'error'); } finally { setInstalling(false); }
  };
  const onDrop = (e) => {
    const f = api.pathsFromFiles?.([...e.dataTransfer.files]).find((p) => /\.apk$/i.test(p));
    if (!f) return;
    e.preventDefault();
    install(f);
  };

  const act = async (app, action) => {
    setMenu(null);
    try {
      if (action === 'window') {
        // Over USB the app gets a window of its own (Elevated); otherwise show the phone's screen with it.
        const own = await api.appWinStart?.(id, app.pkg, app.name).then(() => true).catch(() => false);
        if (own) { toast(`Opening ${app.name} in its own window…`); return; }
        await api.mirrorStart(id);
        toast(`Opening ${phone.name}’s screen… Tip: with a USB cable (Settings › Phones & TVs), each app opens in a window of its own.`);
        setTimeout(() => api.phoneRpc(id, 'appAction', { pkg: app.pkg, action: 'open' }).catch(() => {}), 2500);
        return;
      }
      if (action === 'apk') { const r = await api.appApk(id, app.pkg, `${app.name} ${app.version}`.trim(), app.size); toast(`Copying ${app.name} to ${r.dir}`); return; }
      const r = await api.phoneRpc(id, 'appAction', { pkg: app.pkg, action });
      const what = { open: `Opened ${app.name}`, info: `${app.name} info is open`, uninstall: `Confirm uninstalling ${app.name} on the phone`, usage: 'Usage access settings are open' }[action];
      toast(r.result === 'notified' ? `Tap the notification on ${phone.name} to continue` : `${what} on ${phone.name}`);
    } catch (e) { toast(clean(e), 'error'); }
  };

  if (!phone) return <Empty Icon={Smartphone} title="No phone connected" text="Open the DropWave app on your Android phone. Its apps show up here." />;
  if (off) return <Empty Icon={PackageX} title="Switched off on the phone" text={`Apps sharing is off in DropWave › Privacy on ${phone.name}. Turn it on there and this page fills in by itself.`} />;
  if (data?.error) return <Empty Icon={PackageX} title="Couldn’t list the apps" text={data.error} action={<Button variant="soft" onClick={load}><RefreshCw className="h-4 w-4" /> Try again</Button>} />;

  return (
    <div className="flex h-full flex-col" onClick={() => menu && setMenu(null)} onDragOver={(e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); }} onDrop={onDrop}>
      <div className="px-7 pb-3 pt-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] font-semibold tracking-tight">Apps</h1>
            <p className="mt-1 text-[13px] text-muted">{phone.name} · {data?.list ? `${shown.length} apps` : loading ? 'reading the app list…' : ''}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {list.length > 1 && (
              <select value={id} onChange={(e) => onSelect(e.target.value)} className="no-drag h-9 rounded-xl border border-line bg-raised px-2 text-[12.5px]">
                {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <div className="flex h-9 items-center gap-2 rounded-xl border border-line bg-raised px-3">
              <Search className="h-4 w-4 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps" style={{ outline: 'none' }} className="no-drag w-40 bg-transparent text-[13px] placeholder:text-faint" />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="no-drag h-9 rounded-xl border border-line bg-raised px-2 text-[12.5px]">
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {hiddenSystem > 0 && <Button variant={system ? 'soft' : 'ghost'} onClick={() => setSystem((s) => !s)}>{system ? 'Hide' : 'Show'} {hiddenSystem} system</Button>}
            <Button variant="ghost" title="Refresh" onClick={load}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
            <Button variant="soft" title="Install an .apk from this PC on the phone (USB cable)" disabled={installing} onClick={() => install()}>
              {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} Install APK
            </Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-8">
        {data?.list && !data.usage && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-line px-4 py-3 text-[12.5px] text-muted">
            <span className="flex-1">See the apps you used lately here: turn on <b>Usage access</b> for DropWave on {phone.name}.</span>
            <Button variant="soft" onClick={() => act({ pkg: '', name: 'Usage access' }, 'usage')}>Open on the phone</Button>
          </div>
        )}
        {recent.length > 0 && (
          <>
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">Recent</div>
            <div className="mb-6 flex gap-3 overflow-x-auto pb-1">
              {recent.map((a) => (
                <button key={a.pkg} onClick={() => act(a, 'open')} title={`Open ${a.name} on the phone · ${mins(a.usedMs || 0)} this week`}
                  className="no-drag flex w-[92px] shrink-0 flex-col items-center rounded-2xl px-2 py-2.5 transition hover:bg-[var(--line)]">
                  {icons[a.pkg] ? <img src={icons[a.pkg]} alt="" className="h-12 w-12 rounded-2xl object-contain" draggable={false} /> : <Avatar id={a.pkg} name={a.name} size={48} />}
                  <span className="mt-1.5 w-full truncate text-[12px] font-medium">{a.name}</span>
                </button>
              ))}
            </div>
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">All apps</div>
          </>
        )}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
          {shown.map((a) => (
            <div key={a.pkg} className="group relative flex flex-col items-center rounded-2xl border border-line bg-raised/60 px-3 pb-3 pt-4 text-center transition hover:border-line-strong hover:bg-raised">
              <button className="no-drag flex flex-col items-center" title={`Open ${a.name} on the phone`} onClick={() => act(a, 'open')}>
                {icons[a.pkg] ? <img src={icons[a.pkg]} alt="" className="h-12 w-12 rounded-2xl object-contain" draggable={false} /> : <Avatar id={a.pkg} name={a.name} size={48} />}
                <span className="mt-2 line-clamp-2 text-[13px] font-medium leading-tight">{a.name}</span>
              </button>
              <span className="mt-1 block w-full truncate text-[11px] text-faint" title={a.version}>{sort === 'used' && a.usedMs ? `${mins(a.usedMs)} this week` : <>{a.version ? `v${a.version} · ` : ''}{fmtSize(a.size)}</>}</span>
              <div className="mt-2 flex gap-0.5 opacity-70 transition group-hover:opacity-100">
                <Button variant="ghost" className="h-7 w-7 !px-0" title="Open on the phone" onClick={() => act(a, 'open')}><Play className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" className="h-7 w-7 !px-0" title="Open in a window on this PC" onClick={() => act(a, 'window')}><MonitorSmartphone className="h-3.5 w-3.5" /></Button>
                {a.apk && <Button variant="ghost" className="h-7 w-7 !px-0" title="Copy the APK to this PC" onClick={() => act(a, 'apk')}><Download className="h-3.5 w-3.5" /></Button>}
                <Button variant="ghost" className="h-7 w-7 !px-0" title="App info on the phone" onClick={() => act(a, 'info')}><Info className="h-3.5 w-3.5" /></Button>
                {!a.system && <Button variant="danger" className="h-7 w-7 !px-0" title="Uninstall (the phone asks first)" onClick={() => act(a, 'uninstall')}><Trash2 className="h-3.5 w-3.5" /></Button>}
              </div>
            </div>
          ))}
        </div>
        {!data && loading && <div className="py-10 text-center text-[13px] text-muted"><LayoutGrid className="mx-auto mb-2 h-6 w-6 animate-pulse text-faint" />Reading apps from {phone.name}…</div>}
      </div>
    </div>
  );
}
