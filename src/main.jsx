import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { MirrorApp } from './mirror.jsx';
import { WebcamApp } from './webcam.jsx';
import { CallWindow } from './phonecalls.jsx';
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
    {location.hash.includes('mirror=') ? <MirrorApp /> : location.hash.includes('webcam=') ? <WebcamApp /> : location.hash.includes('callwin=') ? <CallWindow /> : <App />}
  </StrictMode>,
);
