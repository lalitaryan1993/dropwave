// Dev helper for a running DropWave window (started with --remote-debugging-port):
//   node test/cdp.cjs <debugPort> "<js expression>"        evaluate JS in the window
//   node test/cdp.cjs <debugPort> --shot <file.png>        save a screenshot of the window
const fs = require('node:fs');
const [port, a, b] = process.argv.slice(2);

async function call(method, params) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ id: 1, method, params }));
  const msg = await new Promise((r) => ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }));
  ws.close();
  if (msg.error) throw new Error(msg.error.message);
  return msg.result;
}

(async () => {
  if (a === '--shot') {
    const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(b, Buffer.from(r.data, 'base64'));
    console.log('saved', b);
    return;
  }
  const r = await call('Runtime.evaluate', { expression: a, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.exceptionDetails ? { error: r.exceptionDetails.exception?.description } : r.result.value, null, 1));
})().catch((e) => { console.error(e.message); process.exit(1); });
