// Vault: things to send to the PC that couldn't go yet (PC off, phone away from the Wi-Fi).
// Kept on this phone in IndexedDB (files too, as Blobs), and sent by itself when the PC is back.
// Shared by the phone page (client.html) and the Android app's start screen (index.html).
(function () {
  const DB = 'dropwave-vault', STORE = 'items';
  const KEEP_MS = 7 * 24 * 3600 * 1000; // older items are dropped
  const MAX_BYTES = 500 * 1024 * 1024; // all items together
  let dbp = null;
  const db = () => (dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Vault is full'));
    });
  };
  const listeners = new Set();
  const changed = () => listeners.forEach((f) => { try { f(); } catch {} });

  async function list() {
    const all = (await tx('readonly', (s) => s.getAll())) || [];
    const old = all.filter((x) => Date.now() - x.at > KEEP_MS);
    if (old.length) await tx('readwrite', (s) => old.forEach((x) => s.delete(x.id)));
    return all.filter((x) => !old.includes(x)).sort((a, b) => a.at - b.at);
  }

  /** item: { text?, files?: File[], pc?: id of the PC it is for, msgId?: chat message to mark sent } */
  async function add({ text = '', files = [], pc = null, msgId = null }) {
    text = String(text || '').slice(0, 100 * 1024);
    if (!text && !files.length) return null;
    const size = files.reduce((a, f) => a + (f.size || 0), 0);
    const used = (await list()).reduce((a, x) => a + (x.size || 0), 0);
    if (used + size > MAX_BYTES) throw new Error('The vault is full (500 MB). Send or remove something first.');
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), at: Date.now(), pc, msgId, text, size,
      files: files.map((f) => ({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, blob: f })),
    };
    await tx('readwrite', (s) => s.put(item));
    changed();
    return item;
  }
  async function remove(id) { await tx('readwrite', (s) => s.delete(id)); changed(); }
  const filesOf = (item) => (item.files || []).map((f) => new File([f.blob], f.name, { type: f.type }));

  /**
   * Sends what is waiting for this PC. sendText(text, item) and sendFiles(files, item) resolve true
   * when delivered; an item that fails stays for the next time.
   */
  let flushing = false;
  async function flush(pcId, { sendText, sendFiles }) {
    if (flushing) return 0;
    flushing = true;
    let sent = 0;
    try {
      for (const item of await list()) {
        if (item.pc && item.pc !== pcId) continue;
        let ok = true;
        if (item.text) ok = await sendText(item.text, item).catch(() => false);
        if (ok && item.files?.length) ok = await sendFiles(filesOf(item), item).catch(() => false);
        if (!ok) break; // the connection dropped again: keep the rest in order
        await remove(item.id);
        sent++;
      }
    } finally { flushing = false; }
    return sent;
  }

  // Files shared into the Android app arrive as paths in its cache: read them while they exist.
  async function fromShare(d) {
    const files = [];
    for (const f of d?.files || []) {
      try {
        const r = await fetch(window.Capacitor.convertFileSrc(f.path));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        files.push(new File([await r.blob()], f.name, { type: f.type }));
      } catch (e) { console.error('DropWave vault: could not read', f.path, e); }
    }
    return { files, text: d?.text || '' };
  }

  const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const label = (x) => {
    const n = x.files?.length || 0;
    const parts = [];
    if (x.text) parts.push(/^https?:\/\//i.test(x.text.trim()) ? '🔗 ' + x.text.trim() : '💬 ' + x.text.trim());
    if (n) parts.push(`📎 ${n === 1 ? x.files[0].name : n + ' files'} · ${fmt(x.size || 0)}`);
    return parts.join('  ');
  };

  /**
   * A "Waiting to send" card in box: lists the vault with Remove buttons. Hidden when empty.
   * note: the line under the title.
   */
  function mount(box, note) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const render = async () => {
      let items = [];
      try { items = await list(); } catch {}
      if (!items.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      box.innerHTML = `<div class="vault">
        <div class="vault-h"><span><svg viewBox="0 0 24 24" style="width:17px;height:17px;vertical-align:-3px;margin-right:6px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="12" r="3"/></svg>Vault · ${items.length} waiting</span></div>
        <div class="vault-sub">${esc(typeof note === 'function' ? note() : note)}</div>
        ${items.map((x) => `<div class="vault-row"><span class="vault-t">${esc(label(x))}</span><button data-rm="${x.id}" aria-label="Remove">✕</button></div>`).join('')}
      </div>`;
      box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => remove(b.dataset.rm)));
    };
    listeners.add(render);
    render();
    return render;
  }

  window.DWVault = { add, list, remove, flush, fromShare, mount, onChange: (f) => listeners.add(f) };
})();
