import { parse } from 'acorn';

const observer = 'globalThis[Symbol.for("haze.remote.observer")]';
type Node = any;
function walk(node: Node, visit: (node: Node) => void) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
function ownWalk(node: Node, visit: (node: Node) => void) {
  if (!node) return;
  if (/Function|ArrowFunction/.test(node.type)) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => { if (child?.type) ownWalk(child, visit); });
    else if ((value as Node)?.type) ownWalk(value, visit);
  }
}
export type TransformResult = { supported: boolean; source: string; message?: string };
/** Fail closed for capture: all expected anchors must be unique, no regexp source surgery. */
export function transform(source: string, kind: 'chat' | 'runner'): TransformResult {
  try {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const edits: {start: number; end: number; text: string}[] = [];
    let sessions = 0, tools = 0, streams = 0;
    walk(ast, node => {
      if (node.type !== 'FunctionDeclaration') return;
      if (kind === 'chat' && node.id?.name === 'currentPromptSession') {
        ownWalk(node.body, child => {
          if (child.type === 'ReturnStatement' && source.slice(child.argument?.start, child.argument?.end) === 'promptSessionRef.current.value') {
            sessions++;
            edits.push({start: child.argument.start, end: child.argument.end, text: `${observer}.bindSession(promptSessionRef.current.value, sessionRef.current?.id)`});
          }
        });
      }
      if (kind === 'runner' && node.id?.name === 'createSubagentTool' && node.params[0]?.name === 'options') {
        ownWalk(node.body, child => {
          if (child.type === 'ReturnStatement' && child.argument?.type === 'CallExpression' && child.argument.callee?.name === 'tool' && child.argument.arguments.length === 1) {
            tools++;
            edits.push({start: child.argument.start, end: child.argument.end, text: `${observer}.wrapTool(options, coordinator, ${source.slice(child.argument.start, child.argument.end)})`});
          }
        });
      }
      if (kind === 'runner' && node.id?.name === 'runSubagent') {
        ownWalk(node.body, child => {
          if (child.type === 'CallExpression' && child.callee?.name === 'streamText' && child.arguments.length === 1 && child.arguments[0].type === 'ObjectExpression') {
            streams++;
            const arg = child.arguments[0];
            edits.push({start: arg.start, end: arg.end, text: `${observer}.streamOptions(${source.slice(arg.start, arg.end)})`});
          }
        });
      }
    });
    if ((kind === 'chat' && sessions !== 1) || (kind === 'runner' && (tools !== 1 || streams !== 1))) return {supported: false, source, message: 'Haze 1.5.0 instrumentation anchors missing or ambiguous'};
    let result = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    return {supported: true, source: result};
  } catch { return {supported: false, source, message: 'Haze compiled module could not be parsed'}; }
}
