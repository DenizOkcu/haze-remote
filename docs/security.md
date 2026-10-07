# Security model and protocol

## Intended boundary

haze-remote is a remote interface to a code-executing agent, not a sandbox. A locally approved browser can exercise Haze's permissions as the computer's OS user. Haze itself is unchanged.

The certificate-free mode assumes genuine frontend code and trustworthy endpoints. It protects terminal messages against passive eavesdropping and unauthenticated injection/replay. It does **not** authenticate the initial HTTP document: an active network attacker can replace HTML/JavaScript, capture PIN entry, substitute the requested connection, or access plaintext/credentials in the approved browser. Local confirmation and device review do not eliminate this. A paired browser's IndexedDB credential is not protected from same-origin malicious code.

Do not call this equivalent to HTTPS/SSH or safe on an arbitrary corporate LAN/VPN. Use trusted networks and IT-approved firewall restrictions; stronger active-network protection requires independently trusted frontend delivery/transport. Encryption does not hide peer addresses, lengths, timing, handshake metadata, connection existence, or prevent denial of service.

## Pairing ceremony and authority

The CLI refuses non-TTY stdin/stdout. Its readline control interface is separate from the Haze child PTY, so remote Haze input cannot enter local approval commands. The server library exposes local capability methods for CLI/tests, but no network endpoint exposes those methods.

PIN A is eight random decimal digits generated using Node's cryptographic RNG. It rotates/expires after 20 seconds. The server registers the PIN internally with OPAQUE; neither the PIN nor registration exchange is exposed through HTTP. Five handshake starts consume the allowance even when a wrong-PIN client abandons the handshake. Rotation does not reset it. Exhaustion requires explicit local `pair`; this limits guessing but permits intentional lockout/denial of service.

A completed OPAQUE pairing proof must arrive before both the PIN generation's expiry and the 10-second handshake socket deadline. No old-PIN grace period exists. Code B is eight digits derived with a domain-separated keyed BLAKE2b hash from that exact OPAQUE session key. The independently computed browser/server codes identify the pending connection; code B is not sent in plaintext or echoed to the PC for automatic approval.

The browser generates a separate random 256-bit device secret and sends it inside the encrypted channel. The server constructs an OPAQUE registration record in memory, without retaining the raw secret. The enrollment remains pending, with no terminal access. Within 20 seconds of the PIN proof, the local user must enter code B, review the network peer/reported browser/platform, and separately type `approve`. The code alone is insufficient. Rejection, expiry, or disconnect cancels the request. Approval consumes the request and closes pairing.

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

## Verification and remaining work

Automated tests exercise PAKE mismatch, expiry, fixed cross-rotation budgets, local review/approval separation, zero terminal access before approval, one-device/tab restrictions, revocation and reconnect, ciphertext confidentiality markers, plaintext rejection, modified/replayed/reflected frames, and actual PTY behavior. Browser tests exercise Chromium and WebKit on non-secure LAN HTTP when an interface is available. Package tests exercise the installed CLI in a real local PTY with keyboard approval. Installed-Haze tests use isolated empty HOME/workspaces without model calls.

No independent application/protocol audit has been performed. Linux, physical tablets, sophisticated denial-of-service attacks, and enterprise network deployments still require additional testing/review. Future changes to crypto dependency APIs, protocol labels, storage, origins, or local approval must preserve fail-closed behavior and receive focused security review.
