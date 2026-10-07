# Security model and protocol

## Intended boundary

haze-remote is a remote interface to a code-executing agent, not a sandbox. A locally approved browser can exercise Haze's permissions as the computer's OS user. Haze itself is unchanged.

The certificate-free mode assumes genuine frontend code and trustworthy endpoints. It protects terminal messages against passive eavesdropping and unauthenticated injection/replay. It does **not** authenticate the initial HTTP document: an active network attacker can replace HTML/JavaScript, capture PIN entry, substitute the requested connection, or access plaintext/credentials in the approved browser. Local confirmation and device review do not eliminate this. A paired browser's IndexedDB credential is not protected from same-origin malicious code.

Do not call this equivalent to HTTPS/SSH or safe on an arbitrary corporate LAN/VPN. Use trusted networks and IT-approved firewall restrictions; stronger active-network protection requires independently trusted frontend delivery/transport. Encryption does not hide peer addresses, lengths, timing, handshake metadata, connection existence, or prevent denial of service.

## Pairing ceremony and authority

The CLI refuses non-TTY stdin/stdout. Its readline control interface is separate from the Haze child PTY, so remote Haze input cannot enter local approval commands. The server library exposes local capability methods for CLI/tests, but no network endpoint exposes those methods.

PIN A is eight random decimal digits generated using Node's cryptographic RNG. It rotates/expires after 60 seconds. The server registers the PIN internally with OPAQUE; neither the PIN nor registration exchange is exposed through HTTP. Five handshake starts consume the allowance even when a wrong-PIN client abandons the handshake. Rotation does not reset it. Exhaustion requires explicit local `pair`; this limits guessing but permits intentional lockout/denial of service.

A completed OPAQUE pairing proof must arrive before both the PIN generation's expiry and the 10-second handshake socket deadline. No old-PIN grace period exists. Code B is eight digits derived with a domain-separated keyed BLAKE2b hash from that exact OPAQUE session key. The independently computed browser/server codes identify the pending connection; code B is not sent in plaintext or echoed to the PC for automatic approval.

The browser generates a separate random 256-bit device secret and sends it inside the encrypted channel. The server constructs an OPAQUE registration record in memory, without retaining the raw secret. The enrollment remains pending, with no terminal access. The local user has two minutes after the PIN proof to enter code B. Successful entry consumes the code and starts a separate two-minute deadline for reviewing the network peer/reported browser/platform and typing `approve`. Re-entering a consumed code is rejected and cannot extend the deadline. The pending socket deadline advances to match the review deadline, and the browser receives an encrypted review-stage notification with a fresh countdown. Countdown durations use server-reported remaining time to avoid device clock-skew problems; expiry is enforced by the server. No terminal authority is granted by code entry alone. Rejection, expiry, or disconnect cancels the request. Approval consumes the request and closes pairing.

Observed IP comes from the TCP socket; `X-Forwarded-For` is ignored. It identifies the network peer, not necessarily physical hardware (VPN/NAT/proxies may share or change it). Browser/platform labels are inferred from spoofable User-Agent strings and whitelist-normalized before terminal output. No geographic location or hardware identity is claimed.

Only one approved device registration exists per server/Haze process, and only one authenticated connection may control the PTY. A second tab is rejected rather than taking over. New devices require local revocation followed by reopening pairing. This means one credential, not an uncloneable physical device.

## Encrypted connections

Dependencies are pinned and lockfile-resolved:

- `@serenity-kit/opaque` 1.1.0: browser/Node WASM bindings based on `opaque-ke`; upstream documents OPAQUE/RFC 9807 and an external security review. [Upstream documentation](https://github.com/serenity-kit/opaque).
- `libsodium-wrappers` 0.8.4: WASM/JavaScript high-level encryption APIs. [Wrapper documentation](https://github.com/jedisct1/libsodium.js); [secretstream semantics](https://doc.libsodium.org/secret-key_cryptography/secretstream).

Those upstream reviews do not constitute an audit of this application or the integration. Browser initialization awaits both libraries and fails closed. `crypto.getRandomValues` is required and available on supported LAN HTTP browsers; native `crypto.subtle` is not used. CSP permits WASM compilation (`wasm-unsafe-eval`), not unrestricted JavaScript eval. Crypto assets are bundled with the application, never loaded from a CDN.

Wire sequence over a same-origin checked WebSocket:

1. Client sends OPAQUE login start (`pair`, or `resume` plus a public device identifier).
2. Server sends OPAQUE login response. Client verifies the password/PIN and server proof.
3. Client sends OPAQUE login finish and its secretstream header. Server verifies the client proof. Invalid/expired proofs close the connection.
4. Server sends its secretstream header. Thereafter **every application message** must be an encrypted secretstream frame. There is no plaintext control fallback.
5. Pairing connections enroll/await local approval; resumed connections authenticate using the remembered secret. Resume also checks the stored OPAQUE server public key before sending the finish proof.

OPAQUE creates fresh connection-specific shared key material. The complete session-key encoding is hashed into 32 bytes with a protocol label; keyed BLAKE2b hashes derive distinct client-to-server and server-to-client stream keys. Libsodium secretstream supplies nonce management, authentication tags, and ordered message integrity/replay detection. Headers are public; altering them causes encrypted-message authentication failure. Cross-direction reflection and old-session frames fail. Authentication/stream errors remove server authority immediately and close the socket.

PIN B derivation is an application confirmation mechanism, not an additional cipher or an assertion that the frontend is trustworthy. It relies on the genuine client/server protocol implementations and local control boundary.

The pinned wrapper exposes numeric WASM secretstream states but not its newer documented `free()` helper. A narrowly scoped compatibility function queries libsodium's native state size, zeroes its heap span, and releases it through the exposed native allocator. Stream states and intermediate byte-array keys are disposed on disconnect. JavaScript string secrets cannot be guaranteed erased by the runtime; they are not logged or written to server disk.

A paired browser stores `{serverId, deviceId, password, serverPublicKey}` in IndexedDB. It is never a bearer cookie or a secret URL parameter. Every reconnect uses a fresh OPAQUE handshake and stream keys. Active authenticated connections have a server-enforced 30-minute maximum lifetime, after which the genuine client reconnects automatically. Device authority lasts until revocation or process shutdown. Browser storage failures permit the current in-memory connection but warn that reload requires local revocation/re-pairing.

## Network and resource boundaries

Bindings must be a specific loopback/private/VPN address; wildcard/public binds are refused. `--lan` chooses the sole eligible private IPv4 interface, otherwise requiring an explicit choice. Host checks are limited to the bound address (loopback aliases when applicable); WebSocket Origin must exactly match that HTTP host/port. Peers must have a private/loopback address. These checks do not install firewall rules or make a compromised network trustworthy.

At most 16 WebSockets are admitted at once; pre-handshake sockets expire in 10 seconds. Client frame size is capped at 128 KiB; terminal input is capped at 16 KiB per message, paste at 64 KiB, and geometry at 20–240 columns/5–100 rows. Slow output sockets close and later recover from a bounded framebuffer snapshot. PTY parsing uses backlog flow control. Protocol queues and browser server-frame sizes are bounded. Heartbeats detect broken connections. Offline input is never queued.

The only public JSON API is `/api/info`, exposing a random server-instance identifier and pairing/occupied flags—not PINs, project path, PID, credentials or terminal content. Legacy cookie/pair/logout/session APIs and network approval/revocation endpoints do not exist. Unpair is authenticated inside the encrypted channel; local revoke removes all authority immediately. Neither operation stops Haze or reopens pairing. Static serving is confined to compiled application assets, not the project directory.

## Fleet ownership and subagent metadata

One approved controller manages up to eight server-owned PTYs. Fleet inventories, project paths, lifecycle commands, snapshots, and worker metadata stay inside the authenticated encrypted channel. No public fleet, session-file, or Git review API is served. Local startup selects the installed executable and allowed project directories; remote launches cannot supply arbitrary executables, arguments, or cwd paths. This is a UI launch restriction, not an OS sandbox.

Each terminal snapshot names a stable instance ID and fresh view token. Input/resize must match the selected instance/token; stale selections are rejected. Legacy messages without IDs can control only the initial instance while it is selected. Switching gates input until the correct framebuffer is restored. Successful/pending launch request IDs are retained (bounded to 256); exhaustion refuses new launches rather than evicting IDs and risking duplicate processes. Failed launches release their deduplication entry. Authority is rechecked after asynchronous directory validation before spawning.

A shared checkout requires explicit acknowledgement. Stop targets one PTY; close removes only an exited tab and its in-memory screen/draft, not project files. Server shutdown stops all owned instances. Browser disconnect/revocation does not stop them. Process lifetime labels and recent output are not inferred agent/task completion.

Subagent telemetry comes from an in-process observer, not session-file reads. Each launched Haze is started with a private preload (`NODE_OPTIONS --import`) plus a random one-use Unix-socket path and token; without those environment variables the preload is inert. The loader transforms only `@denizokcu/haze` 1.5.0 modules whose exact AST anchors are uniquely present, never writes installed files, and never instruments sibling modules with matching suffixes. Unsupported versions report `unsupported` and leave the terminal unaffected. Observation cannot add capabilities: wrapped callbacks preserve Haze's originals, `this`, and return values, and all IPC frames are token-checked and schema-revalidated before use, with bounded frame sizes, a bounded child-side queue, and per-run output budgets. A compromised local same-user process could itself read this loopback traffic; the channel protects against confusion and malformed input, not against the OS user.

Only allowlisted fields are forwarded per run: IDs, scope, mode, a bounded short objective, lifecycle enums, durations, streamed text-delta text, tool names, and the final deliverable. Provider configuration/credentials, reasoning traces, tool inputs/outputs, and full prompts are never forwarded. Only the currently inspected run's output streams to the controller; other runs expose lifecycle metadata only. Run history is RAM-resident per Haze process and disappears with it. There is no worker process/terminal-control API and no parsing of ANSI output into fictional worker states.


Drafts and paste feedback are scoped per instance in browser memory, not persisted across reload. Font size alone is stored as a local preference. Failed/partial paste retains the draft and is never replayed automatically. Local enqueue feedback does not promise PTY receipt. A failed encrypted write closes the connection rather than reusing an advanced secretstream state.

## Verification and remaining work

Automated tests exercise PAKE mismatch, expiry, fixed cross-rotation budgets, local review/approval separation, zero terminal access before approval, one-device/tab restrictions, revocation and reconnect, ciphertext confidentiality markers, plaintext rejection, modified/replayed/reflected frames, and actual PTY behavior. Browser tests exercise Chromium and WebKit on non-secure LAN HTTP when an interface is available. Package tests exercise the installed CLI in a real local PTY with keyboard approval. Installed-Haze tests use isolated empty HOME/workspaces without model calls.

No independent application/protocol audit has been performed. Linux, physical tablets, sophisticated denial-of-service attacks, and enterprise network deployments still require additional testing/review. Future changes to crypto dependency APIs, protocol labels, storage, origins, or local approval must preserve fail-closed behavior and receive focused security review.
