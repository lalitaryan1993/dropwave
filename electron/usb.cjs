// USB connection: when the phone is plugged in with USB debugging on, `adb reverse` makes the
// phone's 127.0.0.1:<web port> (and the HTTPS port) reach this PC over the cable. The phone app
// then connects to 127.0.0.1 exactly like over Wi-Fi: same PIN, same pinned certificate.
// adb is Google's tool; we use an existing copy (Android SDK, PATH) or download it on request.
const { execFile, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const ADB_ZIP = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';

function run(file, args, ms = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: ms, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') }));
  });
}

class UsbLink extends EventEmitter {
  /** @param {{ dir: string, ports: () => number[] }} o  dir = where a downloaded adb lives */
  constructor(o) {
    super();
    this.o = o;
    this.adb = null;
    this.devices = []; // { serial, state, model, reversed }
    this.timer = null;
    this.busy = false;
    this.downloading = false;
    this.error = null;
  }

  candidates() {
    const env = process.env;
    const list = [
      path.join(this.o.dir, 'platform-tools', 'adb.exe'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
      env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
      env.ANDROID_SDK_ROOT && path.join(env.ANDROID_SDK_ROOT, 'platform-tools', 'adb.exe'),
    ];
    for (const d of String(env.PATH || '').split(path.delimiter)) if (d) list.push(path.join(d, 'adb.exe'));
    return list.filter(Boolean);
  }

  findAdb() {
    this.adb = this.candidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
    return this.adb;
  }

  status() {
    return { running: !!this.timer, adb: this.adb, downloading: this.downloading, error: this.error, devices: this.devices };
  }

  #emit() { this.emit('status', this.status()); }

  start() {
    if (this.timer) return;
    this.findAdb();
    this.timer = setInterval(() => this.poll(), 4000);
    this.poll();
    this.#emit();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    // Undo our port forwards so nothing is left behind on the phone.
    if (this.adb) for (const d of this.devices.filter((x) => x.reversed)) await run(this.adb, ['-s', d.serial, 'reverse', '--remove-all']);
    this.devices = [];
    this.#emit();
  }

  async poll() {
    if (this.busy || !this.timer) return;
    this.busy = true;
    try {
      if (!this.adb && !this.findAdb()) { this.devices = []; return; }
      const r = await run(this.adb, ['devices']);
      if (!r.ok) { this.error = 'adb did not start'; return; }
      this.error = null;
      const seen = r.out.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[0]);
      const ports = this.o.ports().filter(Boolean);
      const next = [];
      for (const [serial, state] of seen) {
        const old = this.devices.find((d) => d.serial === serial);
        const d = { serial, state, model: old?.model || '', reversed: !!old?.reversed && old.state === 'device' && state === 'device' && old.ports === ports.join(','), ports: ports.join(',') };
        if (state === 'device') {
          if (!d.model) d.model = (await run(this.adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model'])).out.trim();
          if (!d.reversed && ports.length) {
            let ok = true;
            for (const p of ports) ok = (await run(this.adb, ['-s', serial, 'reverse', `tcp:${p}`, `tcp:${p}`])).ok && ok;
            d.reversed = ok;
            if (ok) this.emit('connected', d);
          }
        }
        next.push(d);
      }
      const changed = JSON.stringify(next) !== JSON.stringify(this.devices);
      this.devices = next;
      if (changed) this.#emit();
    } finally {
      this.busy = false;
    }
  }

  /** Install an APK from this PC on the phone (adb install -r). The phone may show its own check first. */
  async install(serial, apk) {
    const r = await run(this.adb, ['-s', serial, 'install', '-r', apk], 180000);
    const out = (r.out + r.err).trim();
    if (/Success/.test(out)) return { ok: true };
    const why = (out.match(/Failure \[([^\]]+)\]/) || [])[1] || out.split(/\r?\n/).pop() || 'install failed';
    return { ok: false, error: why.replace(/^INSTALL_FAILED_/, '').replace(/_/g, ' ').toLowerCase() };
  }

  /** Quick phone settings over USB (shell user): Wi-Fi and Bluetooth on/off, and their state. */
  async radios(serial) {
    const wifi = (await run(this.adb, ['-s', serial, 'shell', 'settings get global wifi_on'])).out.trim();
    const bt = (await run(this.adb, ['-s', serial, 'shell', 'settings get global bluetooth_on'])).out.trim();
    return { wifi: wifi !== '0' && wifi !== '', bluetooth: bt !== '0' && bt !== '' };
  }
  async setRadio(serial, which, on) {
    const cmd = which === 'wifi' ? `cmd wifi set-wifi-enabled ${on ? 'enabled' : 'disabled'}` : `cmd bluetooth_manager ${on ? 'enable' : 'disable'}`;
    const r = await run(this.adb, ['-s', serial, 'shell', cmd], 15000);
    return { ok: r.ok && !/Exception|Security|not allowed|Unknown/i.test(r.out + r.err), error: (r.out + r.err).trim().split(/\r?\n/).pop() };
  }

  /** A phone connected over USB with our ports forwarded, if any. */
  ready() { return this.devices.find((d) => d.state === 'device' && d.reversed) || null; }

  /**
   * Run a class from DropWave's own APK on the phone as Android's shell user (app_process), the way
   * scrcpy does. Only DropWave's code, only with USB debugging the user turned on.
   */
  helper(serial, cls, args) {
    const safe = args.map((a) => String(a)).filter((a) => /^[\w.:/-]+$/.test(a));
    if (safe.length !== args.length || !/^[\w.]+$/.test(cls)) throw new Error('bad helper arguments');
    const cmd = `CLASSPATH=$(pm path com.dropwave.app | head -1 | cut -d: -f2) exec app_process / ${cls} ${safe.join(' ')}`;
    return spawn(this.adb, ['-s', serial, 'shell', cmd], { windowsHide: true });
  }

  // Google's platform-tools (adb) into our own folder, only when the user asks for it.
  async download() {
    if (this.downloading) return this.status();
    this.downloading = true; this.error = null; this.#emit();
    try {
      fs.mkdirSync(this.o.dir, { recursive: true });
      const zip = path.join(this.o.dir, 'platform-tools.zip');
      const res = await fetch(ADB_ZIP);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      const x = await run('tar', ['-xf', zip, '-C', this.o.dir], 60000);
      fs.rmSync(zip, { force: true });
      if (!x.ok) throw new Error('could not unpack adb');
      this.findAdb();
      if (!this.adb) throw new Error('adb not found after download');
    } catch (e) {
      this.error = String(e.message || e);
    } finally {
      this.downloading = false;
      this.#emit();
      this.poll();
    }
    return this.status();
  }
}

module.exports = { UsbLink };
