import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { MirrorApp } from './mirror.jsx';

// Stop stray drops from navigating the window to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {location.hash.includes('mirror=') ? <MirrorApp /> : <App />}
  </StrictMode>,
);
