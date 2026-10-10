# Migration cleanup checklist

The legacy per-device DNS/certificate workflow has been removed. Current setup uses the managed HTTPS website at `https://haze.build/remote/`, outbound REST signaling at `https://api.haze.build`, and direct LAN WebRTC with DTLS. Follow [current launch and pairing instructions](../README.md#build-and-launch); do not reuse old device URLs or certificate commands. Website TLS and peer DTLS are still part of the security boundary.

## Operator-controlled cleanup (explicit consent required)

Upgrading does **not** automatically remove old registrations, revoke old credentials/certificates, delete state, or alter DNS/firewalls. Browser Unpair, local revoke, and stopping the new CLI affect current browser authority, not legacy provisioning resources.

Before any destructive cleanup, obtain the installation owner's explicit consent, establish ownership and which resources are still used, and agree on any retention/backup requirements. Do not print or attach credential/key contents to diagnostics.

- Identify obsolete device DNS registrations and records. With the owner's authorization, use the service operator's supported administrative process to revoke old provisioning credentials and remove only those records. No current CLI DNS cleanup command is provided; request operator assistance if necessary.
- Review previously issued device certificates and associated account/key state. Decide with the owner whether CA revocation is necessary. Deleting local files does not revoke a certificate or remove public DNS/certificate-transparency history.
- Inventory old local provisioning state (previously `~/.haze/provision` or a custom provisioning directory) and device TLS state (previously `~/.haze/remote/tls`). After consent and ownership checks, remove only obsolete credential, key, and state files. Do not delete Haze settings, sessions, projects, skills, or current speech-model assets.
- Remove obsolete scheduled renewal jobs, certificate hooks, device bookmarks, and narrowly identified DNS/firewall exceptions only after confirming no other application needs them. Never broaden network exposure or disable security protections to preserve the removed workflow.
- Re-pair with a fresh current QR/link on the exact permitted IPv4 LAN subnet. Clearing an old browser credential is separate from operator resource cleanup.

There is no automated migration/cleanup guarantee. If ownership or consent is missing, leave resources untouched and report the blocker to the owner/operator. See [current threat model](security.md).
