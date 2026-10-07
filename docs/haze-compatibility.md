# Haze compatibility evidence

Inspected on 2026-10-07. Local source was available in the adjacent `haze` checkout; installed `haze --version` and local `package.json` both reported **1.5.0**. No Haze files were modified. User settings/credentials were not inspected.

## Verified invocation and ownership

| Question | Source evidence (Haze 1.5.0) | MVP behavior |
| --- | --- | --- |
| Executable | `package.json`: `bin.haze = bin/haze.js`; `bin/haze.js` verifies and imports the compiled CLI | Resolve installed `haze` on PATH; support an explicit `--haze` path |
| Interactive invocation | `src/cli/index.ts:24–46` documents bare `haze` as interactive; installed `haze --help` confirms invocation/options | Spawn bare `haze` unless arguments are explicitly passed after `--` |
| TTY matters | `src/cli/index.ts:66–84` reads stdin as a print-mode prompt only when `stdin.isTTY` is false | `node-pty` supplies real TTY stdin/stdout, not ordinary process pipes |
| Working directory | `src/cli/commands/chat.tsx:138,574,712` uses `process.cwd()` for prompt context and workspace label; `src/cli/chat/startupSequence.ts:14` runs git in cwd | Spawn directly in launch directory or `--cwd`; do not change Haze workspace semantics |
| Configuration | `src/config/paths.ts:4` resolves Haze's root using `os.homedir()`; `src/config/settings.ts:139,227–239` owns reading/writing its settings; `src/cli/chat/startupSequence.ts:49` loads settings | Inherit environment/HOME unchanged; do not read, expose, copy, or manage Haze configuration |
| Sessions | `src/core/session/sessionStore.ts:74–83,107–119` scopes session storage to cwd | Let Haze save/resume its own sessions. Remote output recovery is transient terminal state, not a parallel conversation store |
| Rendering | `src/cli/commands/chat.tsx:827–834` uses Ink 8 incremental rendering, 15 FPS, automatic Kitty keyboard detection, and `exitOnCtrlC: false` | Present xterm-256color, truecolor, resize events, and browser terminal control-sequence responses |
| Theme | `src/ui/terminalColors.ts:39–58` emits OSC 10/11 default colors, and OSC 110/111 to restore them | Forward escape sequences and retain Haze's default theme colors for reconnect snapshots |
| Input | `src/ui/components/TextInput.tsx:230–235` handles paste separately; `:282–303` submits on Enter | Raw xterm keyboard input; composer uses xterm paste handling, with a separate Enter action |

Haze's current CLI **also** documents print-mode JSON/NDJSON output. That is not an interactive remote API and is not used here. This application implements no Haze-specific machine-readable control protocol or model/tool logic; its JSON WebSocket messages are only a terminal transport (input, resize, output, snapshot, status).

## Executed checks

- Native node-pty TTY smoke succeeded on macOS arm64/Node 26.7.0.
- Installed Haze launched in the PTY with an empty temporary HOME/workspace and `--no-session`.
- Haze rendered interactively, accepted `/help` and a distinct Enter key, remained alive after WebSocket disconnect, restored its help screen to a reconnected browser with the same PID, and cleanly exited via `/exit`.
- Real browser interactions exercised the compiled React/xterm frontend with installed Haze in tablet-sized **Chromium and WebKit**: pairing, pasted `/help`, Enter, page reload, same PID/screen, `/exit`, and exit status.
- Deterministic PTY integration checks independently covered cwd, TTY detection, resize, Unicode, screen clearing/theme restoration, disconnect lifetime, encrypted authentication, local-only review/approval, revocation, second-tab rejection, malformed input rejection, and shutdown.
- Production package smoke packed and installed the npm tarball in a temporary directory, exercised the installed bin outside the checkout, fetched compiled HTML/JavaScript without Vite, entered code B using the installed CLI's real local keyboard path, reviewed/approved the device, confirmed canonical project cwd, revoked access locally, and verified shutdown stopped the PTY. npm 12's local-tarball lifecycle-script approval/rebuild procedure was exercised explicitly.
- Final validation passed: TypeScript checks, production build/package smoke, seven protocol/PTY tests, installed-Haze smoke, and all four tablet-browser tests (including installed Haze in Chromium and WebKit). Vite reported a non-failing 500 kB chunk-size warning; the React/xterm/cryptography bundle is approximately 469 kB gzipped.

Pairing now gives PIN A 60 seconds, code B entry two minutes, and a separate two-minute device review. Clock-controlled tests verify exact expiry, one-time code consumption, the updated pending socket deadline, and no terminal access before approval; Chromium/WebKit interactions verify both stage countdowns.

The first smoke sent `/help` and Enter in one atomic PTY write; Haze treated it as pasted text instead of submission. The corrected test and UI use separate paste and Enter interactions. No Haze modification was needed.

## Dependency documentation and versions

Official documentation consulted:

- [node-pty](https://github.com/microsoft/node-pty): `spawn`, `onData`, `write`, `resize`, Unix/native requirements and permission boundary.
- [ws](https://github.com/websockets/ws/blob/master/README.md): authenticated HTTP upgrades, message transport, bounded payloads, ping/pong heartbeats.
- [Vite](https://vite.dev/guide/): compatible Node versions and compiled production output.
- [xterm addons](https://xtermjs.org/docs/guides/using-addons/): terminal/addon initialization and fit sizing.
- [xterm serialize](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize): framebuffer serialization after terminal write callbacks; experimental upstream status.

Registry versions were checked at implementation time, then pinned with a committed npm lockfile: node-pty 1.1.0, ws 8.22.0, React 19.3.0, Vite 8.3.3, xterm/headless 6.0.0, fit 0.11.0, serialize 0.14.0. TypeScript is pinned to 6.0.3. Certificate-free encrypted pairing/transport uses pinned @serenity-kit/opaque 1.1.0 and libsodium-wrappers 0.8.4; see [the security model](security.md).

node-pty's installed macOS prebuilt `spawn-helper` arrived with mode 0644, causing `posix_spawnp failed` despite the native module loading. The isolated package install helper makes that dependency-owned file executable. The native TTY smoke passed after this repair. This is a dependency packaging workaround, not a Haze incompatibility or change.

## Coverage boundaries

No authenticated model request was sent, no user configuration or credentials were read, and no model/provider behavior was duplicated. Linux/native builds and real tablet sleep, virtual keyboard, and Wi-Fi behavior still need hardware testing. Persistence lasts only while haze-remote and its Haze child continue running; the computer must stay awake. Recent screen/history is bounded to 2,000 lines and is not stored on disk.

## Historical cockpit/Git review verification (2026-10-07; review subsequently removed)

The subsequent single-session cockpit/review implementation passed `npm run typecheck`, all **14** unit/protocol/PTY/Git tests, `npm run build`, and all **12** tablet-browser cases in Chromium/WebKit with installed-Haze coverage enabled. Installed Haze still ran with an isolated temporary HOME/workspace and no model calls. `git diff --check` also passed.

New interactions cover failed/partial paste recovery, retained in-page drafts, duplicate-paste confirmation, no reconnect replay, quick instructions that do not execute, readability preferences, narrow-screen layout, retry, canceled Unpair, read-only real Git diffs, feedback-to-draft, review recovery, and non-Git fallback. Server/Git checks cover encrypted approved-only review, revoked responses, concurrency bounds, path/credential exclusions, disabled clean filters, ignored Git environment redirection, staged/unstaged/unborn baselines, binary/rename behavior, and output limits.

Vite retains its non-failing 500 kB chunk-size warning (approximately 473 kB gzipped JavaScript). Linux and physical-tablet keyboard/sleep/Wi-Fi coverage remain outstanding; simulated tablet browser checks are not physical-device validation. That historical release added no semantic Haze event API, multiple-agent lifecycle, or HTTPS deployment support. The subsequent fleet replaces Git review; see [fleet/subagent integration evidence](fleet-and-subagents.md).

## Automatic subagent observation release (2026-10-07, later the same day)

The manual session-link sidebar was replaced by an automatic in-process observer (see [fleet-and-subagents](fleet-and-subagents.md)): workers appear when spawned, stream text/tool output live while inspected, and remain inspectable after finishing. Real installed-Haze verification includes the compiled 1.5.0 AST anchors being unique and transformable, normal rendering, `/help` paste + Enter, clean `/exit` (exit code 0) under the preload, and two concurrent native instances where exiting one leaves the other running. Final validation: typecheck, **22/22** unit/integration tests, build, package smoke, and **14/14** browser tests in Chromium/WebKit with installed-Haze coverage enabled. Provider-backed worker execution with a configured model was not exercised.

## Fleet release verification (2026-10-07)

The fleet replacement passed TypeScript checks, all **22** unit/protocol/PTY/fleet/subagent-reader tests, production build and package smoke, and all **14** Chromium/WebKit browser cases with installed-Haze coverage enabled. The package check verifies new fleet/reader modules are included and removed Git-review modules are absent from compiled artifacts. `git diff --check` passed.

Native Haze browser interactions launch two independent Haze PTYs, exercise `/help` in both, switch screens, and exit one while the other remains alive. Other browser cases cover per-instance drafts/input, reload/reconnect without duplicate launch, confirmed/canceled stop, tab removal, keyboard tab selection, real-schema linked worker metadata, quarantine/settlement, parent-specific sidebar contents, unlinking, and narrow-screen drawer behavior. The empty HOME assertion checks Haze's provider-configuration report rather than a footer label that can be truncated at narrow terminal widths.

Subagent schemas were verified against public Haze **v1.5.0** source; lifecycle streaming checks use synthetic temporary session files, not real user data or authenticated provider calls. Automatic PTY/session association and a provider-backed worker run remain unverified. See [fleet/subagent integration evidence](fleet-and-subagents.md) for the explicit linking contract and source references. Linux and physical-device validation remain outstanding; HTTPS and persistent fleet ownership across server restarts are not implemented.

A follow-up browser run exposed an offline-state race: a native WebSocket close handshake could stall while the UI still said Connected. The browser's offline event now disables input immediately and marks the connection Reconnecting, without replaying requests. After that fix, the production build and default browser suite passed (**10 passed, 4 installed-Haze cases skipped** because the executable opt-in was not set). The earlier installed-Haze-enabled run above passed all 14; it predates this offline-state fix.
