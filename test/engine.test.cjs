// Headless end-to-end test: two engines in one process talk over localhost.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Engine } = require('../electron/engine.cjs');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function waitFor(engine, id, statuses = ['completed', 'failed', 'rejected', 'cancelled']) {
  return new Promise((resolve) => {
    const on = (t) => { if (t.id === id && statuses.includes(t.status)) { engine.off('transfer', on); resolve(t); } };
    engine.on('transfer', on);
  });
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dropwave-test-'));
  const src = path.join(root, 'src');
  const inboxB = path.join(root, 'inboxB');
  await fsp.mkdir(path.join(src, 'Album', 'Nested'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Album', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(src, 'Album', 'empty.bin'), '');
  fs.writeFileSync(path.join(src, 'Album', 'Nested', 'b.bin'), crypto.randomBytes(3 * 1024 * 1024 + 7));
  fs.writeFileSync(path.join(src, 'big.bin'), crypto.randomBytes(60 * 1024 * 1024));

  let acceptB = true;
  const A = new Engine({ id: 'A', name: 'PC-A', saveDir: path.join(root, 'inboxA'), port: 48001, discoveryPort: 48100 });
  const B = new Engine({ id: 'B', name: 'PC-B', saveDir: inboxB, port: 48002, discoveryPort: 48100, decide: async () => acceptB });
  await A.start();
  await B.start();

  // 1. Add by IP
  const peerB = await A.probe('127.0.0.1', 48002);
  assert.equal(peerB.name, 'PC-B');
  await assert.rejects(A.probe('127.0.0.1', 48001), /this computer/);
  console.log('ok  add by IP');

  // 2. Folder + big file
  let t0 = Date.now();
  let id = await A.sendPaths(peerB, [path.join(src, 'Album'), path.join(src, 'big.bin')]);
  const [sent, recv] = await Promise.all([
    waitFor(A, id),
    new Promise((r) => B.on('transfer', function on(t) { if (t.direction === 'in' && ['completed', 'failed'].includes(t.status)) { B.off('transfer', on); r(t); } })),
  ]);
  assert.equal(sent.status, 'completed', sent.error);
  assert.equal(recv.status, 'completed', recv.error);
  for (const rel of ['Album/a.txt', 'Album/empty.bin', 'Album/Nested/b.bin', 'big.bin']) {
    assert.equal(sha(path.join(inboxB, rel)), sha(path.join(src, rel)), rel);
  }
  const mb = (sent.total / 1048576).toFixed(1);
  console.log(`ok  folder + 60MB file (${mb} MB in ${Date.now() - t0} ms, checksums match)`);

  // 3. Same name again -> renamed, not overwritten
  id = await A.sendPaths(peerB, [path.join(src, 'big.bin')]);
  assert.equal((await waitFor(A, id)).status, 'completed');
  assert.ok(fs.existsSync(path.join(inboxB, 'big (1).bin')));
  console.log('ok  duplicate name saved as "big (1).bin"');

  // 4. Rejected
  acceptB = false;
  id = await A.sendPaths(peerB, [path.join(src, 'Album', 'a.txt')]);
  assert.equal((await waitFor(A, id)).status, 'rejected');
  console.log('ok  reject');

  // 5. Cancel mid-transfer
  acceptB = true;
  id = await A.sendPaths(peerB, [path.join(src, 'big.bin')]);
  await new Promise((r) => A.on('transfer', function on(t) { if (t.id === id && t.done > 5 * 1048576) { A.off('transfer', on); r(); } }));
  const cancelled = waitFor(A, id);
  A.cancel(id);
  assert.equal((await cancelled).status, 'cancelled');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.existsSync(path.join(inboxB, 'big (2).bin')), 'partial file should be removed');
  console.log('ok  cancel (partial file cleaned up)');

  // 6. Unreachable
  id = await A.sendPaths({ id: 'X', name: 'X', ip: '127.0.0.1', port: 48999 }, [path.join(src, 'Album', 'a.txt')]);
  assert.equal((await waitFor(A, id)).status, 'failed');
  console.log('ok  unreachable device reported');

  await A.stop();
  await B.stop();
  await fsp.rm(root, { recursive: true, force: true });
  console.log('\nAll engine tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
