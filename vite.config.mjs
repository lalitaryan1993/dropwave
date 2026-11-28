import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Strict CSP for the packaged app only (dev needs Vite's inline HMR preamble).
const csp = {
  name: 'dropwave-csp',
  apply: 'build',
  transformIndexHtml: () => [{
    tag: 'meta',
    attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" },
    injectTo: 'head-prepend',
  }],
};

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), csp],
  // The Android project and its generated files change during app builds: not part of the PC UI.
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/mobile/**', '**/marketing/**', '**/dist/**', '**/release/**'] } },
  build: { outDir: 'dist', emptyOutDir: true },
});
