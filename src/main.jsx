import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { MirrorApp } from './mirror.jsx';
import { WebcamApp } from './webcam.jsx';
import { CallWindow } from './phonecalls.jsx';
// Print / scan window: loaded only there (pdf.js is big).
const DocsApp = lazy(() => import('./docs.jsx').then((m) => ({ default: m.DocsApp })));
import '../electron/web/translate.js';
import { api } from './lib.js';

// Language (Settings › Appearance › Language), for every window.
const applyLang = (s) => window.DWTranslate?.set(s?.settings?.language || 'en');
api.getState?.().then(applyLang).catch(() => {});
api.onState?.(applyLang);

// Stop stray drops from navigating the window to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {location.hash.includes('mirror=') ? <MirrorApp /> : location.hash.includes('webcam=') ? <WebcamApp /> : location.hash.includes('callwin=') ? <CallWindow /> : location.hash.includes('docs=') ? <Suspense fallback={null}><DocsApp /></Suspense> : <App />}
  </StrictMode>,
);
