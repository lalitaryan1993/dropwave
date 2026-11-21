// One mouse, two PCs (flow.cjs) over two real engines, with a fake dwkvm helper.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { Engine } = require('../electron/engine.cjs');
const { Flow } = require('../electron/flow.cjs');

const FAKE = [process.execPath, path.join(__dirname, 'fixtures', 'fake-kvm.js')];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function lines(proc) {
  const seen = [];
  let buf = '';
  proc.stdout.on('data', (b) => { buf += b; let i; while ((i = buf.indexOf('\n')) >= 0) { seen.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
  return {
    seen,
    async waitFor(re, ms = 3000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const hit = seen.find((l) => re.test(l)); if (hit) return hit; await wait(20); }
      throw new Error(`timed out waiting for ${re} (saw: ${seen.join(' | ')})`);
    },
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dropwave-flow-'));
  const A = new Engine({ id: 'A', name: 'PC-A', saveDir: path.join(root, 'a'), port: 48301, discoveryPort: 48399 });
  const B = new Engine({ id: 'B', name: 'PC-B', saveDir: path.join(root, 'b'), port: 48302, discoveryPort: 48399 });
  await A.start(); await B.start();
  await A.probe('127.0.0.1', 48302);

  const clipA = { text: 'copied on A', html: '', png: Buffer.from([137, 80, 78, 71, 1, 2, 3]) };
  let clipB = { text: '', html: '', png: null };
  let asked = 0;
  const fa = new Flow({
    engine: A, helper: () => FAKE, config: () => ({ on: true, peer: 'B', side: 'right' }),
    allow: async () => false, clipboard: { read: () => clipA, write: () => {} },
  });
  const fb = new Flow({
    engine: B, helper: () => FAKE, config: () => ({ on: false }),
    allow: async (from) => { asked++; return from.id === 'A'; },
    clipboard: { read: () => clipB, write: (c) => { clipB = c; } },
  });
  fa.sync();
  for (let i = 0; i < 100 && !(fa.ch && fb.ch && fb.edge); i++) await wait(30);
  assert.ok(fa.ch && fb.ch, 'channel up');
  assert.equal(asked, 1, 'the controlled PC is asked first');
  assert.equal(fb.edge, 'left', 'B learns that A is on its left');
  const ka = lines(fa.kvm), kb = lines(fb.kvm);
  await ka.waitFor(/^got edges 0 1$/);
  await kb.waitFor(/^got edges 1 0$/);
  console.log('ok  pairing: asked once, layout mirrored (A right -> B left)');

  // Pointer pushed off A's right edge: A captures, B's pointer enters at its left edge; clipboard comes along.
  fa.kvm.stdin.write('inject edge right 0.4000\n');
  await ka.waitFor(/^got capture$/);
  await kb.waitFor(/^got enter left 0.4$/);
  for (let i = 0; i < 50 && clipB.text !== clipA.text; i++) await wait(20);
  assert.equal(clipB.text, 'copied on A');
  assert.deepEqual([...clipB.png], [...clipA.png]);
  assert.equal(fa.mode, 'controlling'); assert.equal(fb.mode, 'controlled');
  console.log('ok  edge -> the mouse and the clipboard (text + picture) go to the other PC');

  // Input flows A -> B; junk is dropped.
  fa.kvm.stdin.write('inject m 12 -3\ninject k 65 30 0 d\ninject b 1 d\ninject w 120\n');
  await kb.waitFor(/^got m 12 -3$/); await kb.waitFor(/^got k 65 30 0 d$/); await kb.waitFor(/^got b 1 d$/); await kb.waitFor(/^got w 120$/);
  fa.ch.control({ t: 'i', l: 'quit' });
  await wait(200);
  assert.ok(fb.kvm && !kb.seen.includes('got quit'), 'only input lines are passed on');
  console.log('ok  mouse, keys, buttons and wheel reach the other PC; anything else is refused');

  // Pointer goes back over B's left edge: A gets it back at the same height; B's clipboard comes back.
  clipB = { text: 'copied on B', html: '', png: null };
  fb.kvm.stdin.write('inject leave 0.6000\n');
  await ka.waitFor(/^got release right 0.6$/);
  assert.equal(fa.mode, 'idle'); assert.equal(fb.mode, 'idle');
  console.log('ok  back over the edge -> the mouse returns at the same height');

  // Ctrl+Alt+Home on A while its mouse is on B.
  fa.kvm.stdin.write('inject edge right 0.5\n');
  await kb.waitFor(/^got enter left 0.5$/);
  fa.kvm.stdin.write('inject takeback\n');
  await ka.waitFor(/^got release right 0.5$/);
  await kb.waitFor(/^got leave$/);
  console.log('ok  Ctrl+Alt+Home takes the mouse back and releases keys on the other PC');

  fa.stop(); fb.stop();
  await A.stop(); await B.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('\nAll flow tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
