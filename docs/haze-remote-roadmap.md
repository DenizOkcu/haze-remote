# haze-remote: value-first roadmap

Original proposal · **2026-10-07**. The prioritization below is historical: the user subsequently chose fleet navigation over Git review.

## Implementation status

Implemented: retained terminal reliability/ergonomics, a real multi-PTY fleet with instance tabs and per-instance drafts, safe independent lifecycle, background output markers, and an explicitly linked real subagent lifecycle sidebar. **Git review (rank 7) was removed at the user's request.** The fleet is bounded and host-owned; there is no autonomous scheduler or implicit resume of launch arguments.

Implementation lives in `client/App.tsx`, `client/SubagentSidebar.tsx`, `server/fleet.ts`, `server/subagents.ts`, `server/server.ts`, and `shared/fleet.ts`. See [current fleet usage](../README.md#fleet-of-haze-instances) and [subagent evidence/limitations](fleet-and-subagents.md).

Automatic worktree management, session/PTY auto-association, worker terminals/control, multi-host routing, HTTPS/off-network deployment, Linux/device validation, and durable fleet ownership remain future work. The milestones below preserve the original proposal, not the current delivery order or complete Orca parity.

Context: [Orca research](orca-analysis.md) · [product/UX/architecture direction](haze-remote-product-direction.md).

## How to read the priorities

Optimize **frequent user pain removed per unit of work**, subject to safety and correctness gates. These are engineering judgments, not customer-validated demand scores.

Effort estimates assume one engineer familiar with React, node-pty, and this repository; they include focused automated checks but exclude security audits, infrastructure procurement, and waiting for upstream changes:

- **XS:** roughly half to one day.
- **S:** roughly one to three days.
- **M:** roughly three to seven days.
- **L:** more than a week or an unresolved architecture/dependency decision.

Ranges are estimates, not delivery commitments. A changed protocol/storage/security boundary can increase them substantially. Do not add ordinal scores with false precision.

## Ranked backlog

| Rank | Outcome / smallest useful scope | Value | Effort | Why this order / prerequisite |
| --- | --- | --- | --- | --- |
| 1 | **Recoverable prompt drafts and honest paste feedback.** Retain text if local delivery fails; distinguish draft, attempted paste, and explicit Enter. | Very high: protects the user's instruction and trust in every session. | S | Existing composer/send seam; solve before templates or more elaborate steering. Local enqueue is not server acknowledgement. |
| 2 | **Actionable connection recovery.** Last successful contact, retry timing, Retry now, and recovery instructions. | High: core remote-use anxiety and wasted intervention time. | S | Reuse heartbeat/retry signals. Do not claim to distinguish sleeping host from network outage without evidence. |
| 3 | **Touch readability.** Font-size control, expandable composer, scroll-to-bottom, retained non-sensitive preferences. | High: makes the existing control surface useful for longer sessions. | S | Existing xterm/FitAddon; test rotation, narrow layouts, and virtual-keyboard geometry. |
| 4 | **Editable quick instructions.** A handful of plain-language steering templates that fill a draft; verified `/help` shortcut. | High: less typing during short remote check-ins. | XS–S | Depends on rank 1. No auto-Enter, hidden queue, unsupported slash commands, or shell macros. |
| 5 | **Safer Unpair and clearer onboarding.** Explain loss of remote access and host-side recovery; provide readiness checklist. | Medium: prevents accidental lockout and setup confusion. | XS | Browser Unpair currently invokes revocation immediately; local approval/revocation remains unchanged. |
| 6 | **Find/copy recent output.** Search the bounded terminal history; explicit copy/selection fallback. | Medium–high: easier inspection without scrolling thousands of lines. | S–M | May require xterm search addon. HTTP clipboard restrictions matter. Label as recent history, not complete transcript. |
| 7 | **Lightweight read-only Changes panel → feedback draft.** Bounded file list/diff and editable contextual feedback. | High: adds a real review/steer loop rather than terminal polish. | M | New authenticated message variants and Git boundary; baseline/untracked/secret handling must be designed. |
| 8 | **Truthful activity/unread markers.** Last output time and per-view unread activity; no fake completion detection. | Medium alone; high once sessions multiply. | S–M | Terminal output is activity, not agent intent; avoid noisy alerts from terminal redraws. |
| 9 | **Structured attention from Haze.** Working/needs-input/turn-complete state, capability fallback, in-app attention. | Very high: tells users when to intervene. | L/unknown until contract discovery | A stable interactive Haze event/hook contract is not established by this repository. Run a short feasibility spike before committing. |
| 10 | **Host-owned session list and create/resume controls.** Goal, project, checkout, process state, snapshots, explicit lifecycle. | Very high for users running several tasks. | L | Current server owns one PTY. Needs manager, project authorization, limits, isolation, and resume contract. |
| 11 | **Managed worktrees for independent writers.** Creation progress, branch/base context, safe cleanup. | High once parallel task demand exists. | M–L after rank 10 | Do not permit concurrent writers in one checkout by default. Git worktrees do not isolate shared services. |
| 12 | **Multi-host switching, durable catalogs/authority, background service.** | Conditional high value for frequent remote users. | L | Validate need; each changes ownership, discovery, persistence, or security semantics. Do not bundle them into an MVP. |

### Parallel release gates, not optional backlog items

1. **Safe away-from-home deployment:** high value, M–L/unconfirmed effort. Define one HTTPS/WSS private/VPN route with authenticated frontend delivery and reviewed host/origin/peer handling. The current `ws://` client and HTTP-only checks require code changes; a proxy recipe alone is insufficient. Do not suggest internet port forwarding. This gates broader remote marketing, not trusted-LAN ergonomic improvements.
2. **Deployment confidence:** add Linux/native coverage and physical-tablet sleep/wake, keyboard, rotation, Wi-Fi-loss tests before expanding supported environments. Engineering effort is modest for focused CI, but real-device access is required. Existing docs explicitly name these gaps.
3. **Preserve the trust model:** local-only approval, pre-approval metadata isolation, immediate revocation, no automatic second-tab takeover, bounded messages/output, no offline input replay, no new plaintext metadata endpoints. New storage/origin/crypto behavior requires focused review.

If the immediate audience is exclusively outside the home network, move gate 1 ahead of the UX sprint. The cheap trusted-LAN improvements are not a substitute for reachability and authentic page delivery.

## Milestone A — dependable single-session cockpit

**Goal:** a user can return after disconnection and confidently give the next instruction.

Ship one runnable slice first: **rank 1 only**. Validate failed-send/backpressure behavior, reconnect, multiline Paste followed by separate Enter, and Haze paste compatibility. Then add ranks 2–5; do not generate a replacement UI before the first slice passes.

Implementation anchors:

- `App` in [client/App.tsx](../client/App.tsx): input/send path (lines 105–120), snapshot/retry/heartbeat (126–179), Unpair/composer/render (195–241).
- [client/style.css](../client/style.css): touch targets, safe areas, narrow viewport behavior.
- [tests/browser/terminal.spec.ts](../tests/browser/terminal.spec.ts): existing paired terminal workflow and installed-Haze cases.

Acceptance criteria:

- Failed local send leaves the instruction recoverable and visibly reports failure; no automatic retry on reconnect.
- Multi-chunk uncertain/partial delivery is not shown as confirmed Haze receipt; the user is warned before retrying.
- Paste does not append submission Enter. Selecting a quick instruction changes only the draft.
- Draft survives ordinary reconnect in the current page. Reload persistence is optional and **opt-in**, scoped to server/session, clearable, and documented as storing potentially sensitive prompt text.
- Retry now respects single-controller enforcement and cannot take over another active tab.
- After a connection loss, input stays disabled until the authenticated snapshot is restored; process-exited state remains distinct.
- Font/viewport changes keep usable geometry within existing server bounds; composer and terminal controls remain accessible.
- Unpair explains that Haze continues, pairing stays closed, and host-side `pair` is needed after revocation. Cancel sends no revoke.

**Not included:** agent completion notifications, worktree creation, a second session, persistent pairing across restarts, or a native mobile app.

## Milestone B — review → instruction, without an IDE

**Goal:** inspect the result and prepare better feedback from the same browser.

Start with rank 7 if quick user tests confirm review is the next bottleneck; rank 6 is the cheaper alternative if users mainly struggle to find terminal output.

Smallest Changes panel:

1. Report Git availability/non-repository state without breaking the terminal.
2. Display branch/base context and separate staged/unstaged changes. For the existing session, choose and display an explicit baseline rather than silently guessing a task start point.
3. Show a bounded read-only unified diff; indicate truncation, binary files, rename handling, and untracked files without automatically reading their contents. Enforce credential-file exclusions on any preview.
4. Let the user prepare feedback with path/hunk context in an editable composer draft, then explicitly Paste/Enter.

Implementation anchors: authenticated `onMessage` in [server/server.ts](../server/server.ts), [shared/session.ts](../shared/session.ts), a focused Git helper, and a Changes view alongside the existing terminal. Never expose repository files through static HTTP routing.

Acceptance criteria:

- Unapproved/revoked clients cannot fetch paths, branches, or diffs.
- Git execution uses fixed commands/argument arrays, bounded output/time, validated checkout context, and no shell interpolation.
- Non-Git, large/binary/renamed/deleted files, untracked files, credential-path exclusion, and edits during refresh have defined behavior.
- Feedback is editable and never auto-executed; refresh failure leaves terminal control intact.
- At least one browser interaction goes from a real changed file to a feedback draft. Reconnect does not attach stale feedback to a different session.

**Defer:** inline annotation persistence, stage/commit/push/PR controls, editor tabs, and patch application. A plain bounded diff plus precise feedback is enough to test the loop.

## Milestone C — attention and parallel Haze sessions

**Goal:** see which task needs you and safely control independent work.

First do a bounded Haze integration spike. Deliverable: verified upstream event/resume/interrupt capabilities, version support, proposed minimal schema, and terminal-only fallback. Print-mode NDJSON is not evidence of an interactive control API.

Then implement one host with a small session manager before multi-host routing:

- New session: locally authorized project + goal + existing isolated checkout initially.
- Session list: stable ID, title, cwd/branch, process/connection state, last activity/unread; structured attention only when supported.
- One active controller; session switching cannot leak input or resize events into the previous session.
- Same host-owned process survives browser disconnect. New launches enforce concurrency/resource limits.
- Add managed worktree creation only when the session manager is stable; expose setup progress and retry.
- Review baseline belongs to that session. Archive and delete are separate; protect unfinished Git work.

Acceptance criteria:

- Two sessions produce distinct PIDs and snapshots; reconnect/switch restores the intended one without duplicate spawning.
- Two writers targeting one repository use distinct approved checkouts or explicit safe rejection.
- Each input/request names and validates session identity; unauthorized project paths and stale IDs are refused.
- Attention snapshots/events reconcile after reconnect; unread is not task completion; unknown capability falls back visibly.
- Interrupt, process termination, session archive, and worktree deletion are separate operations with accurate consequences.
- Tests cover revoked controller, shutdown cleanup, creation failure, output limits, and deletion protection.

Full semantic attention may remain blocked on upstream support while a truthful multi-session terminal cockpit ships. Do not let that dependency force speculative screen parsing.

## Verification for future implementation

Commands available in [package.json](../package.json):

```sh
npm run typecheck
npm test
npm run build
npm run test:browser -- --reporter=dot
```

Use targeted browser cases while developing, then the relevant full suite. Playwright browser binaries must be installed. Installed-Haze coverage requires the existing optional smoke setup; follow [README verification](../README.md#verification) and [compatibility evidence](haze-compatibility.md), use an isolated HOME, and avoid user configuration/credentials. Package smoke is appropriate for deployment/CLI changes, not necessary for a Markdown-only proposal.

For UI implementation, exercise actual interactions in Chromium/WebKit, not just snapshots. Supplement with physical-device checks for virtual keyboard, selection/copy, background suspension, and wake recovery. HTTPS/origin changes additionally need adversarial host/origin/revocation checks. This planning task did not execute these runtime suites.

## How to test whether this is worth building

Recruit a few existing Haze users before committing to the L-sized work. Observe the current UI first; baseline time and failed interventions locally, with no prompt/code uploads.

Ask users to:

1. Continue an existing session after closing/reopening the browser.
2. Recover a prompt after connection loss while composing/pasting.
3. Find output and prepare a corrective instruction on a small screen.
4. Review a real diff and compose path-specific feedback.
5. Choose between two independent tasks and identify which needs attention.

Proceed from single-session polish to review when users actually inspect changes remotely; proceed to multi-session/worktrees when users repeatedly need more than one task. If safe off-network access is their blocker, prioritize the trust/deployment gate instead. Measure intervention success and clarity, not decorative dashboard engagement.

## Explicitly not now

No multi-provider platform, provider account switching, cloud relay, native phone app, embedded browser, full code editor, issue-tracker board, autonomous task scheduler, team RBAC, usage billing, or automatic merge/commit. None is required to prove **“I can understand and steer my Haze work remotely.”**

**Recommended first implementation:** recoverable drafts plus honest paste feedback, followed by actionable reconnect and touch readability. **Recommended first differentiator:** read-only changes that turn into editable agent feedback. **Longer-term destination:** trusted host-owned Haze sessions with explicit attention and isolated parallel work.
