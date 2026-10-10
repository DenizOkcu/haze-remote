# haze-remote

Run and steer a fleet of installed [Haze](https://github.com/DenizOkcu/haze) agents from one locally approved browser: instance tabs, independent terminals, and a subagent sidebar. Each Haze instance runs unchanged on your computer in its own real PTY. This separate package contains the TypeScript CLI/server and compiled React/xterm frontend—no Vite server is required in production.

Haze still owns models, tools, project files, configuration, and durable sessions. haze-remote neither copies agent logic nor assumes an interactive remote-agent API.

## Product research and direction

The current direction is a fleet of Haze instances with a subagent sidebar. The Changes/Git review feature has been removed. Original Orca research and proposals are retained as historical context; [fleet usage](#fleet-of-haze-instances) and [subagent integration evidence](docs/fleet-and-subagents.md) describe the implementation.

- [haze-remote product direction: UX, architecture, and boundaries](docs/haze-remote-product-direction.md)
- [Value-first roadmap: quick wins, milestones, and acceptance criteria](docs/haze-remote-roadmap.md)

## Important security boundary

**Terminal transport is encrypted and requires approval on the computer. The HTTP-delivered application is not protected against an active network attacker who replaces its HTML/JavaScript.** Use only trusted private networks. Corporate LAN/VPN membership alone does not establish that trust; follow your IT department's remote-access policy. Do not expose or port-forward this service to the internet.

Approval grants control of Haze with your OS user's permissions, including code execution. Pairing is not a sandbox. Consider a dedicated unprivileged OS account with access only to intended projects. Encryption does not prevent denial of service or hide traffic timing/size. See [the protocol and threat model](docs/security.md).

## Requirements

- macOS or Linux, Node.js **22.12+**, a modern tablet browser.
- Installed, working `haze` (`npm install -g @denizokcu/haze`), configured using Haze itself.
- A local interactive computer terminal for approval. Piped stdin/stdout are refused.
- Native build tools when no compatible node-pty prebuild is available: Xcode Command Line Tools on macOS, or Python 3/make/C++ compiler on Linux.

## Build and launch

```sh
# In this separate checkout
npm ci
npm run build

# In the project Haze should work on
cd /path/to/your/project
node /path/to/haze-remote/dist/server/cli.js --lan
```

`--lan` selects the sole available private IPv4 interface. If there are multiple interfaces, choose one explicitly:

```sh
haze-remote --host 192.168.1.20
```

The default without `--lan`/`--host` is loopback (`127.0.0.1`). Bindings to `0.0.0.0`, `::`, public addresses, and arbitrary hostnames are refused. This is an address restriction, not an automatic host/router firewall configuration.

### Two-way pairing

1. Open the printed HTTP address on the tablet.
2. Enter **PIN A** displayed in the computer terminal. It is eight digits and rotates/expires every **60 seconds**. The PAKE handshake proves possession without transmitting the PIN directly.
3. The browser displays **code B**, bound to that handshake. Enter it using the keyboard in the computer's **haze-remote local control terminal**, within **two minutes**. This deadline starts after PIN A verification, independently of PIN A rotation.
4. Successful code B entry consumes that code and starts a fresh **two-minute review window**. The computer displays the observed network peer IP and reported browser/platform. Check the tablet's IP in its Wi-Fi settings. Browser/platform are self-reported and spoofable; VPN/proxy addresses may differ. No physical location is inferred.
5. Type **`approve`** locally before the review window expires, or **`reject`**. Re-entering code B cannot extend the deadline. Confirming code B alone does not authorize access. No project metadata, terminal output, or input is available before final approval.
6. Pairing closes. Only **one browser credential** may be approved for this server's entire fleet. The browser remembers its credential in IndexedDB and re-authenticates on reconnect; PIN rotation does not interrupt approved connections.

Five handshake starts exhaust the pairing allowance, including abandoned/wrong-PIN requests. Rotation does not reset it. Type `pair` locally to reopen the window/reset the allowance when no device is approved. Someone can deliberately exhaust this budget; this is a known denial-of-service tradeoff, not a lockout bypass.

A second tab with the same credential cannot automatically take over. Close the first tab, then use **Reconnect**. A different device requires local revocation and fresh pairing.

### Local computer controls

These are handled by haze-remote's own stdin, **not** the bridged Haze PTY. No HTTP/WebSocket endpoint can invoke them.

| Input | Action |
| --- | --- |
| Eight-digit code B | Consume the confirmation code and start a separate two-minute device review |
| `approve` | Approve the reviewed request if still valid |
| `reject` | Reject the pending request |
| `pair` | Reopen pairing/reset attempt allowance; refused while a device is approved |
| `revoke` | Immediately revoke the credential and all its connections; Haze continues; pairing remains closed |
| `quit` / local Ctrl+C | Stop haze-remote and all its Haze instances |

**Unpair** asks for confirmation, then revokes the authenticated browser's credential through the encrypted channel. It does not terminate Haze or reopen pairing. To replace a device, type `revoke`, then `pair`, on the computer.

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

When microphone access is blocked, the voice overlay always shows **Microphone setup**, including alongside model download progress. On HTTP pages, it recommends trusted HTTPS or localhost on the computer running haze-remote. Permission denials on secure pages show site/OS microphone-permission guidance.

An explicitly approved model download belongs to the host: closing/restarting the browser, reconnecting, or closing the voice overlay does not cancel it. Reopen voice input to see current progress; it does not start a second download. **Cancel download** or stopping haze-remote cancels the download. Recordings/transcription still cancel on disconnect.

Recording checks the microphone API the browser actually exposes, rather than rejecting every HTTP page by `isSecureContext`. Where a browser explicitly permits HTTP microphone capture but hides AudioWorklet, a memory-only Web Audio ScriptProcessor fallback is used. Press and **hold** the PTT button until recording starts; a quick click does not start hands-free recording.

Browser microphones normally require a **secure context**. Plain HTTP LAN/private-IP access supports terminal control, but is not a secure context for microphone access. Use loopback on the host, or enable HTTPS with a certificate trusted by the remote device and valid for the printed address:

```sh
haze-remote --host 192.168.1.20 --tls-cert /path/to/certificate.pem --tls-key /path/to/private-key.pem
```

For the trusted `haze.build` device flow, register once and let `--https` guide you:

```sh
haze-remote --lan --https
# Or choose a specific address:
haze-remote --host 192.168.1.20 --https
```

With a registration present, `--https` refreshes the device DNS address on startup and reuses the assigned hostname and locally issued certificate without questions. On first use — after explicit consent, including disclosure that your private address is published in public DNS — it enrolls through the public `https://haze.build` API (open registration — no invitation) and issues a production Let's Encrypt certificate itself via built-in ACME DNS-01: **no Certbot and no contact email are needed**. Certificate and ACME keys stay on this computer; renewal happens automatically inside the final 30 days of validity on the next start. Declining leaves no registration; failures keep the registration for retry and never fall back to an IP URL or HTTP. See [trusted device HTTPS setup](docs/device-https.md).

For quick local HTTPS without a registration or certificate files, use the explicit self-signed mode:

```sh
haze-remote --lan --self-signed-https
```

`--self-signed-https` generates a self-signed server certificate using **OpenSSL** on first use, then reuses it across restarts. Certificates and private keys are stored per bind address under `~/.haze/remote/tls` with restricted directory/key permissions. Changing the port keeps the same certificate; changing the address creates a separate one. Certificates last one year. Expired or damaged certificates cause an actionable error rather than silently replacing the saved identity. Do not combine these HTTPS modes or `--tls-cert`/`--tls-key`.


The terminal prints the HTTPS address and SHA-256 certificate fingerprint. Your browser will warn that the self-signed certificate is not trusted. On your trusted private network, verify the server/address and compare its certificate fingerprint before accepting an exception, if the browser supports one. Exceptions may not persist even though the certificate does. **Accepting a warning does not reliably enable microphone access**; use a trusted certificate with `--tls-cert`/`--tls-key` if recording remains blocked. haze-remote does not install trust roots or change browser security settings. HTTPS does not relax private-address bindings, matching Host/Origin checks, or local pairing approval.

### Fleet of Haze instances

- **Tabs are real Haze processes**, not browser tabs or copies of one terminal. **New instance** lets you name an instance and choose a locally approved project. Each has its own PID and terminal screen/history. Left/Right/Home/End navigate instance tabs with a physical keyboard.
- **Stop instance** confirms and terminates only the selected Haze process; other instances continue. Recent output stays visible. **Close tab** removes an exited instance, not project files; at least one tab remains.
- Reconnect and reload restore the same server-owned fleet and last selected instance without spawning duplicates. Running/stopping/exited labels report process lifetime—not whether an agent is thinking or a task finished. Background output is marked on unselected tabs.
- Up to **8 tabs**, including exited instances, and **16 locally approved projects** are supported. Close exited tabs to free slots. Creation request IDs are remembered to prevent duplicate launches; after 256 successful/pending launch IDs in one server lifetime, new launches are refused rather than forgetting old IDs.
- Additional tabs launch fresh Haze sessions, not the initial `--continue`/`--resume` arguments. There is no import/attach to Haze processes started outside this server.
- Instances in one checkout **share files**. Starting another in an occupied checkout requires an explicit **Allow shared checkout** acknowledgement. For parallel writers, create Git worktrees yourself and approve them at local startup:

```sh
haze-remote --lan --cwd /path/to/project --project /path/to/other-worktree
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
haze-remote --lan
```

This implementation has not published the package to npm. If lifecycle scripts are restricted, approve the trusted node-pty/haze-remote scripts. For npm 12 **local** installations, use `npm install-scripts approve @denizokcu/haze-remote node-pty`, then `npm rebuild node-pty @denizokcu/haze-remote`. Checkout approvals are pinned. The reviewed `scripts/prepare-pty.mjs` repairs a missing execute bit on node-pty 1.1.0's macOS prebuilt helper; it never touches Haze or user project files.

```text
haze-remote [options] [-- <Haze arguments>]
--lan            Select the sole private IPv4 interface
--host <IP>      Specific private/VPN/loopback address; default 127.0.0.1
--port <number>  Default 8787; 0 selects a free port
--cwd <path>     Default launch directory
--haze <path>    Default haze on PATH
--project <path> Approve an additional project/worktree (repeatable)
-h, --help
-v, --version
```

Arguments after `--` are passed directly to Haze without a shell:

```sh
haze-remote --lan -- --continue
haze-remote --host 192.168.1.20 --cwd /path/to/project -- --resume SESSION_ID
```

Those are Haze's existing session features; avoid print-mode arguments for interactive use.

## Transport and recovery

OPAQUE authenticates the pairing PIN or a 256-bit remembered device secret and establishes fresh keys on every connection. Libsodium XChaCha20-Poly1305 secretstream encrypts/authenticates ordered messages in independently keyed directions. It covers terminal input, resize, snapshots, output, enrollment, revocation requests, application heartbeats, and fleet lifecycle/subagent metadata messages. There is no plaintext terminal or cookie-authentication fallback.

Browser cryptography uses bundled WASM/JavaScript implementations, not `crypto.subtle`, which is unavailable on ordinary LAN HTTP. Browser `crypto.getRandomValues` supplies secure randomness. Application assets are bundled locally; there are no accounts, cloud telemetry, cloud transcription services, databases, or Docker requirements. Optional voice input downloads model assets after consent and requires a secure browser context; remote-device microphone access needs a trusted HTTPS certificate.

The server keeps only one OPAQUE device registration record in RAM, not its raw secret. Restarting invalidates the pairing. Browser credentials are scoped to the origin/server instance and accessible to code running under that origin—an HTTP-delivery attacker remains a threat. Active sessions expire after 30 minutes and reconnect with a new handshake automatically. Credential authority lasts until revocation or server shutdown.

A headless VT terminal retains the screen plus **2,000 scrollback lines**. Reconnect uses a parsed framebuffer snapshot, including Haze's theme colors, rather than a potentially broken raw ANSI fragment. This is recent terminal recovery, not a separate conversation store or disk-persistent transcript. The upstream serialize addon is experimental. Only compiled frontend assets are served; project files and output are not served/logged as static files. PTY geometry, payloads, unauthenticated socket lifetimes, and output backlog are bounded.

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

Tests cover PIN/code expiry, cross-rotation budgets, wrong secrets, local-only review/approval, pre-approval isolation, observed-IP handling, tampering/replay/reflection, rejection of plaintext/bearer cookies, one-device/one-tab enforcement, revocation, PTY input/resize/Unicode/theme snapshots, same-PID reconnect, and shutdown. Package smoke installs the tarball outside the checkout and exercises actual local keyboard code B/review/approval/revocation in a PTY.

Tablet-sized Chromium/WebKit tests use a real private LAN HTTP address when available (asserting it is **not** a secure context), plus actual installed Haze `/help`, reload/reconnect, and `/exit`. Installed-Haze tests use an empty temporary HOME/workspace and make no model calls or user-credential reads.

Verified on macOS arm64/Node 26.7.0/Haze 1.5.0. Linux and physical tablet sleep/virtual-keyboard/Wi-Fi behavior remain untested. This application's protocol composition has not received an independent security audit. See [Haze compatibility evidence](docs/haze-compatibility.md).


### Direct installation hostname with a trusted certificate

For a locally obtained ACME certificate, keep the bind address private and configure its
exact DNS hostname separately:

```sh
haze-remote --host 192.168.1.20 --hostname <installation>.devices.haze.build \
  --tls-cert /local/path/fullchain.pem --tls-key /local/path/privkey.pem
```

The certificate must be currently valid for that exact hostname (no wildcard). The printed
URL uses the hostname, while the listener and peer checks remain private/LAN/VPN-only.
Unrecognized Host headers and cross-origin WebSockets remain rejected. Pairing and local
approval are still required. DNS must resolve to the selected reachable private address;
this does not create a tunnel or route traffic through haze.build.

haze-remote uses only the public API at **https://haze.build** for provisioning:
use `haze-remote dns --help` for enrollment (open registration), explicit address updates,
DNS-01 challenge hooks and unregistration. The API origin is fixed and redirects
are refused. Follow [trusted device HTTPS setup](docs/device-https.md)
for staging/production certificate issuance and renewal. Customer certificate/ACME keys
stay on this computer; the hosted service receives only registration, address and challenge requests.
Renewed TLS files take effect after a deliberate restart, not automatic hot reload. Public
DNS and certificate transparency disclose the address/opaque hostname. Microphone permission
and local model-download consent are unchanged.
