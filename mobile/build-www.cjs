// Builds mobile/www from the desktop app's phone page, so the two never drift apart:
//   electron/web/index.html -> www/client.html (with bridge.js injected before the page script)
//   electron/web/*.png      -> www/
const fs = require('node:fs');
const path = require('node:path');

const web = path.join(__dirname, '..', 'electron', 'web');
const www = path.join(__dirname, 'www');

let html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const marker = '<script>\n(() => {';
if (!html.includes(marker)) throw new Error('phone page script marker not found');
html = html.replace(marker, `<script src="bridge.js"></script>\n${marker}`);
// The app has no manifest/service worker; keep the page self-contained.
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
fs.writeFileSync(path.join(www, 'client.html'), html);

for (const f of ['icon-192.png', 'icon-512.png', 'favicon.png']) fs.copyFileSync(path.join(web, f), path.join(www, f));
console.log('www built: client.html + icons');
