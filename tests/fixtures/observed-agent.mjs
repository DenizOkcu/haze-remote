// Synthetic stand-in for Haze's coordinator/subagent shapes: real TTY plus
// observer events over the private preload IPC channel. Not agent logic.
import { connect } from 'node:net';
import { appendFileSync } from 'node:fs';

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(7);
process.stdin.setRawMode(true);
const heartbeat = setInterval(() => { appendFileSync('heartbeat.txt', '.'); }, 50);
console.log(`READY pid=${process.pid} cwd=${process.cwd()} tty=true`);
process.stdout.on('resize', () => console.log(`SIZE ${process.stdout.columns}x${process.stdout.rows}`));
process.stdin.on('data', data => {
  const text = data.toString();
  if (text.includes('\x03')) { console.log('EXIT requested'); clearInterval(heartbeat); process.exit(0); }
  if (text.includes('screen')) process.stdout.write('\x1b]10;rgb:a5/dc/c9\x07\x1b]11;rgb:11/15/1b\x07\x1b[2J\x1b[HSCREEN café 🦊\r\n');
  else console.log(`INPUT ${JSON.stringify(text)}`);
});

const socketPath = process.env.HAZE_REMOTE_OBSERVER_SOCKET;
const token = process.env.HAZE_REMOTE_OBSERVER_TOKEN;
if (socketPath && token) {
  // Emit observer frames directly: exercising the real preload loader here would
  // require the compiled Haze package; runtime behavior is covered elsewhere.
  const socket = connect(socketPath);
  const frames = [];
  let connected = false;
  const send = message => {
    const frame = JSON.stringify({ token, message }) + '\n';
    if (connected) socket.write(frame); else frames.push(frame);
  };
  socket.on('connect', () => { connected = true; for (const frame of frames) socket.write(frame); frames.length = 0; });
  socket.on('error', () => {});
  const workerKey = 'test:1:1';
  const at = new Date().toISOString();
  send({ type: 'observer-status', status: 'ready' });
  send({ type: 'session', sessionId: 'synthetic-session', durable: true });
  send({ type: 'worker-created', key: workerKey, id: 'worker-1', sessionId: 'synthetic-session', scope: 1, mode: 'implement', objective: 'Audit the payment module', at });
  send({ type: 'worker-state', key: workerKey, state: 'started', queueMs: 1.5, at });
  let index = 0;
  const timer = setInterval(() => {
    index++;
    const tickAt = new Date().toISOString();
    send({ type: 'worker-text', key: workerKey, text: `streamed chunk ${index}\n`, at: tickAt });
    send({ type: 'worker-tool', key: workerKey, name: 'read-file', phase: index % 2 ? 'start' : 'end', at: tickAt });
    if (index === 3) send({ type: 'worker-result', key: workerKey, result: 'Audit complete: 2 findings, both fixed.', termination: 'completed', execution: 'settled', at: new Date().toISOString() });
    if (index === 4) { send({ type: 'worker-state', key: workerKey, state: 'settled', execution: 'settled', durationMs: 1200, at: new Date().toISOString() }); clearInterval(timer); }
  }, 150);
  timer.unref();
}
