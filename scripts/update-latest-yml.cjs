// After the installer is code-signed its bytes change, so the hash and size in latest.yml
// (what installed copies use to check an update) must be written again.
// Usage: node scripts/update-latest-yml.cjs <release dir>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = process.argv[2] || 'release';
const ymlPath = path.join(dir, 'latest.yml');
let yml = fs.readFileSync(ymlPath, 'utf8');

const file = (yml.match(/^path:\s*(.+)$/m) || [])[1]?.trim();
if (!file) throw new Error('latest.yml has no path');
const buf = fs.readFileSync(path.join(dir, file));
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');

yml = yml
  .replace(/^(\s*-?\s*url:\s*)(.+)$/m, `$1${file}`)
  .replace(/^(\s+sha512:\s*).+$/m, `$1${sha512}`)
  .replace(/^(\s+size:\s*)\d+$/m, `$1${buf.length}`)
  .replace(/^sha512:\s*.+$/m, `sha512: ${sha512}`);
fs.writeFileSync(ymlPath, yml);

// The old blockmap describes the unsigned file; without it the updater downloads the whole installer.
fs.rmSync(path.join(dir, `${file}.blockmap`), { force: true });
console.log(`latest.yml updated for ${file} (${buf.length} bytes)`);
