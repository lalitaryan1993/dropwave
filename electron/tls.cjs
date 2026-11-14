// Self-signed TLS certificate for the phone/TV web server, built with node:crypto only.
//
// The Android app pins this certificate's SHA-256 fingerprint the first time it pairs with the
// PC (trust on first use, like PC-to-PC identities), so no certificate authority is involved.

const crypto = require('node:crypto');
const fs = require('node:fs');

// ---- minimal DER encoding (just what an X.509 v1-style certificate needs) ----
const derLen = (n) => {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  while (n) { b.unshift(n & 255); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, ...parts) => { const v = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), derLen(v.length), v]); };
const seq = (...p) => tlv(0x30, ...p);
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const oid = (s) => {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const n of a.slice(2)) {
    const b = [n & 127];
    for (let x = n >> 7; x; x >>= 7) b.unshift((x & 127) | 128);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
};
const time = (d) => {
  const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
};
const name = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

/** A new P-256 key and a self-signed certificate valid for 20 years. */
function makeCert(cn = 'DropWave') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const now = Date.now();
  const tbs = seq(
    int(serial),
    ECDSA_SHA256,
    name(cn),
    seq(time(new Date(now - 86400e3)), time(new Date(now + 20 * 365 * 86400e3))),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const cert = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sig));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', cert) };
}

/** Lower-case hex SHA-256 of the certificate (what the app pins). */
const fingerprint = (certPem) => new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();

/** Load the PC's certificate from `file`, creating it the first time (or if the file is unusable). */
function loadOrCreate(file) {
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    const x = new crypto.X509Certificate(t.cert);
    if (x.checkPrivateKey(crypto.createPrivateKey(t.key)) && new Date(x.validTo) > new Date(Date.now() + 30 * 86400e3)) return t;
  } catch { /* missing or broken: make a new one */ }
  const t = makeCert();
  fs.writeFileSync(file, JSON.stringify(t), { mode: 0o600 });
  return t;
}

module.exports = { makeCert, fingerprint, loadOrCreate };
