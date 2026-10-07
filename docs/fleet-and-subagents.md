# Fleet and subagent integration

Implemented direction · 2026-10-07. Git review was removed in favor of Haze instance tabs and a parent-scoped subagent sidebar. [Usage](../README.md#fleet-of-haze-instances) · [security boundaries](security.md#fleet-ownership-and-subagent-metadata).

## Ownership and control

- `server/fleet.ts` owns a bounded catalogue of real Haze PTYs. Each instance has a stable ID, PID, project, lifecycle, independent framebuffer, and optional subagent reader.
- One locally approved browser credential/controller owns access to the fleet. Initial authentication restores the last selected instance plus the fleet inventory; no instance/project metadata is available before approval.
- A selected terminal snapshot carries an instance ID and fresh view token. Input and resize must match both. Background instances keep running and retain their server-side screens. Switching does not replay prompts or start processes.
- Creation uses the locally selected executable, fresh arguments, and an approved project ID. Only the initial instance receives CLI arguments after `--`, such as `--resume`. Pending/successful creation IDs are retained to prevent retry duplicates; at 256 IDs new launches are refused rather than silently forgetting old commands. Failed launches release their entry.
- Stop affects one PTY. Close removes an exited tab, not files. Shutdown stops all owned instances. Browser disconnect/revocation leaves them running. RAM-only fleet ownership and device registration end on server restart.
- Separate PTYs do not isolate project files. Shared-checkout launches require acknowledgement; independently prepared worktrees can be approved with repeated local `--project` flags. Haze still has OS-user authority; this is not a sandbox.

## What Haze actually exposes

Public source was inspected at **Haze v1.5.0**, commit `cd0daa845cacfe4aee5adb0cd8f521c9885acf79`. These are source findings, not a claim that provider-backed workers were run during development.

- [Agent events](https://github.com/DenizOkcu/haze/blob/v1.5.0/src/core/agent/events.ts) defines `subagent_state` with worker ID, queued/started/terminal/settled state, mode, timing, termination, and optional execution settled/quarantined.
- [Interactive chat](https://github.com/DenizOkcu/haze/blob/v1.5.0/src/cli/commands/chat.tsx) records events through [sessionRecorder](https://github.com/DenizOkcu/haze/blob/v1.5.0/src/cli/chat/sessionRecorder.ts).
- [sessionStore](https://github.com/DenizOkcu/haze/blob/v1.5.0/src/core/session/sessionStore.ts) writes `HOME/.haze/sessions/<sha256(path.resolve(cwd))[0:16]>/<session-id>.jsonl`. The initial header is `{type:"header", id, cwd, createdAt, ...}`. Events use `{type:"event", at, name, text}`, with event JSON encoded inside `text`.
- [Subagent runner](https://github.com/DenizOkcu/haze/blob/v1.5.0/src/llm/subagentRunner.ts) runs workers inside the parent's JavaScript process. OS descendants cannot identify these workers; they do not have separate PTYs.
- [Goal supervisor](https://github.com/DenizOkcu/haze/blob/v1.5.0/src/cli/commands/streaming/goalSupervisor.ts) shares a coordinator across physical turns. A new goal execution can restart `worker-1`, even when resuming the same goal ID. The reader therefore namespaces worker IDs by the occurrence of the persisted `goal_start` event, not `turn_start` or goal ID alone. This scope number is reader-derived, not a Haze-issued execution ID.
- [Interactive commands](https://github.com/DenizOkcu/haze/blob/v1.5.0/src/cli/commands/commands.ts) expose `/session` to display the current ID/file. `/new` and `/resume` can change that association. Persistence can be disabled and new-session files are deferred until there is resumable content.
- [Print-mode runCommand](https://github.com/DenizOkcu/haze/blob/v1.5.0/src/cli/commands/runCommand.ts) is a separate execution path. Its 1.5.0 NDJSON projection does not expose `subagent_state`; it is not a way to obtain worker telemetry while preserving the interactive PTY.

## Explicit linking, not automatic ownership inference

A session header has no PID or PTY identity. The sidebar therefore asks the user to supply the selected Haze's `/session` ID. It never guesses the latest file, watches workspace-wide tasks as if they were workers, or scrapes ANSI output into statuses. Linking the same session to two instances in one cwd is refused, but a user association still cannot independently prove that the running PTY owns that session.

Relink after `/new` or `/resume`. `--no-session` has no feed. An unpersisted new session appears as waiting/loading, not a fabricated empty live fleet. A structured upstream side-channel carrying run/session/goal identities would enable reliable automatic linking in a future version.

## Reader contract and limits

`server/subagents.ts::SubagentReader(cwd, sessionId, home).poll()` reads only that explicit project-hashed file. It validates IDs, header cwd/ID, and symlink boundaries. Reads are incremental and bounded to 256 KiB per poll; records above 64 KiB are skipped after a valid header. At most 100 worker rows are retained. Replacement, disappearance, and detected truncation reset parser state; incomplete lines/UTF-8 wait for the rest of the record.

Only worker ID, reader scope, known mode/state/execution/termination enums, timestamp, queue duration, and execution duration are constructed into responses. Raw requests, messages, tool output, deliverables, provider settings, and transcripts are never forwarded by the adapter. The underlying session file contains conversation data; this is not a credential scanner. A truncate-and-regrow rewrite that occurs entirely between polls can evade reset detection.

`terminal` means a result was reported, not necessarily that execution stopped. `execution:"quarantined"` remains active until a later settled event. Parent exit stops polling and makes displayed worker metadata historical. Worker buttons display metadata only; steer workers through the parent Haze terminal rather than offering unsupported worker approval, interrupt, or terminal controls.

## Verification and coverage boundaries

Automated fixtures use synthetic temporary HOME/session files with the tagged source schema. They cover lifecycle/quarantine, repeated worker IDs across goal executions, allowlist filtering, header/path/symlink rejection, partial lines/UTF-8, replacement/truncation, and bounds. Fleet tests cover real PTYs, selected-instance/view-token routing, idempotent creation, approved-project restrictions, shared-checkout acknowledgement, per-instance stop/close, reconnect, and all-instance shutdown. Chromium/WebKit interactions exercise actual tabs and the sidebar using those synthetic event fixtures.

Installed-Haze browser checks use an isolated HOME and no model calls. They establish native PTY compatibility, not provider-backed subagent execution. Linux, physical-device sleep/keyboard/Wi-Fi behavior, and an end-to-end provider-backed lifecycle feed remain coverage gaps. HTTPS/off-network deployment and persistent fleet recovery across server restart remain unimplemented.
