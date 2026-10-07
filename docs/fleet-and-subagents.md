# Fleet and subagent integration

Implemented direction · 2026-10-07. Git review was removed in favor of Haze instance tabs and a right-side subagent sidebar with automatic run discovery, live output streaming, and retained finished runs. [Usage](../README.md#fleet-of-haze-instances) · [security boundaries](security.md#fleet-ownership-and-subagent-metadata).

## Ownership and control

- `server/fleet.ts` owns a bounded catalogue of real Haze PTYs. Each instance has a stable ID, PID, project, lifecycle, independent framebuffer, and a per-run worker registry with retained output.
- One locally approved browser credential/controller owns access to the fleet. Initial authentication restores the last selected instance plus the fleet inventory; no instance/project metadata is available before approval.
- A selected terminal snapshot carries an instance ID and fresh view token. Input and resize must match both. Background instances keep running and retain their server-side screens. Switching does not replay prompts or start processes.
- Creation uses the locally selected executable, fresh arguments, and an approved project ID. Only the initial instance receives CLI arguments after `--`, such as `--resume`. Pending/successful creation IDs are retained to prevent retry duplicates; at 256 IDs new launches are refused rather than silently forgetting old commands. Failed launches release their entry.
- Stop affects one PTY. Close removes an exited tab, not files. Shutdown stops all owned instances. Browser disconnect/revocation leaves them running. RAM-only fleet ownership and device registration end on server restart.
- Separate PTYs do not isolate project files. Shared-checkout launches require acknowledgement; independently prepared worktrees can be approved with repeated local `--project` flags. Haze still has OS-user authority; this is not a sandbox.

## Subagent observation design

Haze 1.5.0 has no public API exposing both durable session identity and live worker text. Instead of guessing from terminal output or newest session files, haze-remote instruments the launched process in memory:

- `server/haze-observer/preload.ts` is injected via `NODE_OPTIONS --import` together with two environment variables naming a private Unix-domain socket and token. Without these variables the preload is a transparent no-op (no loader, no config discovery). Installed Haze files are never modified.
- `loader.ts` + `transform.ts` (Acorn AST) verify the package is exactly `@denizokcu/haze` 1.5.0 and that both compiled anchors are unique: `currentPromptSession`'s return in `dist/cli/commands/chat.js`, and `createSubagentTool`'s tool construction plus `runSubagent`'s `streamText(...)` call in `dist/llm/subagentRunner.js`. On any mismatch, an `observer-status: unsupported` message is emitted, no code is transformed, and the terminal is unaffected. Sibling `*.js` files matching the suffix regex (e.g. `cli/commands/exit.js`) are never instrumented.
- `runtime.ts` binds session identity by wrapping the prompt-session object returned to a WeakMap keyed to `sessionRef.current?.id` (ephemeral when absent), wraps the subagent tool to capture ownership before async queueing, intercepts coordinator `createId`/`submit`/`onEvent` for lifecycle and quarantine truth, and composes SDK callbacks for `onChunk` text-deltas and `onToolExecutionStart/End` tool names while preserving Haze's originals. The status exchange between loader and main thread is fire-and-forget so module loading can never deadlock, and the MessagePort is unref'd so it cannot keep the process alive after exit.
- Events cross a token-authenticated loopback NDJSON channel (`host.ts`), are fully revalidated (`shared/observer.ts::isObserverMessage`), and bounded: 128 KiB frames, 1 MiB child-side queue, per-worker output budget of 128 KiB, 64 KiB result cap, 100 retained runs per instance (oldest finished dropped first).
- `fleet.ts` tracks each run server-side: created → queued/started → terminal/settled, with streamed output appended live. Finished runs keep their retained output and final deliverable for later inspection. `worker-watch`/`worker-unwatch` gate which single run's output streams to the controller; lifecycle metadata for all runs is always available.

## What is forwarded and what is not

Forwarded per run: worker ID, coordinator scope, session ID, mode, short objective (bounded text), lifecycle state, execution settled/quarantined, termination reason, queue/execution durations, streamed text-delta text, tool names and phases, and the final capsule deliverable.

Never forwarded: provider configuration or credentials, model reasoning traces, tool inputs/outputs, full prompts, or any file contents. This is an allowlist, not a redaction filter.

## Known limitations

- The observer is pinned to Haze **1.5.0**; other versions report unsupported. It instruments private compiled structure by exact AST anchors — a Haze patch release can break it, at worst reverting to terminal-only.
- `--no-session` still produces worker runs but session IDs are ephemeral per process.
- Worker runs are lost when their Haze instance exits (retention is in-process, not disk).
- Only the watched run's output is streamed; watching a second run stops streaming the first (lifecycle for all runs continues).
- Tool markers are names only; a tool's arguments/results are not captured.
- `terminal` with `execution: quarantined` may still be executing; the UI keeps such runs under Running until settled.

## Verification and coverage boundaries

`tests/haze-observer.test.ts` (7 tests) covers AST anchor uniqueness, ownership capture before async queueing, worker-ID uniqueness across coordinators/sessions, allowlist-only forwarding with original callbacks retained, quarantine truth and late-output suppression, unbound-session stability and emitter-failure tolerance, per-worker byte budgets, and loader pin/version gating with on-disk originals untouched.

`tests/fleet.test.ts` covers real PTYs with observer events: automatic worker appearance with objective/state, output privacy until inspected, live streamed text plus revisions, final result and settled transition, retained finished-run inspection, per-instance isolation, lifecycle/cap/shutdown bounds, and encrypted-channel-only transport.

Browser tests (Chromium/WebKit, tablet sizing) exercise the right-side sidebar end-to-end with a synthetic observer fixture (live streaming, finished-run inspection, parent switching, narrow-screen drawer) and the full installed-Haze suite — including two concurrent native instances with the real 1.5.0 preload transforming actual installed modules, `/help`, `/exit`, and independent instance exit.

Not covered: provider-backed subagent execution with a configured model (no model calls were made), Linux/physical-device behavior, multi-host routing, HTTPS deployment, and persistent fleet ownership across server restarts.
