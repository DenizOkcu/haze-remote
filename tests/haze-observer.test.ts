import test from 'node:test';
import assert from 'node:assert/strict';
import { HazeObserver } from '../server/haze-observer/runtime.js';
import { transform } from '../server/haze-observer/transform.js';
import type { ObserverMessage } from '../shared/observer.js';
import { initialize, load } from '../server/haze-observer/loader.js';
import { MessageChannel } from 'node:worker_threads';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const chat = `function currentPromptSession() { if (promptSessionRef.current.identity !== sessionStartRef.current) promptSessionRef.current = {value: {}}; return promptSessionRef.current.value; }`;
const runner = `async function runSubagent(task, options) { return await streamText({model: options.model, onChunk(e) { existing(e); }}); }
function createSubagentTool(options) { const coordinator = options.coordinator; return tool({execute: async input => coordinator.submit(input)}); }`;
class Coordinator {
  next = 1;
  onEvent?: (event: any) => void;
  queued: any[] = [];
  createId() { return `worker-${this.next++}`; }
  submit(input: any) {
    this.onEvent?.({type: 'queued', id: input.id});
    return new Promise(resolve => this.queued.push({input, resolve}));
  }
  async drain(execution = 'settled') {
    const {input, resolve} = this.queued.shift();
    this.onEvent?.({type: 'started', id: input.id, queueMs: 2});
    const result = await input.run({});
    this.onEvent?.({type: 'terminal', id: input.id, execution, durationMs: 4});
    resolve(result);
    return input.id;
  }
}
function makeTool(observer: HazeObserver, coordinator: Coordinator, session: object, run: () => any) {
  return observer.wrapTool({session}, coordinator, {execute(input: any) {
    const id = coordinator.createId();
    return coordinator.submit({id, mode: input.mode, run});
  }});
}
const capsule = (text: string) => ({capsule: {deliverable: text, termination: 'completed'}, telemetry: {provider: 'DO NOT CAPTURE'}});

test('AST anchors are unique and instrumentation preserves original source callbacks', () => {
  const a = transform(chat, 'chat'), b = transform(runner, 'runner');
  assert.equal(a.supported, true); assert.equal(b.supported, true);
  assert.match(a.source, /bindSession\(promptSessionRef.current.value, sessionRef.current\?\.id\)/);
  assert.match(b.source, /wrapTool\(options, coordinator, tool\(/);
  assert.match(b.source, /streamText\(globalThis.*streamOptions\(/);
  assert.ok(b.source.includes('onChunk(e) { existing(e); }'));
  for (const source of [runner.replace('streamText', 'generateText'), runner + runner, 'broken {']) {
    const result = transform(source, 'runner'); assert.equal(result.supported, false); assert.equal(result.source, source);
  }
  assert.equal(transform(chat.replace('promptSessionRef.current.value;', '{};'), 'chat').supported, false);
});

test('queued run captures session ownership and worker IDs do not collide across coordinators', async () => {
  const messages: ObserverMessage[] = [], observer = new HazeObserver(m => messages.push(m));
  const s1 = observer.bindSession({}, 'session-one'), s2 = observer.bindSession({}, 'session-two');
  const c1 = new Coordinator(), c2 = new Coordinator();
  const run = (text: string) => () => {
    observer.streamOptions({}).onChunk({chunk: {type: 'text-delta', text}});
    return capsule(text);
  };
  const a = makeTool(observer, c1, s1, run('one')).execute({mode: 'inspect'});
  const b = makeTool(observer, c1, s2, run('two')).execute({mode: 'validate'});
  const c = makeTool(observer, c2, s2, run('three')).execute({mode: 'research'});
  await c1.drain(); await c1.drain(); await c2.drain(); await Promise.all([a,b,c]);
  const created = messages.filter(m => m.type === 'worker-created');
  assert.equal(new Set(created.map(m => m.key)).size, 3);
  assert.equal(created[0].id, created[2].id); assert.notEqual(created[0].scope, created[2].scope);
  for (const [i, text] of ['one','two','three'].entries()) {
    assert.ok(messages.some(m => m.type === 'worker-text' && m.key === created[i].key && m.text === text));
  }
  assert.deepEqual(created.map(m => m.sessionId), ['session-one','session-two','session-two']);
  assert.ok(!JSON.stringify(messages).includes('DO NOT CAPTURE'));
});

test('only .text text-deltas and tool names forwarded; callbacks, this and results retained', async () => {
  const messages: ObserverMessage[] = [], observer = new HazeObserver(m => messages.push(m));
  const session = observer.bindSession({}, 'safe-session'), c = new Coordinator();
  let calls = 0;
  const result = capsule('answer');
  const promise = makeTool(observer, c, session, () => {
    const receiver = {};
    const opts = observer.streamOptions({onChunk(this: unknown) { assert.equal(this, receiver); calls++; return 42; }, onToolExecutionEnd() { calls++; }});
    for (const chunk of [{type: 'reasoning-delta', text: 'PRIVATE'}, {type: 'text-delta', textDelta: 'PRIVATE'}, {type: 'text-delta', text: 'visible', providerMetadata: 'PRIVATE'}]) assert.equal(opts.onChunk.call(receiver, {chunk}), 42);
    opts.onToolExecutionEnd({toolCall: {toolName: 'read_file', input: 'PRIVATE'}, toolOutput: 'PRIVATE'});
    return result;
  }).execute({mode: 'inspect'});
  await c.drain(); assert.equal(await promise, result); assert.equal(calls, 4);
  assert.equal(messages.filter(m => m.type === 'worker-text').length, 1);
  assert.ok(messages.some(m => m.type === 'worker-tool' && m.name === 'read_file'));
  assert.ok(!JSON.stringify(messages).includes('PRIVATE'));
});

test('quarantine is actual coordinator state and late stream output is suppressed', async () => {
  const messages: ObserverMessage[] = [], observer = new HazeObserver(m => messages.push(m));
  const session = observer.bindSession({}, 'quarantine'), c = new Coordinator();
  let opts: any;
  const pending = makeTool(observer, c, session, () => { opts = observer.streamOptions({}); return capsule('deadline result'); }).execute({mode: 'implement'});
  const id = await c.drain('quarantined'); await pending;
  opts.onChunk({chunk: {type: 'text-delta', text: 'late'}});
  c.onEvent?.({type: 'settled', id, durationMs: 10});
  assert.ok(messages.some(m => m.type === 'worker-result' && m.execution === 'quarantined'));
  assert.ok(messages.some(m => m.type === 'worker-state' && m.state === 'settled' && m.execution === 'settled'));
  assert.ok(!messages.some(m => m.type === 'worker-text'));
});

test('unbound sessions are not captured; ephemeral bindings stable; emitter failure harmless', async () => {
  const messages: ObserverMessage[] = [], observer = new HazeObserver(m => messages.push(m));
  const session = {}; observer.bindSession(session, undefined); observer.bindSession(session, undefined);
  assert.equal(messages.length, 1); assert.equal((messages[0] as any).durable, false);
  const c = new Coordinator(), tool = makeTool(observer, c, {}, () => capsule('uncaptured'));
  const pending = tool.execute({mode: 'inspect'}); await c.drain(); await pending;
  assert.equal(messages.length, 1);
  assert.doesNotThrow(() => new HazeObserver(() => {throw Error('sink');}).bindSession({}, 'test'));
});

test('text budget is bounded per worker in UTF-8 bytes', async () => {
  const messages: ObserverMessage[] = [], observer = new HazeObserver(m => messages.push(m));
  const session = observer.bindSession({}, 'bounded'), c = new Coordinator();
  const pending = makeTool(observer, c, session, () => {
    const opts = observer.streamOptions({});
    opts.onChunk({chunk: {type: 'text-delta', text: 'é'.repeat(100000)}});
    opts.onChunk({chunk: {type: 'text-delta', text: 'more'}});
    return capsule('x'.repeat(100000));
  }).execute({mode: 'inspect'});
  await c.drain(); await pending;
  assert.ok(messages.filter(m => m.type === 'worker-text').reduce((n,m) => n + Buffer.byteLength(m.text), 0) <= 128 * 1024);
  const result = messages.find(m => m.type === 'worker-result'); assert.ok(result && Buffer.byteLength(result.result) <= 64 * 1024);
});

test('loader requires pinned package and BOTH anchors; originals stay on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'haze-observer-synthetic-'));
  const {port1, port2} = new MessageChannel();
  const statuses: any[] = [];
  initialize({port: port2});
  port1.on('message', message => { statuses.push(message); if (message.status === 'ready') port1.postMessage({type: 'enabled'}); });
  try {
    for (const [name, version, runnerText, supported] of [
      ['good', '1.5.0', runner, true], ['version', '1.5.1', runner, false], ['anchor', '1.5.0', runner.replace('streamText', 'generateText'), false],
    ] as const) {
      const pkg = join(root, name);
      await mkdir(join(pkg, 'dist/cli/commands'), {recursive: true}); await mkdir(join(pkg, 'dist/llm'), {recursive: true});
      await writeFile(join(pkg, 'package.json'), JSON.stringify({name: '@denizokcu/haze', version}));
      const chatPath = join(pkg, 'dist/cli/commands/chat.js'), runnerPath = join(pkg, 'dist/llm/subagentRunner.js');
      await writeFile(chatPath, chat); await writeFile(runnerPath, runnerText);
      const original = {format: 'module', source: chat};
      const result = await load(pathToFileURL(chatPath).href, {}, async () => original);
      assert.equal(result !== original, supported);
      assert.equal(await readFile(chatPath, 'utf8'), chat); assert.equal(await readFile(runnerPath, 'utf8'), runnerText);
      if (!supported) assert.equal(result.source, chat);
      if (supported) {
        const transformedRunner = await load(pathToFileURL(runnerPath).href, {}, async () => ({format: 'module', source: runnerText}));
        assert.match(transformedRunner.source, /wrapTool/);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(statuses.map(m => m.status), ['ready','unsupported','unsupported']);
  } finally {port1.close(); port2.close(); await rm(root, {recursive: true, force: true});}
});
