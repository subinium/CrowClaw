# CrowClaw - Mac Mini Self-Host

This runbook keeps the Node.js runtime alive on a Mac Mini using launchd. It is
for a trusted local or tailnet deployment, not a public internet edge by
itself.

## Prerequisites

- macOS with Node.js 22 or newer.
- A checked-out CrowClaw repository.
- `npm ci && npm run build` completed in the repository.
- Optional: Tailscale installed and connected when the service should be
  reachable only over a tailnet.

## Install

From the repository root:

```bash
deploy/launchd/install.sh
```

The installer writes `~/Library/LaunchAgents/dev.crowclaw.runtime.plist` and
loads it with launchctl. It does not store provider keys. Put secrets in the
environment file printed by the installer, or manage them with your preferred
macOS secret workflow.

## Environment

Recommended values:

```bash
PORT=8787
CROWCLAW_DATA_DIR=$HOME/Library/Application Support/CrowClaw/data
CROWCLAW_DASHBOARD_TOKEN=replace-with-a-long-random-token
OPENAI_API_KEY=sk-...
```

If the service is reachable beyond localhost, keep
`CROWCLAW_DASHBOARD_TOKEN` set.

## Power Settings

For a dedicated always-on host:

```bash
sudo pmset -a sleep 0
sudo pmset -a disksleep 10
sudo pmset -a powernap 1
caffeinate -dimsu
```

Run `caffeinate` inside a terminal only for manual sessions. For launchd, use
the persistent `pmset` configuration instead.

## Tailscale

For tailnet-only access, prefer CrowClaw's direct Tailscale bind mode:

```bash
CROWCLAW_BIND_TAILNET_ONLY=1 crowclaw serve --port 8787
```

Keep `CROWCLAW_DASHBOARD_TOKEN` set. If the agent must call internal tailnet
HTTP services, opt in with:

```bash
CROWCLAW_TAILNET_ALLOWLIST=100.64.0.0/10,fd7a:115c:a1e0::/48
```

See [deployment-tailscale.md](./deployment-tailscale.md) for the full threat
model and proxy options.

## Operations

```bash
launchctl print gui/"$(id -u)"/dev.crowclaw.runtime
launchctl kickstart -k gui/"$(id -u)"/dev.crowclaw.runtime
tail -f "$HOME/Library/Logs/CrowClaw/runtime.log"
```

Uninstall:

```bash
launchctl bootout gui/"$(id -u)" "$HOME/Library/LaunchAgents/dev.crowclaw.runtime.plist"
rm "$HOME/Library/LaunchAgents/dev.crowclaw.runtime.plist"
```
