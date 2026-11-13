import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Strict CSP for the packaged app only (dev needs Vite's inline HMR preamble).
const csp = {
  name: 'landrop-csp',
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
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
