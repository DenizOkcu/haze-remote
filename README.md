# haze-remote

Control your installed [Haze](https://github.com/DenizOkcu/haze) terminal coding agent from a locally approved tablet browser. Haze runs unchanged on your computer in a real PTY. This separate package contains the TypeScript CLI/server and compiled React/xterm frontend—no Vite server is required in production.

Haze still owns models, tools, project files, configuration, and durable sessions. haze-remote neither copies agent logic nor assumes an interactive remote-agent API.

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
2. Enter **PIN A** displayed in the computer terminal. It is eight digits and rotates/expires every **20 seconds**. The PAKE handshake proves possession without transmitting the PIN directly.
3. The browser displays **code B**, bound to that handshake. Enter it using the keyboard in the computer's **haze-remote local control terminal**, within **20 seconds**.
4. The computer displays the observed network peer IP and reported browser/platform. Check the tablet's IP in its Wi-Fi settings. Browser/platform are self-reported and spoofable; VPN/proxy addresses may differ. No physical location is inferred.
5. Type **`approve`** locally before code B expires, or **`reject`**. Confirming code B alone does not authorize access. No project metadata, terminal output, or input is available before final approval.
6. Pairing closes. Only **one browser credential** may be approved for this Haze process. The browser remembers its credential in IndexedDB and re-authenticates on reconnect; PIN rotation does not interrupt approved connections.

Five handshake starts exhaust the pairing allowance, including abandoned/wrong-PIN requests. Rotation does not reset it. Type `pair` locally to reopen the window/reset the allowance when no device is approved. Someone can deliberately exhaust this budget; this is a known denial-of-service tradeoff, not a lockout bypass.

A second tab with the same credential cannot automatically take over. Close the first tab, then use **Reconnect**. A different device requires local revocation and fresh pairing.

### Local computer controls

These are handled by haze-remote's own stdin, **not** the bridged Haze PTY. No HTTP/WebSocket endpoint can invoke them.

| Input | Action |
| --- | --- |
| Eight-digit code B | Validate the pending handshake and show its device review |
| `approve` | Approve the reviewed request if still valid |
| `reject` | Reject the pending request |
| `pair` | Reopen pairing/reset attempt allowance; refused while a device is approved |
| `revoke` | Immediately revoke the credential and all its connections; Haze continues; pairing remains closed |
| `quit` / local Ctrl+C | Stop haze-remote and its Haze child |

**Unpair** in an authenticated browser revokes its credential through the encrypted channel. It does not terminate Haze or reopen pairing. To replace a device, type `revoke`, then `pair`, on the computer.

### Using the terminal

Tap **Keyboard** for direct input, or compose a prompt, tap **Paste**, then **Enter**. Pasting deliberately does not submit automatically, so multiline prompts follow Haze's paste behavior. Touch keys provide Escape, Tab, arrows, Enter, and Ctrl+C; physical keyboards work too. Browser Ctrl+C follows Haze's interrupt semantics, not the local server shutdown command.

The computer must stay awake and haze-remote must remain running. Tablet sleep, closed tabs, or lost connectivity do not stop Haze. Reconnect restores the same PID and recent screen/history. Input is never queued offline. Haze exiting leaves its final screen available until the server stops.

## Install the built npm package

```sh
npm pack                       # runs typecheck and build
npm install -g ./haze-remote-0.1.0.tgz
cd /path/to/your/project
haze-remote --lan
```

This implementation has not published the package to npm. If lifecycle scripts are restricted, approve the trusted node-pty/haze-remote scripts. For npm 12 **local** installations, use `npm install-scripts approve node-pty haze-remote`, then `npm rebuild node-pty haze-remote`. Checkout approvals are pinned. The reviewed `scripts/prepare-pty.mjs` repairs a missing execute bit on node-pty 1.1.0's macOS prebuilt helper; it never touches Haze or user project files.

```text
haze-remote [options] [-- <Haze arguments>]
--lan            Select the sole private IPv4 interface
--host <IP>      Specific private/VPN/loopback address; default 127.0.0.1
--port <number>  Default 8787; 0 selects a free port
--cwd <path>     Default launch directory
--haze <path>    Default haze on PATH
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

OPAQUE authenticates the pairing PIN or a 256-bit remembered device secret and establishes fresh keys on every connection. Libsodium XChaCha20-Poly1305 secretstream encrypts/authenticates ordered messages in independently keyed directions. It covers terminal input, resize, snapshots, output, enrollment, revocation requests, and application heartbeats. There is no plaintext terminal or cookie-authentication fallback.

Browser cryptography uses bundled WASM/JavaScript implementations, not `crypto.subtle`, which is unavailable on ordinary LAN HTTP. Browser `crypto.getRandomValues` supplies secure randomness. All assets are bundled locally; there are no accounts, telemetry, cloud services, databases, Docker, or certificate setup requirements.

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
