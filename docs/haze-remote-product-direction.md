# Make haze-remote the Orca of Haze

Historical product proposal · **2026-10-07**. The user subsequently prioritized a fleet of Haze instances with tabs and a subagent sidebar, and asked to remove Git review. That fleet is now implemented; see [roadmap implementation status](haze-remote-roadmap.md#implementation-status), [current fleet usage](../README.md#fleet-of-haze-instances), and [subagent evidence](fleet-and-subagents.md). The inventory and review-first sequencing below describe the earlier baseline/proposal, not the current UI. Secure off-network deployment remains future work.

Execution order: [prioritized roadmap](haze-remote-roadmap.md).

## Product promise

> **Keep Haze working on your computer. Understand, review, and steer it from wherever you are safely connected.**

The target is not “Orca but smaller.” It is **the best remote control plane for Haze**: Haze owns reasoning, models, tools, permissions, configuration, and durable conversations; haze-remote owns access, live control, attention, navigation, and eventually lightweight review.

“Wherever” is the future promise, **not today's deployment guarantee**. Today the app is restricted to trusted private networks, requires a running awake host, and serves its frontend over HTTP. Do not market it as internet-ready until authenticated frontend delivery and a supported remote route are implemented and reviewed.

### Primary jobs to be done

1. **Continue away from the desk:** “My Haze session is already running; let me check it and give the next instruction.”
2. **Unblock quickly:** “Tell me what needs my attention and get me to the right session.”
3. **Review before redirecting:** “Show the changes; let me send precise feedback without opening a full IDE.”
4. **Run independent work:** “Start a second task without agents overwriting each other's files.”

Serve job 1 immediately. Jobs 2–4 require actual new capabilities, not just a dashboard redesign.

## What exists today

The inspected repository is a **single locally approved browser controlling a single server-owned Haze PTY**. It has no agent fleet or structured task API.

| Capability | Current evidence | Consequence |
| --- | --- | --- |
| Real Haze execution | `startRemote` in [server/server.ts](../server/server.ts), lines 150–153, spawns installed Haze in a PTY with cwd/environment. | Keep Haze unchanged; avoid rebuilding an agent backend. |
| Local approval and encrypted transport | [README](../README.md), pairing/security sections; [server/access.ts](../server/access.ts). | One browser credential/controller; remote approval is deliberately unavailable. |
| Touch and keyboard control | `App` in [client/App.tsx](../client/App.tsx), lines 199–241: terminal, keys, multiline Paste, separate Enter. | A runnable steering surface already exists; improve it incrementally. |
| Reconnect | `App`, lines 95–188: retries, heartbeat, visibility/online recovery, snapshot-gated input. | A closed browser does not kill Haze; preserve this behavior. |
| Screen recovery | `startRemote`, lines 52–73 and 160–175: headless terminal, snapshot, exit state. | Recent screen plus 2,000 lines, not durable session history. |
| Haze resume | [README](../README.md), Haze argument forwarding; [compatibility evidence](haze-compatibility.md), lines 9–19. | `--continue`/`--resume` belong to Haze; currently supplied at launch, not selected in a remote session browser. |
| Honest connection/process state | `App`, lines 130–141 and 229–234. | Connected/Exited are known. Working/Waiting/Completed task states are not known. |
| Private-network boundary | [security model](security.md); `startRemote`, lines 84–92 and 132–142. | HTTP assets remain vulnerable to active replacement; encrypted terminal traffic is not secure page delivery. |

**Absent in the current UI/server:** session/workspace inventory, managed worktrees, task queue, structured Haze events, per-tool approval cards, changed-file/diff review, completion notifications, cloud relay, multi-host aggregation, and daemon persistence across server restart.

The existing tests and compatibility document record historical verification, not checks rerun during this research. Physical-tablet and Linux coverage remain documented gaps.

## UX direction: a cockpit, not a miniature IDE

### First release: improve the existing single session

```text
haze / remote                 Connected • last contact 2s ago
Project: payments             PID 1234 • trusted-network connection

[Terminal]                    [Readability] [Find recent output]
┌───────────────────────────────────────────────────────────────┐
│ Existing Haze terminal, still authoritative                    │
└───────────────────────────────────────────────────────────────┘
[Keyboard] [Esc] [Tab] [arrows] [Enter] [Ctrl+C / interrupt]

[Prompt draft — retained when local send fails                 ]
[Instructions ▾]                           [Paste to terminal]
Pasting is not submitting. Use Enter when ready.
```

This is a proposed layout, not an existing screenshot. Do not add a decorative “Working” badge without a source. Keep Unpair available but explain its consequence before revoking.

### Later: attention-first navigation

Once multiple host-owned sessions exist, the landing view becomes a small session list:

```text
Host: home workstation                     Reachable / last seen
Needs you                                  [only from Haze events]
  Fix checkout redirect    payments/branch  Awaiting input
Recent work
  Add timeout tests        api/branch       New output • unread
  Update docs              docs/branch      Process exited (0)
[New session]
```

Selecting a card opens **Terminal / Changes / Details**. Desktop can show the list beside the detail; tablet/phone should use one focused panel at a time. Sort actionable attention first, not every stream of output. Connection failure must remain distinct from agent failure.

### Steering interaction principles

- Preserve **Draft → Paste → Enter**. A template fills an editable draft; it does not run a command.
- An interrupt sends the supported terminal control sequence. It is not guaranteed pause, kill, rollback, or subagent termination.
- Use labels matching evidence: **output activity**, **process exited**, **unread**, **connection lost**. Do not call silence “done.”
- Offer structured approvals or queued turns only if Haze supplies an explicit versioned contract.
- Review feedback returns to the composer for editing and explicit submission.
- Never replay inputs automatically after reconnect; uncertain delivery needs user review.

## Architecture: extend the seam that already exists

### 1. UI-only reliability and ergonomics

Start in [client/App.tsx](../client/App.tsx) and [client/style.css](../client/style.css). Keep the existing terminal, crypto, pairing, resize, and snapshot lifecycle. Extract a small component only when the new interaction warrants it; do not introduce a dashboard framework.

The current composer clears immediately after `terminal.paste`, while terminal input uses a boolean-returning send path. Fix delivery visibility before adding saved prompts. That boolean proves local enqueue success, not PTY receipt or Haze processing; multiple chunks can create partial delivery. Retain recoverable draft content and do not automatically retry uncertain input.

### 2. Small authenticated message extensions

[shared/session.ts](../shared/session.ts) and `startRemote`'s authenticated `onMessage` handler are the integration seam. Introduce typed, runtime-validated message variants as extensions require them; TypeScript types alone do not validate a peer.

All session/task metadata, diffs, and requests stay on the authenticated encrypted channel. `/api/info` stays limited to its existing pairing/discovery purpose. Do not serve working-directory files through the static asset server.

### 3. Haze event adapter, only after contract discovery

Investigate whether a stable interactive event/hook interface exists in Haze. The checked-in compatibility evidence only establishes CLI/PTY behavior and print-mode JSON/NDJSON, **not an interactive remote API**.

Minimum useful events would identify session, monotonic revision, activity/attention kind, and timestamps without copying secrets/configuration. Snapshot and live events must agree after reconnect. Unknown/missing adapter capability should yield terminal-only control, not guessed state.

If upstream lacks such a contract, decide explicitly whether a narrow opt-in Haze integration is worth maintaining. Do not disguise screen scraping as authoritative state.

### 4. Host-owned sessions and isolated writers

Refactor the current single PTY owner only when session creation is ready to ship. A minimal session record owns an ID, user goal/title, authorized project/cwd, process, terminal snapshot, lifecycle state, and optional Git context.

- Keep one approved browser/controller initially; multiple agents do not require multiple devices.
- Constrain launch paths to locally authorized projects; avoid a generic remotely callable shell/process launcher.
- Run Git/Haze as fixed executables with argument arrays, not interpolated shell strings.
- One writer per checkout; use worktrees for parallel writers. Worktrees are not sandboxes.
- Make create, terminate, archive, and delete distinct. Worktree deletion must protect uncommitted/unmerged work.
- Browser disconnect preserves host work. Server shutdown/restart behavior must be documented, not silently equated with browser reconnect.

Durable device registrations, session catalogs, background services, and multi-host navigation are later product decisions. They change today's RAM-only authority/lifetime model and need explicit security review.

### 5. Minimal review rather than an editor

Begin with a read-only changed-file list and bounded unified diff tied to the session checkout. Define baseline, staged/unstaged handling, untracked files, binary files, renamed files, and output truncation before release. Untracked/ignored contents should not be automatically exposed; explicit opt-in previews must enforce file-type/path/size controls and deny credential files.

Use rendered text, not arbitrary HTML. Avoid network fetches just to compute a diff. Feedback includes path/hunk context plus the user's instruction; optional inline comments can follow. Commit/push/PR controls are not needed for the first useful review loop.

## Remote access is a parallel trust track

For away-from-home use, authentic frontend delivery is a gate, not optional polish. The current browser uses `ws://` and server checks assume `http://`; a reverse proxy alone is not a drop-in supported solution.

Define and test one HTTPS/WSS private-network/VPN deployment, trusted origin/host behavior, proxy peer-address handling if applicable, and certificate onboarding. Retain local approval, private binding policy, revocation, and no public port-forwarding guidance. Obtain focused review of these changes before broad remote positioning. Native phone apps and relays come much later, if direct access proves insufficient.

## Success measures

No baseline usage data was collected; these are proposed measurements, not performance claims. Prefer local instrumentation and user tests, not a mandatory telemetry service.

- **Remote continuation:** paired browser returns to the same PID/screen without manual recovery or duplicate agents.
- **Reliable steering:** failed/uncertain paste never destroys the only recoverable draft or causes automatic duplicate submission.
- **Time to intervention:** elapsed time from reconnect/attention indication to the correct user instruction; compare with today's terminal flow.
- **Review utility:** user can find a changed hunk and prepare precise feedback without switching to a desktop editor.
- **Parallel safety:** independently launched writers get distinct checkouts and visible task identity.
- **Trust clarity:** users can explain which computer runs Haze, what approval grants, and what survives disconnection versus shutdown.

## Product boundaries

Do not copy Orca's breadth before validating these jobs. Defer multi-provider adapters, a model/account manager, full editor/browser, issue-tracker boards, autonomous schedulers, team sharing, mandatory cloud accounts, push infrastructure, and automatic commits/merges.

The winning progression is **trusted remote terminal → dependable single-session cockpit → review-and-attention loop → isolated multi-session control**. This is the path to being the Orca of Haze without becoming another agent implementation.
