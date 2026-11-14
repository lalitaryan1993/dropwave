// Remote control: moves the mouse and types on this PC for a phone that is viewing the screen.
//
// Uses the Windows SendInput API through a long-lived PowerShell helper (C# compiled on the fly
// by Add-Type), so DropWave needs no native Node module. Only main.cjs calls this, and only
// while the user has allowed control for an active screen share.
//
// Commands (one per line): m x y (absolute, 0..1 of the primary screen) | b l|r|m d|u |
// w dy | k vk d|u | t <text>
const { spawn } = require('node:child_process');

const PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DWInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT Mouse(int x, int y, uint data, uint flags) { var i = new INPUT(); i.type = 0; i.u.mi = new MOUSEINPUT { dx = x, dy = y, mouseData = data, dwFlags = flags }; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags }; return i; }
  public static void Move(double x, double y) { Send(Mouse((int)(x * 65535), (int)(y * 65535), 0, 0x0001 | 0x8000)); }
  public static void Button(string b, bool down) {
    uint f = b == "r" ? (down ? 0x0008u : 0x0010u) : b == "m" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
    Send(Mouse(0, 0, 0, f));
  }
  public static void Wheel(int dy) { Send(Mouse(0, 0, (uint)dy, 0x0800)); }
  public static void KeyVk(ushort vk, bool down) { Send(Key(vk, 0, down ? 0u : 0x0002u)); }
  public static void Text(string s) {
    foreach (char c in s) { Send(Key(0, c, 0x0004)); Send(Key(0, c, 0x0004 | 0x0002)); }
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $p = $line.Split(' ', 2)
    switch ($p[0]) {
      'm' { $a = $p[1].Split(' '); [DWInput]::Move([double]::Parse($a[0], [Globalization.CultureInfo]::InvariantCulture), [double]::Parse($a[1], [Globalization.CultureInfo]::InvariantCulture)) }
      'b' { $a = $p[1].Split(' '); [DWInput]::Button($a[0], $a[1] -eq 'd') }
      'w' { [DWInput]::Wheel([int]$p[1]) }
      'k' { $a = $p[1].Split(' '); [DWInput]::KeyVk([uint16]$a[0], $a[1] -eq 'd') }
      't' { [DWInput]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
    }
  } catch { }
}
`;

// Named keys the phone can send, as Windows virtual-key codes.
const KEYS = {
  Enter: 0x0d, Backspace: 0x08, Tab: 0x09, Escape: 0x1b, Delete: 0x2e, Space: 0x20,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  Control: 0x11, Shift: 0x10, Alt: 0x12, Meta: 0x5b,
  ...Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [c, c.charCodeAt(0)])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0x70 + i])),
};
const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

class RemoteInput {
  constructor() { this.proc = null; this.ready = null; }

  get supported() { return process.platform === 'win32'; }

  start() {
    if (!this.supported) return Promise.reject(new Error('Remote control works on Windows PCs for now'));
    if (this.ready) return this.ready;
    // The script goes in as -EncodedCommand so stdin carries only our command stream.
    const encoded = Buffer.from(PS, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = proc;
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Remote control helper did not start')), 20000);
      proc.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); resolve(); } });
      proc.on('exit', () => { clearTimeout(t); reject(new Error('Remote control helper stopped')); if (this.proc === proc) { this.proc = null; this.ready = null; } });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill();
    this.proc = null; this.ready = null;
  }

  #cmd(line) { if (this.proc?.stdin.writable) this.proc.stdin.write(line + '\n'); }

  /** One input event from the phone. Unknown or malformed events are ignored. */
  handle(e) {
    if (!e || typeof e !== 'object') return;
    const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
    switch (e.t) {
      case 'move': { const x = num(e.x, 0, 1), y = num(e.y, 0, 1); if (x != null && y != null) this.#cmd(`m ${x.toFixed(5)} ${y.toFixed(5)}`); break; }
      case 'down': case 'up': { const b = ['l', 'r', 'm'].includes(e.b) ? e.b : 'l'; this.#cmd(`b ${b} ${e.t === 'down' ? 'd' : 'u'}`); break; }
      case 'click': { const b = ['l', 'r'].includes(e.b) ? e.b : 'l'; this.#cmd(`b ${b} d`); this.#cmd(`b ${b} u`); break; }
      case 'wheel': { const dy = num(e.dy, -2400, 2400); if (dy) this.#cmd(`w ${Math.round(dy)}`); break; }
      case 'text': { const s = String(e.s || '').slice(0, 2000); if (s) this.#cmd(`t ${Buffer.from(s, 'utf8').toString('base64')}`); break; }
      case 'key': {
        // e.key: a named key; e.mods: modifiers held for this press (e.g. Ctrl+C).
        const vk = KEYS[e.key];
        if (!vk) break;
        const mods = (Array.isArray(e.mods) ? e.mods : []).filter((m) => MODS.has(m)).slice(0, 3);
        for (const m of mods) this.#cmd(`k ${KEYS[m]} d`);
        this.#cmd(`k ${vk} d`); this.#cmd(`k ${vk} u`);
        for (const m of mods.reverse()) this.#cmd(`k ${KEYS[m]} u`);
        break;
      }
    }
  }
}

module.exports = { RemoteInput };
