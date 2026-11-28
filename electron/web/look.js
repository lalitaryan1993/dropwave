// DropWave look: light / dark / system, style, accent colour, font and motion, chosen once and
// used by every screen of the phone app (and the phone page in a browser). Kept on this device.
(function () {
  const KEY = 'dw_look';
  const STYLE_KEY = 'dw_style'; // older setting (Privacy › Look), still honoured
  const get = () => { try { return { mode: 'system', accent: 'auto', font: 'jakarta', motion: 'full', ...JSON.parse(localStorage.getItem(KEY) || '{}'), style: localStorage.getItem(STYLE_KEY) || 'aurora' }; } catch { return { mode: 'system', accent: 'auto', font: 'jakarta', motion: 'full', style: 'aurora' }; } };
  const save = (l) => { try { const { style, ...rest } = l; localStorage.setItem(KEY, JSON.stringify(rest)); localStorage.setItem(STYLE_KEY, style); } catch {} };

  // Surface tokens per style, for when light or dark is chosen by hand (system mode uses the pages' own CSS).
  const T = {
    aurora: {
      light: { bg: '#f4f5fa', panel: '#ffffffdb', raised: '#fff', line: 'rgba(20,24,40,.08)', line2: 'rgba(20,24,40,.15)', fg: '#141726', muted: '#5d6278', faint: '#8a8fa3', accent: '#6d5dfc', accent2: '#19b5d8', good: '#12a36b', bad: '#e5484d' },
      dark: { bg: '#0a0c13', panel: '#151927d9', raised: '#1a1f30', line: 'rgba(255,255,255,.07)', line2: 'rgba(255,255,255,.13)', fg: '#e9ebf4', muted: '#a1a7be', faint: '#6d7490', accent: '#8b7dff', accent2: '#2cc8ea', good: '#3ddc97', bad: '#ff6369' },
    },
    petal: {
      light: { bg: '#fff3f4', panel: '#ffffffd9', raised: '#fffafa', line: 'rgba(120,30,50,.09)', line2: 'rgba(120,30,50,.17)', fg: '#2a1520', muted: '#7a5562', faint: '#a6838f', accent: '#e5486e', accent2: '#ff9a5c' },
      dark: { bg: '#170c13', panel: '#26141fcc', raised: '#2d1828', line: 'rgba(255,200,220,.08)', line2: 'rgba(255,200,220,.15)', fg: '#f8e8ee', muted: '#c5a2b0', faint: '#8e6b7a', accent: '#ff6b8e', accent2: '#ffb07a' },
    },
    ink: {
      light: { bg: '#f3f0e8', panel: '#faf8f2', raised: '#fffdf8', line: 'rgba(30,28,22,.14)', line2: 'rgba(30,28,22,.32)', fg: '#1d1b16', muted: '#5d584c', faint: '#8f897a', accent: '#1d1b16', accent2: '#1d1b16' },
      dark: { bg: '#121212', panel: '#191919', raised: '#202020', line: 'rgba(255,255,255,.12)', line2: 'rgba(255,255,255,.28)', fg: '#ecebe6', muted: '#a9a69c', faint: '#75736b', accent: '#ecebe6', accent2: '#ecebe6' },
    },
    dots: {
      light: { bg: '#fbf6ec', panel: '#fffcf5e6', raised: '#fffaf0', line: 'rgba(90,60,10,.1)', line2: 'rgba(90,60,10,.2)', fg: '#2b2213', muted: '#6f604a', faint: '#a08f74', accent: '#e08a00', accent2: '#f2b705', dot: 'rgba(150,110,40,.2)' },
      dark: { bg: '#13110d', panel: '#1f1b14e6', raised: '#27221a', line: 'rgba(255,220,160,.08)', line2: 'rgba(255,220,160,.16)', fg: '#f3ead9', muted: '#bcae94', faint: '#847760', accent: '#ffa31a', accent2: '#ffcc33', dot: 'rgba(255,200,110,.1)' },
    },
  };
  const STYLES = [['aurora', 'Aurora'], ['petal', 'Petal'], ['ink', 'Ink'], ['dots', 'Dots']];
  const ACCENTS = [
    ['auto', 'Style', null, null],
    ['violet', 'Violet', ['#6d5dfc', '#19b5d8'], ['#8b7dff', '#2cc8ea']],
    ['ocean', 'Ocean', ['#0284c7', '#06b6d4'], ['#38bdf8', '#67e8f9']],
    ['emerald', 'Emerald', ['#059669', '#65a30d'], ['#34d399', '#a3e635']],
    ['saffron', 'Saffron', ['#ea7a00', '#f5b301'], ['#fb9a2c', '#fcd34d']],
    ['sunset', 'Sunset', ['#ea580c', '#e11d48'], ['#fb923c', '#fb7185']],
    ['rose', 'Rose', ['#db2777', '#a855f7'], ['#f472b6', '#c084fc']],
    ['indigo', 'Indigo', ['#4f46e5', '#7c3aed'], ['#818cf8', '#a78bfa']],
    ['mono', 'Mono', ['#18181b', '#52525b'], ['#f4f4f5', '#a1a1aa']],
  ];
  const darkNow = (l) => (l.mode === 'dark' ? true : l.mode === 'light' ? false : matchMedia('(prefers-color-scheme: dark)').matches);

  // Fonts and a few shared rules every page gets.
  const base = document.currentScript?.src ? document.currentScript.src.replace(/[^/]*$/, '') : '';
  const css = document.createElement('style');
  css.textContent = `
    @font-face { font-family:"DW Jakarta"; src:url("${base}fonts/jakarta.woff2") format("woff2"); font-weight:200 800; font-display:swap; unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
    @font-face { font-family:"DW Jakarta"; src:url("${base}fonts/jakarta-ext.woff2") format("woff2"); font-weight:200 800; font-display:swap; unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
    html[data-font="jakarta"] body, html[data-font="jakarta"] button, html[data-font="jakarta"] input, html[data-font="jakarta"] textarea, html[data-font="jakarta"] select { font-family:"DW Jakarta", system-ui, -apple-system, Roboto, "Noto Sans Devanagari", sans-serif; }
    html[data-font="jakarta"] body { letter-spacing:-.005em; }
    html.dw-theming, html.dw-theming * { transition:background-color .35s ease, color .35s ease, border-color .35s ease, box-shadow .35s ease !important; }
    html[data-motion="calm"] *, html[data-motion="calm"] *::before, html[data-motion="calm"] *::after { animation-duration:.01ms !important; animation-iteration-count:1 !important; transition-duration:.08s !important; }
    .dwl-sheet { position:fixed; inset:0; z-index:90; display:flex; align-items:flex-end; background:rgba(4,6,12,.5); opacity:0; pointer-events:none; transition:opacity .28s; }
    .dwl-sheet.open { opacity:1; pointer-events:auto; }
    .dwl-body { width:100%; max-width:620px; margin:0 auto; max-height:88vh; overflow-y:auto; background:var(--bg); color:var(--fg); border-radius:28px 28px 0 0; padding:8px 18px calc(18px + env(safe-area-inset-bottom)); transform:translateY(100%); transition:transform .42s cubic-bezier(.2,.8,.2,1); box-shadow:0 -20px 60px -20px rgba(0,0,0,.5); }
    .dwl-sheet.open .dwl-body { transform:none; }
    .dwl-grab { width:42px; height:5px; border-radius:3px; background:var(--line2); margin:6px auto 12px; }
    .dwl-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
    .dwl-top b { font-size:19px; font-weight:780; letter-spacing:-.02em; }
    .dwl-done { height:40px; padding:0 18px; border-radius:13px; font-weight:700; color:#fff; background:linear-gradient(120deg,var(--accent),var(--accent2)); border:0; }
    .dwl-h { font-size:11.5px; font-weight:740; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); margin:18px 2px 8px; }
    .dwl-prev { border-radius:22px; padding:16px; color:#fff; background:radial-gradient(120% 140% at 100% 0%, color-mix(in oklab, var(--accent2) 72%, transparent), transparent 55%), linear-gradient(140deg, var(--accent), color-mix(in oklab, var(--accent) 52%, #0b0d14)); display:flex; align-items:center; gap:12px; box-shadow:0 20px 44px -26px color-mix(in oklab, var(--accent) 60%, transparent); }
    .dwl-prev i { width:44px; height:44px; border-radius:14px; background:rgba(255,255,255,.2); flex:none; }
    .dwl-prev b { display:block; font-size:17px; letter-spacing:-.01em; } .dwl-prev span { font-size:12.5px; opacity:.85; }
    .dwl-seg { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; padding:5px; border-radius:16px; background:color-mix(in oklab, var(--fg) 4%, transparent); border:1px solid var(--line); }
    .dwl-seg button { height:42px; border-radius:12px; font-weight:680; font-size:14px; color:var(--muted); border:0; background:none; display:flex; align-items:center; justify-content:center; gap:7px; transition:background .25s, color .25s, transform .15s; }
    .dwl-seg button svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
    .dwl-seg button.on { background:var(--raised); color:var(--fg); box-shadow:0 6px 16px -10px rgba(0,0,0,.45); }
    .dwl-styles { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
    .dwl-styles button { border:1.5px solid var(--line); border-radius:18px; padding:8px 6px 9px; background:var(--raised); font-size:12.5px; font-weight:680; color:var(--fg); transition:border-color .2s, box-shadow .2s, transform .15s; }
    .dwl-styles button:active, .dwl-sw button:active, .dwl-seg button:active { transform:scale(.95); }
    .dwl-styles button.on { border-color:var(--accent); box-shadow:0 0 0 4px color-mix(in oklab, var(--accent) 28%, transparent); }
    .dwl-styles i { display:block; height:40px; border-radius:12px; margin-bottom:7px; }
    .dwl-sw { display:grid; grid-template-columns:repeat(9,1fr); gap:6px; }
    .dwl-sw button { aspect-ratio:1; border-radius:50%; border:0; position:relative; transition:transform .2s cubic-bezier(.34,1.56,.64,1); }
    .dwl-sw button.on { transform:scale(1.12); box-shadow:0 0 0 3px var(--bg), 0 0 0 5px var(--fg); }
    .dwl-sw button.on::after { content:""; position:absolute; left:50%; top:45%; width:22%; height:42%; border:solid #fff; border-width:0 2.5px 2.5px 0; transform:translate(-50%,-50%) rotate(45deg); }
    .dwl-sw small { grid-column:1/-1; font-size:12.5px; color:var(--faint); margin-top:4px; }
    .dwl-fonts { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .dwl-fonts button { border:1.5px solid var(--line); border-radius:18px; padding:12px; background:var(--raised); text-align:left; color:var(--fg); }
    .dwl-fonts button.on { border-color:var(--accent); box-shadow:0 0 0 4px color-mix(in oklab, var(--accent) 28%, transparent); }
    .dwl-fonts b { display:block; font-size:26px; font-weight:780; letter-spacing:-.03em; line-height:1.1; } .dwl-fonts span { font-size:12.5px; color:var(--faint); }
  `;
  document.head.appendChild(css);

  function apply(l = get(), animate = false) {
    const h = document.documentElement;
    if (animate) { h.classList.add('dw-theming'); clearTimeout(apply.t); apply.t = setTimeout(() => h.classList.remove('dw-theming'), 450); }
    h.dataset.style = l.style;
    h.dataset.font = l.font;
    h.dataset.motion = l.motion;
    h.dataset.mode = l.mode;
    const dark = darkNow(l);
    h.dataset.scheme = dark ? 'dark' : 'light';
    h.style.colorScheme = dark ? 'dark' : 'light';
    // Forced light/dark: write the style's surface tokens on <html> (beats the pages' media queries).
    const keys = ['bg', 'panel', 'raised', 'line', 'line2', 'fg', 'muted', 'faint', 'accent', 'accent2', 'good', 'bad', 'dot', 'glow', 'a1', 'a2', 'sunk'];
    keys.forEach((k) => h.style.removeProperty('--' + k));
    if (l.mode !== 'system') {
      const t = T[l.style]?.[dark ? 'dark' : 'light'] || T.aurora[dark ? 'dark' : 'light'];
      Object.entries(t).forEach(([k, v]) => h.style.setProperty('--' + k, v));
      h.style.setProperty('--sunk', dark ? 'rgba(255,255,255,.03)' : 'rgba(20,24,40,.04)');
    }
    const a = ACCENTS.find((x) => x[0] === l.accent);
    if (a && a[2]) { const [c1, c2] = dark ? a[3] : a[2]; h.style.setProperty('--accent', c1); h.style.setProperty('--accent2', c2); }
    if ((a && a[2]) || l.mode !== 'system') {
      h.style.setProperty('--glow', 'color-mix(in oklab, var(--accent) 34%, transparent)');
      h.style.setProperty('--a1', 'color-mix(in oklab, var(--accent) 15%, transparent)');
      h.style.setProperty('--a2', 'color-mix(in oklab, var(--accent2) 12%, transparent)');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(h).getPropertyValue('--bg').trim() || (dark ? '#0a0c13' : '#f4f5fa');
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => apply());
  apply();

  // ---------- the Appearance sheet ----------
  const ic = {
    sys: '<svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M11 18h2"/></svg>',
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  let sheet = null;
  function open() {
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.className = 'dwl-sheet';
      sheet.innerHTML = '<div class="dwl-body" role="dialog" aria-label="Appearance"></div>';
      sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
      document.body.appendChild(sheet);
    }
    render();
    requestAnimationFrame(() => sheet.classList.add('open'));
  }
  function close() { sheet?.classList.remove('open'); }
  function set(patch) { const l = { ...get(), ...patch }; save(l); apply(l, true); render(); try { navigator.vibrate?.(8); } catch {} document.dispatchEvent(new CustomEvent('dwlook', { detail: l })); }
  function render() {
    const l = get();
    const dark = darkNow(l);
    const sw = (k) => { const a = ACCENTS.find((x) => x[0] === k); if (!a[2]) { const t = T[l.style][dark ? 'dark' : 'light']; return `linear-gradient(135deg, ${t.accent}, ${t.accent2})`; } const c = dark ? a[3] : a[2]; return `linear-gradient(135deg, ${c[0]}, ${c[1]})`; };
    const stylePrev = (s) => { const t = T[s][dark ? 'dark' : 'light']; return `background:linear-gradient(135deg, ${t.accent} 0 34%, ${t.accent2} 34% 52%, ${t.raised} 52% 76%, ${t.bg} 76%); border:1px solid ${t.line2}`; };
    sheet.firstChild.innerHTML = `
      <div class="dwl-grab"></div>
      <div class="dwl-top"><b>Appearance</b><button class="dwl-done" data-close>Done</button></div>
      <div class="dwl-prev"><i></i><div><b>DropWave</b><span>This is how buttons and cards will look</span></div></div>
      <div class="dwl-h">Theme</div>
      <div class="dwl-seg">${[['system', 'Auto', ic.sys], ['light', 'Light', ic.sun], ['dark', 'Dark', ic.moon]].map(([k, n, i]) => `<button data-mode="${k}" class="${l.mode === k ? 'on' : ''}">${i}${n}</button>`).join('')}</div>
      <div class="dwl-h">Style</div>
      <div class="dwl-styles">${STYLES.map(([k, n]) => `<button data-style="${k}" class="${l.style === k ? 'on' : ''}"><i style="${stylePrev(k)}"></i>${n}</button>`).join('')}</div>
      <div class="dwl-h">Accent colour</div>
      <div class="dwl-sw">${ACCENTS.map(([k, n]) => `<button data-accent="${k}" class="${l.accent === k ? 'on' : ''}" style="background:${sw(k)}" aria-label="${n}" title="${n}"></button>`).join('')}<small>${ACCENTS.find((x) => x[0] === l.accent)?.[1] || 'Style'}${l.accent === 'auto' ? ' colours' : ''}</small></div>
      <div class="dwl-h">Font</div>
      <div class="dwl-fonts">
        <button data-font="jakarta" class="${l.font === 'jakarta' ? 'on' : ''}"><b style="font-family:'DW Jakarta',sans-serif">Aa</b><span>Jakarta · modern</span></button>
        <button data-font="system" class="${l.font === 'system' ? 'on' : ''}"><b style="font-family:system-ui,Roboto,sans-serif">Aa</b><span>Phone’s font</span></button>
      </div>
      <div class="dwl-h">Motion</div>
      <div class="dwl-seg" style="grid-template-columns:1fr 1fr">${[['full', 'Lively'], ['calm', 'Calm']].map(([k, n]) => `<button data-motion="${k}" class="${l.motion === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    const b = sheet.firstChild;
    b.querySelector('[data-close]').onclick = close;
    b.querySelectorAll('[data-mode]').forEach((x) => (x.onclick = () => set({ mode: x.dataset.mode })));
    b.querySelectorAll('[data-style]').forEach((x) => (x.onclick = () => set({ style: x.dataset.style })));
    b.querySelectorAll('[data-accent]').forEach((x) => (x.onclick = () => set({ accent: x.dataset.accent })));
    b.querySelectorAll('[data-font]').forEach((x) => (x.onclick = () => set({ font: x.dataset.font })));
    b.querySelectorAll('[data-motion]').forEach((x) => (x.onclick = () => set({ motion: x.dataset.motion })));
  }

  window.DWLook = { apply, open, close, get };
})();
