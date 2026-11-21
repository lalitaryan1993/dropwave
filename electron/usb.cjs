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
    this.services = []; // Wireless debugging services seen on the network: { name, type: 'pair'|'connect', addr }
    this.ticks = 0;
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
    return { running: !!this.timer, adb: this.adb, downloading: this.downloading, error: this.error, devices: this.devices, pairable: this.services.filter((x) => x.type === 'pair') };
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
      // Wireless debugging: every ~12 s look for phones on the Wi-Fi and reconnect the paired ones
      // (their port changes after a reboot or a Wi-Fi change).
      if (this.ticks++ % 3 === 0) await this.scan();
      const r = await run(this.adb, ['devices']);
      if (!r.ok) { this.error = 'adb did not start'; return; }
      this.error = null;
      const seen = r.out.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[0]);
      const ports = this.o.ports().filter(Boolean);
      const next = [];
      for (const [serial, state] of seen) {
        const old = this.devices.find((d) => d.serial === serial);
        const d = { serial, state, wireless: serial.includes(':') || serial.includes('._adb-tls'), model: old?.model || '', reversed: !!old?.reversed && old.state === 'device' && state === 'device' && old.ports === ports.join(','), ports: ports.join(',') };
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

  /** Phones with Wireless debugging on, seen over mDNS. Connects the ones already paired. */
  async scan() {
    const r = await run(this.adb, ['mdns', 'services'], 6000);
    const list = r.out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3 && /_adb-tls-(pairing|connect)\._tcp/.test(p[1]))
      .map(([name, t, addr]) => ({ name, type: t.includes('pairing') ? 'pair' : 'connect', addr }));
    const before = JSON.stringify(this.services);
    this.services = list;
    for (const c of list.filter((x) => x.type === 'connect')) {
      if (this.devices.some((d) => d.serial === c.addr || d.serial.startsWith(c.name))) continue;
      await run(this.adb, ['connect', c.addr], 8000); // fails quietly for phones that never paired with this PC
    }
    if (JSON.stringify(list) !== before) this.emit('status', this.status());
  }

  /**
   * Pair with a phone over Wi-Fi: on the phone, Developer options > Wireless debugging > Pair device
   * with pairing code shows a 6-digit code (and an address). We find the address over mDNS if not given.
   */
  async pair(code, addr) {
    if (!this.adb && !this.findAdb()) return { ok: false, error: 'adb isn’t installed yet' };
    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6) return { ok: false, error: 'The pairing code has 6 digits' };
    let target = String(addr || '').trim();
    for (let i = 0; !target && i < 5; i++) {
      await this.scan();
      target = this.services.find((x) => x.type === 'pair')?.addr || '';
      if (!target) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!/^[\w.:[\]-]+:\d+$/.test(target)) return { ok: false, error: 'Couldn’t find the phone. Keep “Pair device with pairing code” open on the phone, or type the IP address and port it shows.' };
    const r = await run(this.adb, ['pair', target, code], 20000);
    const out = (r.out + r.err).trim();
    if (!/Successfully paired/i.test(out)) {
      const error = /wrong|incorrect|protocol fault/i.test(out) ? 'Wrong code, or the code expired. Try again with the new code.'
        : /Command failed|unable to connect|cannot connect|refused|timed out/i.test(out) ? `Couldn’t reach the phone at ${target}. Check the address and that “Pair device with pairing code” is still open.`
          : out.split(/\r?\n/).pop() || 'Pairing failed';
      return { ok: false, error };
    }
    // Connect now (the connect port is different from the pairing port).
    const host = target.replace(/:\d+$/, '');
    for (let i = 0; i < 5; i++) {
      await this.scan();
      const c = this.services.find((x) => x.type === 'connect' && x.addr.startsWith(host + ':'));
      if (c) { await run(this.adb, ['connect', c.addr], 8000); break; }
      await new Promise((res) => setTimeout(res, 1500));
    }
    this.poll();
    return { ok: true };
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
