import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalingClient } from '../shared/signaling.js';
import { BrowserLanSocket } from '../client/browser-lan-socket.js';

test('signaling client maintains server role expiry on sends and polls', async t => {
  const responses = [
    { token: 'x'.repeat(43), expiresAt: 1000 },
    { ok: true, expiresAt: 2000 },
    { messages: [], expiresAt: 3000 },
  ];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    return new Response(JSON.stringify(responses.shift()));
  });
  const client = await SignalingClient.create('a'.repeat(32));
  assert.equal(client.expiresAt, 1000);
  await client.send({ type: 'offer', sdp: 'v=0' });
  assert.equal(client.expiresAt, 2000);
  assert.deepEqual(await client.receive(), []);
  assert.equal(client.expiresAt, 3000);
});

test('browser keeps polling past stale local lease metadata and trusts server denial', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
  class Peer { close() {} }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: Peer, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'RTCPeerConnection', original);
    else Reflect.deleteProperty(globalThis, 'RTCPeerConnection');
  });
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/join')) return new Response(JSON.stringify({ token: 'x'.repeat(43), expiresAt: 1 }));
    if (init.method === 'GET') {
      polls++;
      if (polls === 3) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      return new Response(JSON.stringify({ messages: [], expiresAt: polls + 1 }));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  const socket = new BrowserLanSocket('a'.repeat(32));
  t.after(() => socket.close());
  const error = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser failed to poll')), 5000);
    socket.onerror = error => { clearTimeout(timeout); resolve(error); };
  });
  assert.equal(polls, 3);
  assert.match(String(error), /Pairing expired or cancelled/);
  assert.equal(socket.readyState, 3);
});
