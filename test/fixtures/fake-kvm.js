// Stands in for dwkvm.exe in tests: "inject <line>" makes it say <line> (as if the hooks saw it);
// every other command is echoed back as "got <command>" so the test can see what DropWave asked.
process.stdout.write('ready\n');
let buf = '';
process.stdin.on('data', (b) => {
  buf += b;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line === 'quit') process.exit(0);
    process.stdout.write(line.startsWith('inject ') ? line.slice(7) + '\n' : `got ${line}\n`);
  }
});
