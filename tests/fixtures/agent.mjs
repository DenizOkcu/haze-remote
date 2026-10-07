// An interactive stand-in, not agent logic: tests real TTY, cwd, resize and lifetime.
import { appendFileSync } from 'node:fs';
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(7);
process.stdin.setRawMode(true);
const interval = setInterval(() => {
  appendFileSync('heartbeat.txt', '.');
}, 50);
console.log(`READY pid=${process.pid} cwd=${process.cwd()} tty=true`);
process.stdout.on('resize', () => console.log(`SIZE ${process.stdout.columns}x${process.stdout.rows}`));
process.stdin.on('data', data => {
  const text = data.toString();
  if (text.includes('\x03')) {
    console.log('EXIT requested');
    clearInterval(interval);
    process.exit(0);
  }
  if (text.includes('screen')) process.stdout.write('\x1b]10;rgb:a5/dc/c9\x07\x1b]11;rgb:11/15/1b\x07\x1b[2J\x1b[HSCREEN café 🦊\r\n');
  else console.log(`INPUT ${JSON.stringify(text)}`);
});
