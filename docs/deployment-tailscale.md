# CrowClaw - Tailscale Deployment

Use this pattern when the Node.js runtime should be reachable only from devices
inside your tailnet. Tailscale provides network isolation; it does not replace
CrowClaw dashboard authentication. Keep `CROWCLAW_DASHBOARD_TOKEN` set.

## Direct Tailnet Bind

```bash
export PORT=8787
export CROWCLAW_DASHBOARD_TOKEN="$(openssl rand -base64 32)"
export CROWCLAW_BIND_TAILNET_ONLY=1
crowclaw serve --port "$PORT"
```

When `CROWCLAW_BIND_TAILNET_ONLY=1` is set, `crowclaw serve` runs
`tailscale ip -4` and binds the HTTP server to the first returned `100.x.y.z`
address. If Tailscale is unavailable, CrowClaw falls back to the configured
hostname and logs the failure.

You can bypass the CLI lookup when another process already discovered the
tailnet address:

```bash
export CROWCLAW_BIND_TAILNET_ONLY=1
export CROWCLAW_TAILNET_HOST=100.64.10.11
crowclaw serve --port 8787
```

## Tailnet SSRF Allowlist

CrowClaw blocks private, CGNAT, ULA, and link-local ranges by default. That
default still applies to Tailscale. Allow tailnet fetches only when the agent
is expected to call internal tailnet services:

```bash
export CROWCLAW_TAILNET_ALLOWLIST=100.64.0.0/10,fd7a:115c:a1e0::/48
```

This opt-in allows matching resolved IPs while leaving RFC1918 and metadata
addresses blocked, including `10.0.0.0/8`, `192.168.0.0/16`, and
`169.254.169.254`.

## Proxies And Funnel

For raw tailnet access, prefer the direct tailnet bind above. If you place
CrowClaw behind Tailscale Funnel, tsbridge, Caddy, or nginx, set:

```bash
export CROWCLAW_TRUSTED_PROXIES=100.64.0.0/10,fd7a:115c:a1e0::/48
```

Use Tailscale Funnel only when you intentionally expose the service through
Tailscale's public HTTPS edge. Use public Caddy plus certificates only when the
CrowClaw dashboard must be internet-reachable; in that case, treat it as a
public deployment and keep a strong dashboard token plus rate limits.

## Secret Handling

Avoid putting provider keys into launchd plists or shell history. The runtime
can read:

- direct environment variables such as `CROWCLAW_API_KEY`
- files under `CROWCLAW_SECRETS_DIR`
- systemd credentials from `CREDENTIALS_DIRECTORY`
- 1Password references such as `CROWCLAW_API_KEY=op://Vault/Item/field`

Send `SIGHUP` to the runtime process after rotating file-backed or referenced
secrets so CrowClaw re-reads the chain without dropping in-flight requests.
