// Connects the shared phone page (client.html) to the Android app: which PC to talk to,
// native downloads, items shared from other apps, and the Back button.
(function () {
  const Cap = window.Capacitor;
  const DW = Cap?.Plugins?.DropWave;
  const AppP = Cap?.Plugins?.App;
  let pcs = [];
  try { pcs = JSON.parse(localStorage.getItem('dw_pcs') || '[]'); } catch { pcs = []; }
  const cur = pcs.find((p) => p.id === localStorage.getItem('dw_current'));
  if (!cur) { location.replace('index.html?pick=1'); return; }
  const save = () => localStorage.setItem('dw_pcs', JSON.stringify(pcs));

  window.DW_APP = {
    base: cur.base,
    key: cur.key || '',
    saveKey(k) { this.key = k; cur.key = k; save(); },
    download(url, name) {
      DW.download({ url, name })
        .then(() => window.dwToast?.(`Saving “${name}” to Download/DropWave`))
        .catch((e) => window.dwToast?.(`Download failed: ${e.message || e}`));
    },
    switchPC() { DW?.keepAlive({ on: false }).catch(() => {}); location.href = 'index.html?pick=1'; },
    minimize() { DW.minimize(); },
    // System notification for a file offer / message. The native side only shows it while the
    // app isn't on screen (in front, the page's own cards and toasts already show it).
    notify(n) { DW?.showNotification(n).catch((e) => console.warn('DropWave notify failed', e)); },
    clearNotify(id) { DW?.cancelNotify(id ? { id } : {}).catch(() => {}); },
    // Connected: keep the connection alive in the background (quiet "Connected to …" notification).
    connected(pcName) { DW?.keepAlive({ on: true, text: `Connected to ${pcName}` }).catch(() => {}); },
    sharedFiles: [],
    sharedText: '',
  };

  // Files shared into the app arrive as paths in the app cache; turn them into File objects.
  const say = (t) => { const go = () => (window.dwToast ? window.dwToast(t) : setTimeout(go, 150)); go(); };
  async function deliver(d) {
    if (!d) return;
    if ((d.errors || []).length && !(d.files || []).length) say('Couldn’t read the shared item — try sharing it again');
    if (!(d.files || []).length && !d.text) return;
    const files = [];
    for (const f of d.files || []) {
      try {
        const r = await fetch(Cap.convertFileSrc(f.path));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        files.push(new File([await r.blob()], f.name, { type: f.type }));
      } catch (e) { console.error('DropWave share: could not load', f.path, e); say(`Couldn’t open ${f.name}`); }
    }
    const go = () => (window.dwShare ? window.dwShare(files, d.text) : setTimeout(go, 150));
    go();
  }
  DW?.takeShared().then(deliver);
  DW?.addListener('shared', () => DW.takeShared().then(deliver));

  // Download / Decline tapped on a notification (the app may still be in the background).
  DW?.addListener('notifAction', ({ id, action }) => {
    const go = () => (window.dwNotifAction ? window.dwNotifAction(id, action) : setTimeout(go, 150));
    go();
  });

  // Back: close the photo/video viewer if open, otherwise keep DropWave running in the background.
  AppP?.addListener('backButton', () => { if (window.dwBack && window.dwBack()) return; DW?.minimize(); });
})();
