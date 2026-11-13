// "Why can't my devices see each other?" — checks the usual Windows causes and fixes them.
// Fixes need admin rights, so they run through an elevated PowerShell (the user sees UAC).

const { execFile } = require('node:child_process');
const { localIPv4s } = require('./engine.cjs');

const ps = (script, timeout = 15000) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout.trim()));
});
const psJson = async (script) => {
  const out = await ps(`${script} | ConvertTo-Json -Compress -Depth 4`);
  if (!out) return [];
  try { const v = JSON.parse(out); return Array.isArray(v) ? v : [v]; } catch { return []; }
};
// Single-quoted PowerShell string literal.
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * @param {object} ctx
 * @param {string} ctx.exe          path of the running executable
 * @param {boolean} ctx.engineOk    PC transfer port is listening
 * @param {boolean} ctx.webOk       phone/TV port is listening (or disabled)
 * @param {number} ctx.peerCount
 */
async function runChecks(ctx) {
  const checks = [];
  const nets = localIPv4s().filter((n) => !n.virtual);

  checks.push(nets.length
    ? { id: 'network', ok: true, title: 'Connected to a network', detail: nets.map((n) => `${n.ifname}: ${n.address}`).join(' · ') }
    : { id: 'network', ok: false, title: 'Not connected to Wi-Fi or LAN', detail: 'Connect this PC to the same Wi-Fi or router as your other devices.' });

  if (process.platform === 'win32') {
    const [profiles, rules] = await Promise.all([
      psJson('Get-NetConnectionProfile | Select-Object InterfaceAlias, @{n="Category";e={[string]$_.NetworkCategory}}'),
      psJson(`Get-NetFirewallApplicationFilter -Program ${q(ctx.exe)} -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Select-Object DisplayName, @{n="Dir";e={[string]$_.Direction}}, @{n="Act";e={[string]$_.Action}}, @{n="On";e={[string]$_.Enabled}}`),
    ]);

    const realNames = new Set(nets.map((n) => n.ifname));
    const publicNets = profiles.filter((p) => realNames.has(p.InterfaceAlias) && p.Category === 'Public');
    checks.push(publicNets.length
      ? { id: 'profile', ok: false, title: `"${publicNets.map((p) => p.InterfaceAlias).join(', ')}" is set to Public`,
        detail: 'Windows hides this PC from other devices on Public networks. Switch it to Private if this is your home or office network.',
        fix: 'Make it Private', fixArg: publicNets.map((p) => p.InterfaceAlias) }
      : { id: 'profile', ok: true, title: 'Network type is Private', detail: 'Other devices are allowed to see this PC.' });

    const inbound = rules.filter((r) => r.Dir === 'Inbound' && r.On === 'True');
    const blocked = inbound.filter((r) => r.Act === 'Block');
    const allowed = inbound.filter((r) => r.Act === 'Allow');
    if (blocked.length) {
      checks.push({ id: 'firewall', ok: false, title: 'Windows Firewall is blocking DropWave',
        detail: 'This usually happens when the firewall prompt was cancelled. Other devices can’t reach this PC.', fix: 'Unblock' });
    } else if (!allowed.length) {
      checks.push({ id: 'firewall', ok: false, title: 'DropWave is not allowed through Windows Firewall',
        detail: 'Other devices may not be able to send files to this PC.', fix: 'Allow' });
    } else {
      checks.push({ id: 'firewall', ok: true, title: 'Allowed through Windows Firewall', detail: `${allowed.length} inbound rule(s) for DropWave` });
    }
  }

  checks.push(ctx.engineOk && ctx.webOk
    ? { id: 'ports', ok: true, title: 'DropWave is listening', detail: 'Ready to receive from PCs, phones and TVs.' }
    : { id: 'ports', ok: false, title: 'A DropWave port is in use by another program', detail: 'Close other copies of DropWave, or restart the PC.' });

  checks.push({ id: 'peers', ok: ctx.peerCount > 0, info: ctx.peerCount === 0,
    title: ctx.peerCount ? `${ctx.peerCount} device(s) found nearby` : 'No other devices found yet',
    detail: ctx.peerCount ? '' : 'Open DropWave on another PC on the same network, or connect a phone with the QR code.' });

  return checks;
}

// Runs a script elevated (UAC prompt). Resolves true if it ran, false if the user said No.
function runElevated(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `try { Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; exit 0 } catch { exit 1 }`],
    { windowsHide: true, timeout: 120000 }, (err) => resolve(!err));
  });
}

async function fix(id, ctx, check) {
  if (id === 'profile') {
    const names = (check?.fixArg || []).map(q).join(',');
    return runElevated(`Set-NetConnectionProfile -InterfaceAlias ${names} -NetworkCategory Private`);
  }
  if (id === 'firewall') {
    // Drop Windows' auto-created block rules for this exe, then add a clean allow rule.
    return runElevated([
      `Get-NetFirewallApplicationFilter -Program ${q(ctx.exe)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule`,
      `Remove-NetFirewallRule -DisplayName 'DropWave' -ErrorAction SilentlyContinue`,
      `New-NetFirewallRule -DisplayName 'DropWave' -Direction Inbound -Action Allow -Program ${q(ctx.exe)} -Profile Private,Domain | Out-Null`,
    ].join('; '));
  }
  return false;
}

module.exports = { runChecks, fix };
