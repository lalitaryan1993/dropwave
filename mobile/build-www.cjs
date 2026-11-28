// Builds mobile/www from the desktop app's phone page, so the two never drift apart:
//   electron/web/index.html -> www/client.html (with bridge.js injected before the page script)
//   electron/web/*.png      -> www/
const fs = require('node:fs');
const path = require('node:path');

const web = path.join(__dirname, '..', 'electron', 'web');
const www = path.join(__dirname, 'www');

// Git on Windows may check the page out with CRLF line ends.
let html = fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const marker = '<script>\n(() => {';
if (!html.includes(marker)) throw new Error('phone page script marker not found');
html = html.replace(marker, `<script src="bridge.js"></script>\n${marker}`);
// The app has no manifest/service worker; keep the page self-contained.
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
fs.writeFileSync(path.join(www, 'client.html'), html);

for (const f of ['icon-192.png', 'icon-512.png', 'favicon.png', 'rtc.js', 'phone.js', 'scan.js', 'translate.js', 'vault.js', 'look.js']) fs.copyFileSync(path.join(web, f), path.join(www, f));
fs.mkdirSync(path.join(www, 'fonts'), { recursive: true });
for (const f of fs.readdirSync(path.join(web, 'fonts'))) fs.copyFileSync(path.join(web, 'fonts', f), path.join(www, 'fonts', f));
console.log('www built: client.html + rtc.js + phone.js + icons');
