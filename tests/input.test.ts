import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendTerminalInput } from '../client/input.js';

test('terminal input keeps Unicode intact, bounds frames, and reports only local enqueue', () => {
  const data = 'café 🦊\n'.repeat(1500);
  const frames: string[] = [];
  assert.equal(sendTerminalInput(data, true, message => { frames.push(message.data); return true; }), 'queued');
  assert.equal(frames.join(''), data);
  assert.ok(frames.every(frame => Buffer.byteLength(frame) <= 16 * 1024));
  assert.ok(!frames.join('').endsWith('\r'), 'Submission is not appended');
});

test('unavailable, oversize, backpressure and partial sends do not retry', () => {
  let calls = 0;
  const send = () => { calls++; return true; };
  assert.equal(sendTerminalInput('draft', false, send), 'not-sent');
  assert.equal(sendTerminalInput('🦊'.repeat(17000), true, send), 'too-large');
  assert.equal(calls, 0);
  assert.equal(sendTerminalInput('draft', true, () => false), 'not-sent');
  assert.equal(sendTerminalInput('x'.repeat(9000), true, () => ++calls === 1), 'partial');
  assert.equal(calls, 2, 'Stops at first failed chunk');
  assert.equal(sendTerminalInput('draft', true, () => { throw new Error('socket failed'); }), 'partial');
});
