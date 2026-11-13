export const api = window.landrop;

export function fmtSize(b = 0) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
}

export const fmtSpeed = (bps) => (bps > 0 ? `${fmtSize(bps)}/s` : '');

export function fmtEta(s) {
  if (s == null || !isFinite(s)) return '';
  if (s < 1) return 'almost done';
  if (s < 60) return `${Math.ceil(s)}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s left`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function hueFor(id = '') {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function initials(name = '?') {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export const label = (t) => (t.count === 1 ? t.files[0].name.split(/[\\/]/).pop() : `${t.count} files`);

export const peerOf = (t) => (t.direction === 'in' ? t.from : t.to);
