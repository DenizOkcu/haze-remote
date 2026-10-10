# Security model and protocol

## Intended boundary

haze-remote controls a code-executing agent with the computer's OS-user permissions. Pairing is not a sandbox. Use only an intended, trusted LAN and consider a dedicated unprivileged account. Follow your organization's remote-access policy.

The UI is delivered by managed website TLS at `https://haze.build/remote/`. The computer does not host a web page. HTTPS authenticates frontend delivery against network replacement, but the protocol trusts the hosted JavaScript: **a compromised frontend can read pairing secrets, remembered credentials, terminal plaintext, and microphone input**. OPAQUE and channel binding do not protect against that compromise, malicious extensions, or compromised endpoints. Same-origin IndexedDB is not a secure enclave.

Encryption does not hide connection metadata, addresses, traffic sizes/timing, or prevent denial of service. No independent audit of this protocol composition has been performed.

## Pairing ceremony and authority

The CLI requires local interactive stdin/stdout. Its QR/link is local authorization to control Haze, not just a discovery address. The link has the form `https://haze.build/remote/#room=<room>&secret=<secret>`. Keep it private; do not copy it into support bundles or logs.

A cryptographic RNG generates a 256-bit secret. It expires after 60 seconds and is consumed on successful OPAQUE proof, even if later enrollment fails. There is no automatic secret rotation or grace period: local `pair` creates a new link. Five handshake starts exhaust the allowance, including abandoned requests; local reopening resets it. These limits permit denial of service, not an authorization bypass.

The fragment is not part of hosted HTTP requests. The genuine UI reads it, removes it from the address bar, and does not send it in signaling or hosted logs. Hosted JavaScript can still read it. Never claim the hosted origin is unable to access secrets if its frontend is compromised.

The production LAN transport authorizes encrypted enrollment after possession of the secret and DTLS binding are proven; there is no separate code B or local review/approve ceremony. No fleet/terminal data is available before authentication. A separate random 256-bit device credential is enrolled inside the encrypted channel. The computer retains only an OPAQUE registration record in RAM. The browser remembers the device credential and server public key in IndexedDB, scoped to the room/server identity.

One credential and one authenticated controller serve the fleet. Another tab cannot take over; close the existing tab before reconnecting. Credentials identify authority, not an uncloneable physical device. Every reconnect uses fresh OPAQUE and stream keys; active connections expire after 30 minutes and the genuine client reconnects. Revocation or shutdown ends authority. Storage failure can preserve an in-memory connection but requires fresh pairing after reload.

Local `pair`, `cancel`, `revoke`, and `quit` operate separately from the bridged Haze terminal. Unpair is an authenticated encrypted request; it and local revoke leave Haze running and pairing closed. Shutdown stops all owned instances.

## Encrypted connections

OPAQUE authenticates the pairing or remembered secret and establishes fresh connection keys. The browser verifies the remembered OPAQUE server public key on resume. Libsodium XChaCha20-Poly1305 secretstream supplies nonce management, ordered integrity, and replay detection with independent directional keys. All application control/data messages after the handshake are encrypted; there is no plaintext terminal or bearer-cookie fallback.

The SHA-256 fingerprints from the actual client/server DTLS descriptions are canonicalized and role-ordered into **additional authenticated data (AAD)** for secretstream. Encrypted enrollment/ready messages prove this binding before granting terminal authority. A signaling intermediary that substitutes DTLS endpoints cannot authenticate those frames on a different channel. Missing, inconsistent, or non-SHA-256 fingerprints fail closed. Microphone media uses WebRTC DTLS-SRTP, not application secretstream.

Crypto libraries are bundled with the frontend. Browser cryptographic randomness is required. Mutable key/stream buffers are cleared on disposal where possible; immutable JavaScript strings, swap, and crash dumps cannot be guaranteed erased.

## Network and resource boundaries

Starting `haze-remote` selects the sole eligible RFC1918 IPv4 LAN interface automatically, or asks the local user to choose from a numbered list if several are eligible. The canonical subnet is derived from that interface's exact OS netmask, and the choice is printed before Haze startup/signaling. Only the chosen interface/subnet is permitted—not every private range. `--host`, `--interface`, and `--subnet` are optional overrides; a supplied address must exactly match the selected OS interface, and a supplied subnet must exactly match its canonical OS subnet/netmask. Invalid overrides never fall back to automatic selection. The CLI does not support VPN/tunnel or IPv6 interfaces; public, loopback, CGNAT, wildcard, and hostname selections are refused. Interface names and address checks are conservative restrictions, not proof of physical topology.

Only UDP host ICE candidates are permitted: no STUN, TURN, TCP ICE, server-reflexive, peer-reflexive, relay, or off-network fallback. Browser `.local` mDNS names are provisional until resolved to IPv4 and revalidated against the permitted subnet. The native selected pair must use the exact local interface address and a valid remote peer in that subnet before application data, with revalidation on path changes. A self, network, broadcast, or out-of-subnet address is refused. mDNS names alone never authorize access.

The computer and browser use outbound HTTPS REST at `https://api.haze.build` to create/join a signaling room and exchange SDP/ICE; room-scoped credentials authenticate signaling operations in Authorization headers. Signaling exposes room/session metadata, IP/candidate addresses, and DTLS fingerprints, not pairing secrets, terminal payloads, or audio. It is not a terminal/audio cloud relay. Managed website TLS and direct peer DTLS remain required.

Internet access is required for UI delivery and signaling, plus an optional consented model download. This is not an offline product. Guest/client isolation, multicast/mDNS blocking, or a host firewall blocking UDP may make an otherwise valid subnet unreachable. Errors require correcting reachability or selection, not bypassing browser security, disabling firewalls globally, or port-forwarding. There is no local HTTP/TLS listener, static project-file service, or public terminal API. See [migration cleanup](migration.md) for obsolete installation state.

Frames, queues, terminal geometry, input sizes, pre-authentication lifetime, and output backlog are bounded. Slow/broken connections close and recover from a bounded framebuffer; input is never queued or replayed offline.

## Fleet ownership and subagent metadata

One approved controller manages up to eight server-owned PTYs. Fleet inventories, project paths, lifecycle commands, snapshots, and worker metadata stay inside the authenticated encrypted channel. No public fleet, session-file, or Git review API is served. Local startup selects the installed executable and allowed project directories; remote launches cannot supply arbitrary executables, arguments, or cwd paths. This is a UI launch restriction, not an OS sandbox.

Each terminal snapshot names a stable instance ID and fresh view token. Input/resize must match the selected instance/token; stale selections are rejected. Legacy messages without IDs can control only the initial instance while it is selected. Switching gates input until the correct framebuffer is restored. Successful/pending launch request IDs are retained (bounded to 256); exhaustion refuses new launches rather than evicting IDs and risking duplicate processes. Failed launches release their deduplication entry. Authority is rechecked after asynchronous directory validation before spawning.

A shared checkout requires explicit acknowledgement. Stop targets one PTY; close removes only an exited tab and its in-memory screen/draft, not project files. Server shutdown stops all owned instances. Browser disconnect/revocation does not stop them. Process lifetime labels and recent output are not inferred agent/task completion.

Subagent telemetry comes from an in-process observer, not session-file reads. Each launched Haze is started with a private preload (`NODE_OPTIONS --import`) plus a random one-use Unix-socket path and token; without those environment variables the preload is inert. The loader transforms only `@denizokcu/haze` 1.5.0 modules whose exact AST anchors are uniquely present, never writes installed files, and never instruments sibling modules with matching suffixes. Unsupported versions report `unsupported` and leave the terminal unaffected. Observation cannot add capabilities: wrapped callbacks preserve Haze's originals, `this`, and return values, and all IPC frames are token-checked and schema-revalidated before use, with bounded frame sizes, a bounded child-side queue, and per-run output budgets. A compromised local same-user process could itself read this loopback traffic; the channel protects against confusion and malformed input, not against the OS user.

Only allowlisted fields are forwarded per run: IDs, scope, mode, a bounded short objective, lifecycle enums, durations, streamed text-delta text, tool names, and the final deliverable. Provider configuration/credentials, reasoning traces, tool inputs/outputs, and full prompts are never forwarded. Only the currently inspected run's output streams to the controller; other runs expose lifecycle metadata only. Run history is RAM-resident per Haze process and disappears with it. There is no worker process/terminal-control API and no parsing of ANSI output into fictional worker states.


Typed input goes directly from the focused terminal to the selected instance over the encrypted channel. Voice input composes a memory-only editable draft; nothing is queued or replayed automatically across disconnects. Font size alone is stored as a local preference. Local enqueue feedback does not promise PTY receipt. A failed encrypted write closes the connection rather than reusing an advanced secretstream state.

## Local voice input

Microphone capture requires an explicit push-to-talk action and browser permission on the hosted HTTPS page. Recordings are limited to 30 seconds. Audio is transmitted directly using WebRTC PCMU (G.711 μ-law), 8 kHz mono, protected by DTLS-SRTP. The host decodes and locally resamples to 16 kHz for Parakeet TDT 0.6B v3 INT8. Upsampling does not recover narrowband detail; noise, accent/language coverage, and packet loss can harm recognition. There is no cloud SpeechRecognition or cloud transcription fallback.

Only an authenticated explicit consent request starts the approximately 670 MB pinned, SHA-256-verified model download. Only model assets are cached; no startup download occurs. A consented download belongs to the host and survives browser disconnect until explicit Cancel download or server shutdown. Inference runs locally in an isolated CPU-capable subprocess which exits after transcription. Recording/transcription cancels on disconnect.

Audio is memory-only: no recording files, browser audio storage, session audio, or audio logs. Mutable buffers are released/cleared after use, without a guarantee against immutable strings, OS swap, or crash dumps. The editable transcript is bound to its original instance; **Send to Haze** is the only action that pastes reviewed text and submits Enter. Normal Haze persistence applies to submitted text. Partial/uncertain delivery requires manual inspection, never automatic retry.

## Verification and remaining work

Relevant suites cover LAN filtering, mDNS resolution, native selected paths, channel binding, PAKE/stream errors, secret expiry/single use, remembered reconnect, revocation, speech recording limits, PTYs, and fleet ownership. Run the current suites: historical results do not certify a live hosted deployment. Linux, physical devices, real hosted-service behavior, enterprise networks, and provider-backed worker execution need further testing. Changes to origins, storage, crypto, or authorization require focused fail-closed security review.
