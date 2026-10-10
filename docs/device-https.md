# Trusted device HTTPS with haze.build

haze-remote uses only the public API at **https://haze.build** for device provisioning and
issues certificates itself with a built-in ACME DNS-01 client — **no Certbot installation,
CA workflow, or contact email is required**, and registration is open — no invitation.
Everything else runs on this computer. No service source code, repository access
or infrastructure credentials are required.

The service registers an opaque hostname, publishes a private IPv4 address and creates
temporary ACME DNS-01 records. haze-remote's built-in ACME client owns the account key,
certificate key, CA interactions and renewal on this computer. Terminal output, input,
browser assets and audio go directly between the browser and this computer, never through
haze.build.

Before enrollment, accept that the private address is published in public DNS and the
hostname appears in public certificate-transparency logs. DNS does not establish a tunnel:
the browser needs a common LAN or working VPN. Some routers block private DNS answers;
use a narrow DNS exception or appropriate VPN DNS, not a global disabling of rebinding
protection. The service accepts RFC1918 and CGNAT IPv4, not loopback, public IPs or IPv6.

## 1. Start with --https (guided)

```sh
haze-remote --lan --https
# Or choose a specific private address:
haze-remote --host 192.168.1.20 --https
```

This is the whole flow. On first use it discloses the public-DNS/certificate-transparency
trade-offs, asks for one typed consent, registers through the open public API, then requests
a production Let's Encrypt certificate via
DNS-01 — no Certbot and no email. The CA terms at
https://letsencrypt.org/repository/ are accepted as part of that consent.

On later starts it refreshes the DNS address, reuses the assigned hostname and certificate
silently, and renews automatically once inside the final 30 days of validity — no
questions, no scheduled job, no second issuance while a certificate is valid. Failures
keep the registration and exit with actionable errors; there is never a fallback to an IP
URL, HTTP, or a silently replaced certificate. A renewed certificate activates on the next
deliberate restart of haze-remote.

## 2. Manual/scripted provisioning (optional)

The `dns` subcommands remain available for scripted setups. Registration is open:

```sh
haze-remote dns enroll 192.168.1.20
```

Enrollment prints only the allocated hostname. The installation credential is saved at
`~/.haze/provision/installation.json` (file mode 0600, directory 0700). Do not share or
back up this file with support bundles. Use `HAZE_PROVISION_DIRECTORY` for a different
private directory; supply it consistently to every command. Existing state is never
replaced, including after a partial enrollment failure.

If address publication fails after registration, retry `address`, **not** `enroll`.
Address writes have a one-minute service cooldown, including failed provider attempts.
If registration itself fails before the local credential is saved, simply retry `enroll`;
lost installation tokens are not recoverable, but new registrations are always available.

```sh
haze-remote dns hostname
haze-remote dns address 192.168.1.21
haze-remote dns challenge <digest>        # Certbot-style DNS-01 hook alternative
haze-remote dns challenge-cleanup <id>
haze-remote dns --help
```

The API origin is fixed to `https://haze.build`; there is no endpoint override, and
redirects are refused. Local installation state cannot redirect provisioning requests.
Provisioning commands do not launch Haze or require the terminal pairing interface.

## 3. Using an external certificate

```bash
haze-remote --host 192.168.1.20 --hostname "$host" \
  --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem
```

Open the printed `https://<installation>.devices.haze.build:8787` URL from the LAN/VPN.
The certificate must be currently valid for that exact hostname (no wildcard). Bind and
peer restrictions remain private; Host/Origin checks and local PIN/code/device approval
remain mandatory. Microphone permission and consent for downloading the local speech
model remain separate. `--self-signed-https` is the explicit self-signed alternative;
none of these HTTPS modes may be combined. Renewal of externally managed certificates
stays external; restarted processes load whatever files are currently on disk.

## 4. Unregister

```sh
haze-remote dns unregister
```

Unregister revokes provisioning authorization and removes the installation DNS records.
Cleanup can remain pending after a service 503. Local files/keys are retained and existing
certificates are not revoked. Use a new private provisioning directory for new enrollment,
never the old hostname. Browser-access revocation is still a separate
local command; stopping haze-remote alone does not unregister.

## Validation boundaries

Automated tests cover the built-in ACME client against a local RFC 8555 directory (JWS
nonce handling, CSR encoding, DNS-01 challenge lifecycle, chain download, silent reuse,
automatic renewal inside the 30-day window, refusal paths), the public-API provisioning
requests, enrollment retention, command validation, restricted credential permissions,
and packaged CLI availability. Existing direct HTTPS tests cover Host/Origin and pairing
enforcement. Live public API operation, real Let's Encrypt issuance/renewal and physical
LAN/VPN browser/microphone behavior require authorized deployment testing; no live
enrollment or certificate order is performed by the test suite.