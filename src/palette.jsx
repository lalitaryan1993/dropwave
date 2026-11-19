// Command palette (Ctrl+K): type to find any action (send to a device, find the phone, settings…).
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Search, CornerDownLeft } from 'lucide-react';

// Every word typed must appear in the title, the hint or the keywords, in any order.
function match(cmd, q) {
  if (!q) return 1;
  const hay = `${cmd.title} ${cmd.hint || ''} ${cmd.group || ''} ${cmd.keywords || ''}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.every((w) => hay.includes(w))) return 0;
  return cmd.title.toLowerCase().startsWith(words[0]) ? 2 : 1;
}

export function CommandPalette({ commands, onClose }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef(null);
  const results = useMemo(
    () => commands.map((c) => [c, match(c, q)]).filter(([, s]) => s).sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 60),
    [commands, q],
  );
  useEffect(() => setSel(0), [q]);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const run = (c) => { if (!c) return; onClose(); setTimeout(() => c.run(), 0); };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(results[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <motion.div className="fixed inset-0 z-[55] flex justify-center bg-black/35 px-6 pt-[12vh] backdrop-blur-[3px]"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 520, damping: 38 }}
        className="flex h-fit max-h-[70vh] w-full max-w-[620px] flex-col overflow-hidden rounded-3xl border border-line-strong bg-panel-solid shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-5">
          <Search className="h-[18px] w-[18px] shrink-0 text-faint" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder="Type a command or a device…"
            style={{ outline: 'none' }} className="h-14 min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-faint" />
          {q && <button onClick={() => setQ('')} className="rounded-lg border border-line px-2 py-0.5 text-[11.5px] text-muted hover:text-fg">Clear</button>}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-2">
          {results.length === 0 && <div className="py-10 text-center text-[13px] text-faint">Nothing matches “{q}”.</div>}
          {results.map((c, i) => (
            <button key={c.id} data-i={i} onMouseMove={() => setSel(i)} onClick={() => run(c)}
              className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left ${i === sel ? 'bg-accent/12' : ''}`}>
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${i === sel ? 'grad-bg text-white' : 'bg-[var(--line)] text-muted'}`}>
                {c.Icon && <c.Icon className="h-[17px] w-[17px]" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{c.title}</span>
                {c.hint && <span className="block truncate text-[12px] text-faint">{c.hint}</span>}
              </span>
              {c.group && <span className="shrink-0 rounded-md border border-line px-1.5 py-px text-[11px] text-faint">{c.group}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-2.5 text-[11.5px] text-faint">
          <span className="flex items-center gap-1.5">↑↓ to move · <CornerDownLeft className="h-3 w-3" /> to run · Esc to close</span>
          <span>Ctrl+K</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
