// Phone page: "Print on PC" and "Scan to PC".
// Print: pick PDFs or photos; they open in a Print window on the PC (any printer the PC can use).
// Scan: in the DropWave app, a camera screen that takes page after page; in a browser, the phone's
// own camera. The PC finds each page's edges, straightens it and makes it a clean PDF.
// Uses window.DW_PAGE = { toast, pcName(), sendToPc(files, purpose) } set up by index.html.
(function () {
  const P = () => window.DW_PAGE;
  const DW = window.Capacitor?.Plugins?.DropWave || null;
  const $ = (s, r = document) => r.querySelector(s);
  const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  const css = document.createElement('style');
  css.textContent = `
  .scn { position:fixed; inset:0; z-index:80; background:#000; color:#fff; display:flex; flex-direction:column; }
  .scn video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .scn .top, .scn .bot { position:relative; z-index:1; display:flex; align-items:center; gap:10px; padding:14px 16px; }
  .scn .top { padding-top:calc(14px + env(safe-area-inset-top)); background:linear-gradient(#000a,#0000); }
  .scn .bot { margin-top:auto; flex-direction:column; padding-bottom:calc(18px + env(safe-area-inset-bottom)); background:linear-gradient(#0000,#000c); }
  .scn .ib { width:44px; height:44px; border-radius:50%; display:grid; place-items:center; background:#0006; border:1px solid #fff3; color:#fff; }
  .scn .ib svg { width:22px; height:22px; }
  .scn .ib.on { background:#fff; color:#000; }
  .scn .tt { flex:1; font-weight:700; font-size:16px; text-shadow:0 1px 4px #000; }
  .scn .hint { font-size:13px; opacity:.85; text-align:center; text-shadow:0 1px 4px #000; }
  .scn .row { display:flex; align-items:center; justify-content:space-between; width:100%; }
  .scn .shut { width:74px; height:74px; border-radius:50%; border:4px solid #fff; background:#fff3; display:grid; place-items:center; }
  .scn .shut i { width:58px; height:58px; border-radius:50%; background:#fff; display:block; transition:transform .1s; }
  .scn .shut:active i { transform:scale(.88); }
  .scn .send { min-width:96px; height:46px; border-radius:23px; padding:0 18px; font-weight:700; font-size:15px; color:#fff; border:0;
    background:linear-gradient(120deg,var(--accent,#6d5dfc),var(--accent2,#19b5d8)); }
  .scn .send:disabled { opacity:.35; }
  .scn .thumbs { display:flex; gap:8px; overflow-x:auto; width:100%; min-height:0; padding:2px 0 4px; }
  .scn .thumbs .t { position:relative; flex:0 0 auto; }
  .scn .thumbs img { height:62px; border-radius:8px; border:2px solid #fff8; display:block; }
  .scn .thumbs b { position:absolute; top:-6px; right:-6px; width:22px; height:22px; border-radius:50%; background:#000c; border:1px solid #fff6; font-size:13px; display:grid; place-items:center; }
  .scn .flash { position:absolute; inset:0; background:#fff; opacity:0; pointer-events:none; transition:opacity .25s; z-index:2; }
  .scn .frame { position:absolute; inset:12% 8% 22%; border:2px dashed #fff6; border-radius:14px; pointer-events:none; }
  `;
  document.head.appendChild(css);

  // Sharpness of a frame: variance of the Laplacian on a small grey copy (higher = crisper).
  function sharpness(src) {
    const w = 320, h = Math.round(src.height * (w / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    let sum = 0, sq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) {
      const p = y * w + xx;
      const l = 4 * g[p] - g[p - 1] - g[p + 1] - g[p - w] - g[p + w];
      sum += l; sq += l * l; n++;
    }
    const m = sum / n; return sq / n - m * m;
  }

  const PRINTABLE = /\.(pdf|jpe?g|png|webp|gif|bmp)$/i;

  function init() {
    const wrap = $('#docsWrap');
    if (!wrap) return;
    wrap.classList.remove('hidden');
    $('#printFile').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      if (files.some((f) => !PRINTABLE.test(f.name))) { P().toast('Only PDFs and photos can be printed'); return; }
      P().sendToPc(files, 'print');
    });
    $('#printBtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#printFile').click(); } });
    $('#scanFile').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) P().sendToPc(files, 'scan');
    });
    $('#scanBtn').addEventListener('click', () => open());
  }

  // Google's document scanner (live edges, auto capture, crop, clean-up) when the phone has it.
  let mlkit = !!DW?.docScan;
  async function open() {
    if (mlkit) {
      try { await DW.docScan(); return; } catch { mlkit = false; }
    }
    openCamera();
  }
  DW?.addListener?.('docScanned', async (d) => {
    if (d?.error === 'unavailable') { mlkit = false; openCamera(); return; }
    if (!d?.files?.length) return;
    const Cap = window.Capacitor;
    const files = [];
    for (const f of d.files) {
      try { const r = await fetch(Cap.convertFileSrc(f.path)); files.push(new File([await r.blob()], f.name, { type: 'image/jpeg' })); }
      catch { /* skip a page that can't be read */ }
    }
    if (files.length) P().sendToPc(files, 'scan'); else P().toast('Couldn’t read the scanned pages');
  });

  let ui = null;
  async function openCamera() {
    if (ui) return;
    // Browsers on plain http can't use the live camera: use the phone's own camera app.
    if (!DW || !navigator.mediaDevices?.getUserMedia) { $('#scanFile').click(); return; }
    const pages = []; // { blob, url }
    const el = document.createElement('div');
    el.className = 'scn';
    el.innerHTML = `
      <video autoplay playsinline muted></video><div class="frame"></div><div class="flash"></div>
      <div class="top">
        <button class="ib" data-x aria-label="Close">${I('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
        <div class="tt">Scan to ${String(P().pcName()).replace(/[<>&]/g, '')}</div>
        <button class="ib" data-torch aria-label="Torch">${I('<path d="M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12z"/><path d="M6 6h12M12 12v2"/>')}</button>
      </div>
      <div class="bot">
        <div class="hint" data-hint>Hold the page flat, with some table around it. Tap the button for each page.</div>
        <div class="thumbs" data-thumbs></div>
        <div class="row">
          <span style="width:96px"></span>
          <button class="shut" data-shot aria-label="Take page"><i></i></button>
          <button class="send" data-send disabled>Send</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    ui = el;
    const video = $('video', el);
    let stream = null, track = null, torch = false, cap = null;
    const close = () => {
      stream?.getTracks().forEach((t) => t.stop());
      pages.forEach((p) => URL.revokeObjectURL(p.url));
      el.remove(); ui = null;
      history.state?.dwScan && history.back();
    };
    // Android Back closes the scanner.
    history.pushState({ dwScan: true }, '');
    const onPop = () => { window.removeEventListener('popstate', onPop); if (ui === el) { stream?.getTracks().forEach((t) => t.stop()); el.remove(); ui = null; } };
    window.addEventListener('popstate', onPop);
    $('[data-x]', el).onclick = () => { window.removeEventListener('popstate', onPop); close(); };

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
      video.srcObject = stream;
      track = stream.getVideoTracks()[0];
      try { cap = 'ImageCapture' in window ? new ImageCapture(track) : null; } catch { cap = null; }
      const caps = track.getCapabilities?.() || {};
      if (!caps.torch) $('[data-torch]', el).style.visibility = 'hidden';
      if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    } catch (e) {
      $('[data-hint]', el).textContent = 'The camera didn’t open. Allow Camera for DropWave, or use the phone’s camera instead.';
      const alt = document.createElement('button');
      alt.className = 'send'; alt.textContent = 'Use camera app';
      alt.onclick = () => { window.removeEventListener('popstate', onPop); close(); $('#scanFile').click(); };
      $('[data-hint]', el).after(alt);
    }

    $('[data-torch]', el).onclick = () => {
      torch = !torch;
      track?.applyConstraints({ advanced: [{ torch }] }).catch(() => {});
      $('[data-torch]', el).classList.toggle('on', torch);
    };

    const renderThumbs = () => {
      const box = $('[data-thumbs]', el);
      box.innerHTML = pages.map((p, k) => `<div class="t"><img src="${p.url}" alt="Page ${k + 1}"><b data-del="${k}">×</b></div>`).join('');
      box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { const [p] = pages.splice(Number(b.dataset.del), 1); URL.revokeObjectURL(p.url); renderThumbs(); }; });
      const s = $('[data-send]', el);
      s.disabled = !pages.length;
      s.textContent = pages.length ? `Send ${pages.length}` : 'Send';
      $('[data-hint]', el).textContent = pages.length ? `${pages.length} page${pages.length > 1 ? 's' : ''}. Next page, or Send.` : 'Hold the page flat, with some table around it. Tap the button for each page.';
      box.scrollLeft = box.scrollWidth;
    };

    let busy = false;
    $('[data-shot]', el).onclick = async () => {
      if (busy || !track) return;
      busy = true;
      const fl = $('.flash', el); fl.style.opacity = '.7'; setTimeout(() => { fl.style.opacity = '0'; }, 120);
      let blob = null;
      $('[data-hint]', el).textContent = 'Hold still…';
      // Focus, then take a few frames and keep the sharpest (hands shake; one frame is often blurred).
      await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }).catch(() => {});
      await new Promise((r) => setTimeout(r, 350));
      if (video.videoWidth) {
        let best = null, bestS = -1;
        for (let k = 0; k < 4; k++) {
          const c = document.createElement('canvas');
          c.width = video.videoWidth; c.height = video.videoHeight;
          c.getContext('2d').drawImage(video, 0, 0);
          const s = sharpness(c);
          if (s > bestS) { bestS = s; best = c; }
          await new Promise((r) => setTimeout(r, 110));
        }
        blob = await new Promise((r) => best.toBlob(r, 'image/jpeg', 0.95));
      }
      if (!blob) { try { if (cap?.takePhoto) blob = await cap.takePhoto(); } catch { blob = null; } }
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      busy = false;
      if (!blob) return P().toast('Couldn’t take the picture');
      pages.push({ blob, url: URL.createObjectURL(blob) });
      renderThumbs();
    };

    $('[data-send]', el).onclick = () => {
      if (!pages.length) return;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      const files = pages.map((p, k) => new File([p.blob], `scan-${stamp}-${String(k + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
      window.removeEventListener('popstate', onPop);
      close();
      P().sendToPc(files, 'scan');
    };
  }

  // The PC asked for a scan (Home › Scan with phone): DropWave opens on the scanner.
  const takeAction = () => DW?.takeAction?.().then((r) => { if (r?.action === 'scan') open(); }).catch(() => {});
  if (DW) { DW.addListener('action', takeAction); takeAction(); }

  window.dwScan = { open };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
