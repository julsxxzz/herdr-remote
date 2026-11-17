// Fake `hc` for tests. Behaviour is driven by files in $FAKE_HC_DIR.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_HC_DIR;
const argv = process.argv.slice(2);
const file = (name) => path.join(dir, name);
const has = (name) => fs.existsSync(file(name));
const read = (name) => fs.readFileSync(file(name));

fs.appendFileSync(file('calls.jsonl'), JSON.stringify(argv) + '\n');

const keepAlive = () => setInterval(() => {}, 1000);
const cmd = argv[0];

if (cmd === 'ls') {
  process.stdout.write(read('ls.json'));
} else if (cmd === 'get') {
  process.stdout.write(read('get.json'));
} else if (cmd === 'send' || cmd === 'keys') {
  if (has('stderr')) process.stderr.write(read('stderr'));
  process.exit(has('exit') ? Number(read('exit').toString().trim()) : 0);
} else if (cmd === 'events') {
  fs.writeFileSync(file('events.pid'), String(process.pid)); // lets tests check this child exited
  if (has('events.jsonl')) process.stdout.write(read('events.jsonl'));
  if (has('events-exit')) {
    process.stdout.write('', () => process.exit(3));
  } else {
    keepAlive();
  }
} else if (cmd === 'attach') {
  if (has('attach-exit')) process.exit(0);
  process.stdout.write(read('screen.bin'));
  keepAlive();
} else {
  process.stderr.write(`fake hc: unknown command ${cmd}\n`);
  process.exit(2);
}
