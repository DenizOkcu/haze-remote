# Trusted device HTTPS with haze.build

haze-remote uses only the public API at **https://haze.build** for device provisioning.
Install Certbot locally and obtain a one-use invitation from the service operator.
No service source code, repository access or infrastructure credentials are required.

This is an **explicit local setup**, not an automatic startup enrollment or certificate
wizard. The service registers an opaque hostname, publishes a private IPv4 address and
creates temporary ACME DNS-01 records. Certbot owns the ACME account, certificate key,
CA interactions and renewal on this computer. Terminal output, input, browser assets
and audio go directly between the browser and this computer, never through haze.build.

Before enrollment, accept that the private address is published in public DNS and the
hostname appears in public certificate-transparency logs. DNS does not establish a tunnel:
the browser needs a common LAN or working VPN. Some routers block private DNS answers;
use a narrow DNS exception or appropriate VPN DNS, not a global disabling of rebinding
protection. The service accepts RFC1918 and CGNAT IPv4, not loopback, public IPs or IPv6.

## 1. Enroll and publish the chosen address

Use the installed `haze-remote` command (or `node dist/server/cli.js`). Run commands as
the same OS user that will run Certbot. In bash, read the invitation without echoing it
or putting it in shell history or command-line arguments:

```bash
read -r -s -p 'Invitation: ' invitation; printf '\n'
printf '%s\n' "$invitation" | haze-remote dns enroll 192.168.1.20
unset invitation
```

Enrollment prints only the allocated hostname. The installation credential is saved at
`~/.haze/provision/installation.json` (file mode 0600, directory 0700). Do not share or
back up this file with support bundles. Use `HAZE_PROVISION_DIRECTORY` for a different
private directory; supply it consistently to every command and scheduled Certbot hook.
Existing state is never replaced, including after a partial enrollment failure.

If address publication fails after registration, retry `address`, **not** `enroll`.
Address writes have a one-minute service cooldown, including failed provider attempts.
If registration itself fails before the local credential is saved, ask the operator for
a new invitation; consumed invitations and lost installation tokens are not recoverable.

```sh
haze-remote dns hostname
haze-remote dns address 192.168.1.21
haze-remote dns --help
```

The API origin is fixed to `https://haze.build`; there is no endpoint override, and
redirects are refused. Local installation state cannot redirect provisioning requests.
Address changes are manual. Keep DNS aligned with the private address selected by
`--host`; starting or stopping haze-remote does not publish or remove DNS automatically.
Provisioning commands do not launch Haze or require the terminal pairing interface.

## 2. Issue a certificate locally, staging first

Use an absolute, stable installed CLI path for Certbot's saved hooks. This bash example
assumes that path contains no spaces and Certbot and Node are on PATH. The hooks pass
only the DNS-01 digest to the service, wait up to 450 seconds for the exact TXT value in
the local resolver and clean up the exact challenge ID. The CA performs authoritative
validation itself. Challenges expire after ten minutes if the computer disconnects.

```bash
remote=$(command -v haze-remote)
host=$("$remote" dns hostname)
base="$HOME/.haze/acme"
umask 077
mkdir -p "$base/config" "$base/work" "$base/logs"
certbot certonly --manual --preferred-challenges dns --non-interactive \
  --manual-auth-hook "$remote dns auth" \
  --manual-cleanup-hook "$remote dns cleanup" \
  --config-dir "$base/config" --work-dir "$base/work" --logs-dir "$base/logs" \
  --cert-name "$host" -d "$host" --staging --agree-tos --email you@example.com
```

Review the CA's terms/contact details before agreeing. **Staging certificates are not
browser-trusted.** Once staging validation succeeds, repeat the command replacing
`--staging` with `--server https://acme-v02.api.letsencrypt.org/directory --force-renewal`.
Avoid repeated production issuance; CA rate limits apply. Do not upload the certificate
private key, ACME account key or CSR to the registration service.

## 3. Start direct HTTPS

```bash
haze-remote --host 192.168.1.20 --hostname "$host" \
  --tls-cert "$base/config/live/$host/fullchain.pem" \
  --tls-key "$base/config/live/$host/privkey.pem"
```

Open the printed `https://<installation>.devices.haze.build:8787` URL from the LAN/VPN.
The certificate must be currently valid for that exact hostname (no wildcard). Bind and
peer restrictions remain private; Host/Origin checks and local PIN/code/device approval
remain mandatory. Microphone permission and consent for downloading the local speech
model remain separate. `--https` is the existing self-signed alternative, not service
provisioning; do not combine it with the supplied TLS flags.

## 4. Renew or unregister

Schedule daily `certbot renew` with the same user, Node PATH, provisioning directory and
Certbot config/work/log directories. Certbot retains the manual hooks. Check the renewal
configuration with `--dry-run`. An offline/asleep laptop misses jobs, so monitor expiry.

TLS files are loaded only at startup. Restart haze-remote deliberately after renewal;
do not silently interrupt active Haze terminals, fall back to HTTP or regenerate the
identity. Expired or mismatched hostname certificates fail startup.

```sh
haze-remote dns unregister
```

Unregister revokes provisioning authorization and removes the installation DNS records.
Cleanup can remain pending after a service 503. Local files/keys are retained and existing
certificates are not revoked. Use a new private provisioning directory and invitation for
new enrollment, never the old hostname. Browser-access revocation is still a separate
local command; stopping haze-remote alone does not unregister.

## Validation boundaries

Automated tests cover local trusted HTTPS API requests, enrollment retention, command
validation, restricted credential permissions, exact-domain Certbot hooks and packaged
CLI availability. Existing direct HTTPS tests cover Host/Origin and pairing enforcement.
Live public API operation, actual ACME issuance/renewal and physical LAN/VPN
browser/microphone behavior require authorized deployment testing; no live enrollment or
certificate order is performed by the test suite.
