# Haze compatibility and coverage boundaries

haze-remote launches installed `@denizokcu/haze` in a real PTY. Haze owns reasoning, tools, models, project files, configuration, and durable sessions; it is not replaced by a remote-agent implementation. The observer is pinned to Haze **1.5.0**. Other versions/layouts retain terminal control but report unsupported subagent observation.

## Invocation, configuration, and terminal behavior

- Resolve `haze` on PATH or select an explicit `--haze` executable. Launch interactively in the current directory or `--cwd`; arguments after `--` are passed directly without a shell.
- Inherit the host environment/HOME. Providers and Settings modify only the documented, authenticated configuration subset; API keys are write-only. Haze loads changes into fresh instances.
- Haze's `--continue`/`--resume` and saved sessions remain Haze features. Additional fleet tabs launch fresh instances unless explicitly resumed through Sessions; there is no attach/import of unrelated processes.
- Real TTY input/output, resize, Unicode, theme escapes, and xterm control responses are forwarded. Paste and Enter are separate actions because Haze can treat a combined write as pasted text.
- Reconnect restores the same server-owned PID and recent screen plus 2,000 scrollback lines, not a complete durable transcript. Browser disconnect does not stop Haze; server shutdown stops owned instances.
- Separate PTYs are not file isolation. Approve independent worktrees locally or acknowledge a shared checkout. Process lifetime is not inferred task completion.

## Evidence and its limits

Earlier installed-Haze checks on macOS arm64 exercised interactive rendering, `/help`, separate Enter, reload/reconnect with the same PID/screen, `/exit`, and independent exit of two concurrent instances. They used isolated temporary HOME/workspaces and made no authenticated model calls. Observer checks exercised the installed 1.5.0 layout without modifying installed files; sidebar browser fixtures used synthetic events rather than provider-backed execution.

Those checks establish CLI/PTY and observer compatibility, **not validation of the current hosted UI/signaling deployment**. Use [current verification commands](../README.md#verification) and [fleet/subagent coverage](fleet-and-subagents.md) for relevant checks; do not apply old suite counts to this revision. The current transport is direct LAN WebRTC with OPAQUE/secretstream channel binding; see [security](security.md).

The node-pty macOS prebuilt helper may require its reviewed package-install execute-bit repair. When no compatible prebuild exists, native build tools are required. This is dependency packaging, not a Haze modification.

## Outstanding coverage

Linux/native builds, real tablet keyboard/sleep/Wi-Fi behavior, live hosted-service operation, provider-backed subagent execution, and enterprise network deployment require additional validation. RAM-only device registration/fleet ownership ends at server restart. The host must stay awake. The protocol composition has not had an independent security audit. Internet is required for hosted UI/signaling and optional model download; no offline, VPN, IPv6, STUN/TURN, or relay support is claimed.
