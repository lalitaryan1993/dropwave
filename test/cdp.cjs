// Dev helper: evaluate JS inside a running LANDrop window via the Chrome DevTools Protocol.
// Usage: node test/cdp.cjs <debugPort> "<js expression>"
const [port, expr] = process.argv.slice(2);

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== 1) return;
    const r = msg.result;
    console.log(JSON.stringify(r.exceptionDetails ? { error: r.exceptionDetails.exception?.description } : r.result.value, null, 1));
    ws.close();
  });
})().catch((e) => { console.error(e.message); process.exit(1); });
