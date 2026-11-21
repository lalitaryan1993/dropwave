// Stands in for dwkvm.exe in tests: "inject <line>" makes it say <line> (as if the hooks saw it);
// "fake-files <json>" sets what "getfiles" answers (files copied in Explorer); addfile/putfiles are
// echoed as "got putfiles [...]" and answered "putfiles ok <n>"; every other command is echoed back
// as "got <command>" so the test can see what DropWave asked.
process.stdout.write('ready\n');
let buf = '', copied = '[]', added = [];
process.stdin.on('data', (b) => {
  buf += b;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line === 'quit') process.exit(0);
    if (line.startsWith('inject ')) process.stdout.write(line.slice(7) + '\n');
    else if (line.startsWith('fake-files ')) copied = line.slice(11);
    else if (line === 'getfiles') process.stdout.write(`files ${copied}\n`);
    else if (line.startsWith('addfile ')) added.push(line.slice(8));
    else if (line === 'putfiles') { process.stdout.write(`got putfiles ${JSON.stringify(added)}\nputfiles ok ${added.length}\n`); added = []; }
    else process.stdout.write(`got ${line}\n`);
  }
});
