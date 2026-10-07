import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MessagePort } from 'node:worker_threads';
import { transform } from './transform.js';

let port: MessagePort;
export function initialize(data: { port: MessagePort }) { port = data.port; port.unref(); }
type Capture = { sources: Map<string, string>; supported: boolean };
const packages = new Map<string, Promise<Capture>>();
async function inspect(root: string): Promise<Capture> {
  const sources = new Map<string, string>();
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== '@denizokcu/haze' || pkg.version !== '1.5.0') throw new Error('version');
    const chat = join(root, 'dist/cli/commands/chat.js');
    // Public v1.5.0 names this module subagentRunner.js. runner.js is also accepted
    // only with exactly the same AST anchors, for equivalent compiled layouts.
    let runner = join(root, 'dist/llm/subagentRunner.js');
    let runnerSource: string;
    try { runnerSource = await readFile(runner, 'utf8'); }
    catch { runner = join(root, 'dist/llm/runner.js'); runnerSource = await readFile(runner, 'utf8'); }
    const a = transform(await readFile(chat, 'utf8'), 'chat'), b = transform(runnerSource, 'runner');
    if (!a.supported || !b.supported) throw new Error('anchors');
    sources.set(pathToFileURL(chat).href, a.source); sources.set(pathToFileURL(runner).href, b.source);
    // Fire-and-forget status: never gate module loading on a round-trip, which
    // can deadlock when nothing else keeps the main-thread loop alive.
    port.postMessage({type: 'observer-status', status: 'ready'});
    return { sources, supported: true };
  } catch {
    port.postMessage({type: 'observer-status', status: 'unsupported', message: 'Requires @denizokcu/haze 1.5.0 and both compiled instrumentation anchors'});
    return {sources, supported: false};
  }
}
export async function load(url: string, context: any, nextLoad: (url: string, context: any) => Promise<any>) {
  const original = await nextLoad(url, context);
  if (!url.startsWith('file:') || !/\/(?:chat|subagentRunner|runner)\.js$/.test(url)) return original;
  // `chat.js`-suffixed exit hooks (cli/commands/exit.js) are never instrumented.
  if (url.includes('/dist/cli/commands/') && !url.endsWith('/chat.js')) return original;
  try {
    let directory = dirname(fileURLToPath(url));
    while (true) {
      let pkg: any;
      try { pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { /* No package at this level. */ }
      if (pkg) {
        if (pkg.name !== '@denizokcu/haze') return original;
        let capture = packages.get(directory);
        if (!capture) { capture = inspect(directory); packages.set(directory, capture); }
        const source = (await capture).sources.get(url);
        return source ? {...original, source} : original;
      }
      const parent = dirname(directory);
      if (parent === directory) return original;
      directory = parent;
    }
  } catch { return original; }
}
