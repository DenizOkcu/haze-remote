# haze-remote

Run and steer a fleet of installed Haze agents from one locally paired browser: instance tabs, independent terminals, and a subagent sidebar. Each Haze instance runs unchanged on your computer in its own real PTY. This separate package contains the TypeScript CLI/server and compiled React/xterm frontend—no Vite server is required in production.

Haze still owns models, tools, project files, configuration, and durable sessions. haze-remote neither copies agent logic nor assumes an interactive remote-agent API.

## Product research and direction

The current direction is a fleet of Haze instances with a subagent sidebar. The Changes/Git review feature has been removed. Original Orca research and proposals are retained as historical context; [fleet usage](#fleet-of-haze-instances) and [subagent integration evidence](docs/fleet-and-subagents.md) describe the implementation.

- [haze-remote product direction: UX, architecture, and boundaries](docs/haze-remote-product-direction.md)
- [Value-first roadmap: quick wins, milestones, and acceptance criteria](docs/haze-remote-roadmap.md)

## Important security boundary

**Open the HTTPS-hosted UI at `https://haze.build/remote/` and pair on the same permitted LAN.** Terminal control uses authenticated, encrypted direct WebRTC, not a cloud relay. Website TLS protects frontend delivery; the protocol still trusts the hosted JavaScript and does **not** protect against a compromised frontend. Do not expose or port-forward the computer to the internet. VPN and IPv6 paths are unsupported.

Pairing grants control of Haze with your OS user's permissions, including code execution. Pairing is not a sandbox. Consider a dedicated unprivileged OS account with access only to intended projects. Encryption does not prevent denial of service or hide traffic timing/size. See [the protocol and threat model](docs/security.md).

## Requirements

- macOS or Linux, Node.js **22.12+**, a modern tablet browser.
- Installed, working `haze` (`npm install -g @denizokcu/haze`), configured using Haze itself.
- A local interactive computer terminal for pairing. Piped stdin/stdout are refused.
- Native build tools when no compatible node-pty prebuild is available: Xcode Command Line Tools on macOS, or Python 3/make/C++ compiler on Linux.

## Build and launch

```sh
npm ci
npm run build
cd /path/to/your/project
node /path/to/haze-remote/dist/server/cli.js --host 192.168.1.20 --subnet 192.168.1.0/24
```

Choose `--host` as the **exact numeric IPv4 address assigned to the computer's OS LAN interface**. `--subnet` must be the canonical network/prefix matching that interface's **exact OS netmask**, not an arbitrary broader private range. Optionally add `--interface en0` to disambiguate interfaces. Missing or ambiguous selection, mismatched subnet, public/loopback/CGNAT addresses, and unsupported IPv6/VPN/tunnel interfaces produce errors rather than guessing or falling back.

The browser must reach that same subnet directly. Only UDP host ICE candidates are allowed. Browser `.local` mDNS candidates are provisional until resolved to IPv4 and checked; the actual selected local address must equal `--host` and the remote address must be a peer in the permitted subnet. No STUN, TURN, relay, or off-network fallback exists. This policy is not proof of physical topology and does not configure a firewall.

### Pairing and reconnect

1. Scan the QR code printed in the **local interactive computer terminal**, or open its private link: `https://haze.build/remote/#room=<room>&secret=<secret>`.
2. The secret is cryptographically random **256-bit**, **single-use**, and expires after **60 seconds**. Opening the link authorizes a browser that proves possession over the permitted LAN; there is no separate code-entry/review step. Treat the QR/link as authority to control your computer, and do not share, screenshot, or pipe it into logs.
3. The fragment secret is not sent in hosted HTTP requests or signaling messages and is not logged by the hosted service. The genuine UI removes the fragment after reading it. Hosted JavaScript necessarily reads it; this is not protection from malicious frontend code, browser extensions, or a compromised device.
4. One browser credential controls the entire fleet. IndexedDB remembers a separate device credential; reconnect authenticates with a fresh OPAQUE handshake, not reuse of the pairing link. A second tab cannot take over: close the first, then Reconnect. Revocation or server restart requires fresh pairing.

The computer and browser use outbound HTTPS REST signaling at `https://api.haze.build` (room-scoped Authorization credentials for signaling operations). Signaling carries SDP/ICE metadata, including addresses and DTLS fingerprints, not terminal content or audio. Internet access is required for the hosted UI and signaling; optional model download also needs internet. **This is not an offline application.**

If connection fails, check the selected IPv4/netmask, that both devices are on the permitted LAN, and internet access to both hosted origins. Guest Wi-Fi/client isolation, blocked mDNS, or a host firewall blocking direct UDP can prevent pairing. Permit only the intended LAN traffic according to your network policy; do not disable firewall/browser security globally or use port forwarding. Unsupported paths and signaling failures report errors rather than switching transport.

### Local computer controls

These belong to haze-remote's local stdin, **not** the bridged Haze PTY:

| Input | Action |
| --- | --- |
| `pair` | Generate a fresh pairing link; refused while a device is authorized |
| `cancel` | Close pairing and reset the pending transport |
| `revoke` | Revoke the device and connections; Haze continues |
| `quit` / local Ctrl+C | Stop haze-remote and all owned Haze instances |

**Unpair** asks for confirmation, then revokes through the authenticated encrypted channel. It does not stop Haze or reopen pairing. To replace a device, type `revoke`, then `pair`, locally.

### Using the terminal

Tap the terminal and type — the cursor is placed there automatically at startup and after reconnects. Your device's normal paste and on-screen keyboard work directly in the terminal; press **Enter** to submit. Input is delivered live over the encrypted channel — nothing is queued or replayed automatically. Ctrl+C follows Haze's interrupt semantics, not the local server shutdown command.

The computer must stay awake and haze-remote must remain running. To keep the host awake, haze-remote holds an OS power assertion (`caffeinate` on macOS, `systemd-inhibit` on Linux) tied to its own lifetime — released automatically on exit, even after a crash or kill. Disable with `--no-keep-awake`. On systems without either helper it degrades silently; on laptops configured to sleep on lid close, that setting still wins. Tablet sleep, closed tabs, or lost connectivity do not stop Haze. Reconnect restores the same PID and recent screen/history. Input is never queued offline. Haze exiting leaves its final screen available until the server stops.

### Terminal controls

- **Readability:** A−/A+ changes terminal text from 12–24px; only this non-sensitive preference is stored locally. **Latest output** scrolls to the bottom, and the layout follows the browser's visible viewport.
- **Honest input:** typed text and pastes are delivered straight to the selected Haze terminal. Local enqueue is not confirmation the agent processed it; failed or uncertain sends are never retried automatically.

### Push-to-talk voice input

Press **Hold to talk** in the selected terminal's toolbar. On first use, haze-remote asks before downloading **Parakeet TDT 0.6B v3 INT8** (approximately **670 MB** of pinned, SHA-256-verified ONNX model assets from Hugging Face). Only model assets are cached under `~/.haze/remote/speech/parakeet-v3-int8`; there is no startup or automatic model download. Download needs internet access; transcription runs locally on the haze-remote host using the bundled CPU-capable sherpa-onnx runtime, without a cloud speech provider or NVIDIA GPU requirement. Language coverage is checkpoint-specific, not universal.

Hold the button with touch/mouse, or hold Space/Enter while it is focused, speak, then release. Recordings are limited to **30 seconds**. The resulting text appears in an editable overlay bound to the original Haze instance. **Send to Haze** pastes the reviewed text and presses Enter through the normal terminal input path. Ensure Haze is at the intended prompt. Releasing, silence, and transcription never submit a request. Record more appends to the draft; Cancel discards it. Disconnects discard recordings but preserve an already transcribed text draft while the page remains open. Failed/uncertain sends are never automatically retried.

**Recordings are memory-only**: no audio files, browser storage, session entries, or recording logs are created. Audio buffers are released after transcription (before Send), and the isolated inference subprocess exits to release its native audio buffers. Only approved text reaches Haze, where normal session persistence applies. This is not a guarantee against OS swap, crash dumps, or recovery of immutable JavaScript strings.

Microphone capture starts only after an explicit push-to-talk action and browser permission on the hosted HTTPS page. Audio travels directly over WebRTC as **PCMU (G.711 μ-law), 8 kHz mono**, protected by DTLS-SRTP. The host decodes and locally resamples it to **16 kHz** for Parakeet. Resampling does not restore lost bandwidth: narrowband audio, noise, accents, language coverage, and packet loss can reduce accuracy. Always review/edit the text before **Send to Haze**. There is no cloud `SpeechRecognition` or cloud transcription fallback.

When blocked, **Microphone setup** directs you to the hosted HTTPS UI and site/OS permissions. Use a browser with microphone and WebRTC audio support; no local certificate installation or browser security exceptions are needed.

An explicitly approved model download belongs to the host: reconnecting or closing the overlay does not cancel it. **Cancel download** or stopping haze-remote cancels it. Recording/transcription cancels on disconnect; an already transcribed draft remains only while the page is open.

### Fleet of Haze instances

- **Tabs are real Haze processes**, not browser tabs or copies of one terminal. **New instance** lets you name an instance and choose a locally approved project. Each has its own PID and terminal screen/history. Left/Right/Home/End navigate instance tabs with a physical keyboard.
- **Stop instance** confirms and terminates only the selected Haze process; other instances continue. Recent output stays visible. **Close tab** removes an exited instance, not project files; at least one tab remains.
- Reconnect and reload restore the same server-owned fleet and last selected instance without spawning duplicates. Running/stopping/exited labels report process lifetime—not whether an agent is thinking or a task finished. Background output is marked on unselected tabs.
- Up to **8 tabs**, including exited instances, and **16 locally approved projects** are supported. Close exited tabs to free slots. Creation request IDs are remembered to prevent duplicate launches; after 256 successful/pending launch IDs in one server lifetime, new launches are refused rather than forgetting old IDs.
- Additional tabs launch fresh Haze sessions, not the initial `--continue`/`--resume` arguments. There is no import/attach to Haze processes started outside this server.
- Instances in one checkout **share files**. Starting another in an occupied checkout requires an explicit **Allow shared checkout** acknowledgement. For parallel writers, create Git worktrees yourself and approve them at local startup:

```sh
haze-remote --host 192.168.1.20 --subnet 192.168.1.0/24 --cwd /path/to/project --project /path/to/other-worktree
# --project may be repeated. The browser cannot supply an arbitrary cwd/executable.
```

Project selection is not a sandbox: Haze retains your OS-user authority. There is no automatic worktree creation or merge/delete operation.

### Providers, Settings, and Sessions

- **Providers** edits `~/.haze/settings.json` over the approved encrypted channel: add or edit OpenAI-compatible endpoints and models (with optional context/output token limits), rotate or clear API keys, choose the default provider/model, and remove providers. Keys are write-only — they are never sent back to the browser, and a blank field means "keep the stored key". OAuth sign-in (ChatGPT Codex) uses the native `/provider` picker via the shortcut button. Changes take effect in fresh Haze instances.
- **Settings** exposes the safe subset of Haze preferences (theme, reasoning effort, steering/compaction profile, model-retry pool, context-window fallbacks, escalation model, tips, subagent worker model/default profile). Every field supports "use default" to unset the override; unrelated configuration and unknown fields are preserved.
- The sidebar has **Sessions** and **Subagents** tabs. Sessions lists saved conversations for the selected workspace (id, time, size — summaries only, never content) from Haze's per-cwd session store and resumes one into a new instance tab via a validated `--resume <id>` launch; forking is prepared on the server and performed through Haze's own session tooling.

### Skills tab

- **Skills** lists all global (`~/.haze/skills`) and locally approved project (`.haze/skills`) workflows, including disabled and same-named skills. Search by name/description or filter by scope. Project skills take precedence in Haze.
- **New skill** creates a real `<name>/SKILL.md` in the chosen scope from an editable template. Select an existing skill to read and edit its complete Markdown; malformed frontmatter is flagged and can be repaired. YAML `name` and `description` are required. Saves persist on the host through the approved encrypted connection, and stale edits are rejected rather than overwriting changes on disk.
- **Open /skills in Haze** switches to the selected running instance and types `/skills`; review the idle prompt and press Enter to open its native picker for AI generation, info, enable/disable, full validation, and removal. The remote file catalog does not read credential-bearing Haze settings, so enabled status remains managed in Haze.
- Unsaved drafts survive switching tabs and reconnecting, but not browser reload. Start a fresh Haze instance to load saved changes into its skill catalog. Reference files are left untouched. Symlinked roots/directories, linked files, and files over Haze’s 256 KiB skill limit are refused and reported; the browser cannot supply arbitrary file paths.

### Subagent sidebar

The sidebar sits to the right of the terminal and belongs to the selected parent instance. When Haze spawns subagents, they appear in the sidebar automatically — no linking step. Runs are grouped Running/Finished, and finished runs stay inspectable for the session's lifetime:

- Select a run to stream its text output and tool activity **live** while it runs, and to read its final deliverable and lifecycle details (mode, objective, queue/execution durations, termination, quarantined vs settled) afterwards.
- Output history is retained server-side per run (bounded; older text is dropped past the limit and marked truncated). Inspecting a finished run replays everything retained — live watching is not required.
- Only the inspected run's output is sent over the encrypted channel; unwatched runs expose lifecycle metadata only.
- Subagents are in-process workers of their parent Haze, not separate terminals. There is no per-worker input, approval, or interrupt API — steer the parent Haze terminal.

This works through a **version-pinned in-process observer**: each Haze instance is launched with a preload that instruments only `@denizokcu/haze` 1.5.0's compiled coordinator/stream modules in memory and reports session identity, worker lifecycle, streamed text-deltas, tool names, and final capsules over a private local socket. Installed Haze files are never modified. With any other Haze version or layout, the sidebar reports unsupported and the terminal keeps working unchanged. `--no-session` still gives worker runs, but session IDs report as ephemeral. Prompts are shown only as each worker's short objective; provider configuration and reasoning are never forwarded. See [observer design and limitations](docs/fleet-and-subagents.md).

Git review is removed. Managed worktrees, multi-host routing, persistent fleet ownership across server restarts, and cloud relay are not implemented.

## Install the built npm package

```sh
npm pack                       # runs typecheck and build
npm install -g ./denizokcu-haze-remote-0.0.1.tgz
cd /path/to/your/project
haze-remote --host 192.168.1.20 --subnet 192.168.1.0/24
```

This implementation has not published the package to npm. If lifecycle scripts are restricted, approve the trusted node-pty/haze-remote scripts. For npm 12 **local** installations, use `npm install-scripts approve @denizokcu/haze-remote node-pty`, then `npm rebuild node-pty @denizokcu/haze-remote`. Checkout approvals are pinned. The reviewed `scripts/prepare-pty.mjs` repairs a missing execute bit on node-pty 1.1.0's macOS prebuilt helper; it never touches Haze or user project files.

```text
haze-remote [options] [-- <Haze arguments>]
--host <IPv4>       Exact OS LAN interface address (required)
--subnet <CIDR>     Exact canonical OS subnet/netmask (required)
--interface <name>  Optional interface disambiguation; VPN unsupported
--no-keep-awake     Disable host power assertion
--cwd <path>     Default launch directory
--haze <path>    Default haze on PATH
--project <path> Approve an additional project/worktree (repeatable)
-h, --help
-v, --version
```

Arguments after `--` are passed directly to Haze without a shell:

```sh
haze-remote --host 192.168.1.20 --subnet 192.168.1.0/24 -- --continue
haze-remote --host 192.168.1.20 --subnet 192.168.1.0/24 --cwd /path/to/project -- --resume SESSION_ID
```

Those are Haze's existing session features; avoid print-mode arguments for interactive use.

## Transport and recovery

OPAQUE authenticates the pairing secret or remembered device credential and establishes fresh keys on every connection. Libsodium XChaCha20-Poly1305 secretstream encrypts/authenticates ordered application messages in independently keyed directions. **SHA-256 DTLS fingerprints**, ordered by client/server role, are bound into secretstream additional authenticated data (AAD): a signaling substitution cannot successfully authenticate encrypted enrollment/control on another DTLS channel. Audio uses DTLS-SRTP, not secretstream. This composition does not protect against compromised hosted JavaScript or endpoints and has not received an independent security audit.

The server keeps one OPAQUE device registration in RAM, not its raw credential. Browser credentials are accessible to same-origin JavaScript. Active sessions expire after 30 minutes and reconnect with a fresh handshake automatically; revocation or shutdown ends authority. No plaintext terminal or cookie-authentication fallback exists. There are no cloud transcription services or Docker requirements. See [security details](docs/security.md) and the [migration cleanup checklist](docs/migration.md).

A headless VT terminal retains the screen plus **2,000 scrollback lines**. Reconnect uses a parsed framebuffer snapshot, including Haze's theme colors, rather than a potentially broken raw ANSI fragment. This is recent terminal recovery, not a separate conversation store or disk-persistent transcript. The upstream serialize addon is experimental. The computer exposes no local web listener or static project-file service. PTY geometry, payloads, unauthenticated socket lifetimes, and output backlog are bounded.

## Verification

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium webkit
npm run test:browser -- --reporter=dot
npm run test:haze -- "$(command -v haze)"
HAZE_SMOKE_EXECUTABLE="$(command -v haze)" npm run test:browser -- --reporter=dot
npm run test:package
```

The repository includes protocol, LAN policy, channel-binding, speech, PTY/fleet, browser, and package checks. Run the relevant suites for the current revision; older release results are not evidence of this transport's production deployment. See [Haze compatibility and coverage boundaries](docs/haze-compatibility.md).

Linux, physical tablet sleep/virtual-keyboard/Wi-Fi behavior, live hosted-service deployment, and provider-backed subagent execution need additional validation. This protocol composition has not received an independent security audit.
