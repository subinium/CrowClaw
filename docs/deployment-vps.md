# CrowClaw - VPS Deployment

This guide runs the Node.js runtime behind Caddy with Docker Compose. It is
intended for a single VPS with Docker Engine, Compose v2, DNS pointing at the
host, and ports `80` and `443` open.

## Files

- `docker-compose.yml` builds the CrowClaw image, mounts `/data`, and runs
  Caddy as the TLS reverse proxy.
- `Caddyfile` terminates TLS and proxies to the internal CrowClaw service.
- `docs/deployment-docker.md` documents the underlying image hardening.

## Environment

Create a `.env` file next to `docker-compose.yml`:

```bash
CROWCLAW_DOMAIN=crowclaw.example.com
CROWCLAW_PUBLIC_URL=https://crowclaw.example.com
CROWCLAW_DASHBOARD_TOKEN=replace-with-a-long-random-token
CROWCLAW_TRUSTED_PROXIES=172.16.0.0/12
OPENAI_API_KEY=sk-...
```

`CROWCLAW_DASHBOARD_TOKEN` is required for public deployments. Do not expose
the dashboard without it.

Optional provider variables from `.env.example` can also be set in this file.

## Start

```bash
npm run deploy:vps
```

or directly:

```bash
docker compose up -d --build
```

Check health:

```bash
docker compose ps
curl -fsS https://"$CROWCLAW_DOMAIN"/healthz
```

## Persistence

Runtime state is stored in the `crowclaw-data` Docker volume mounted at
`/data`. This includes config, scheduler state, memory files, checkpoints, and
security audit logs. Back up the volume before host migrations:

```bash
docker run --rm -v crowclaw-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/crowclaw-data.tgz -C /data .
```

## Upgrade

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs -f crowclaw
```

Rollback uses the previous git revision plus the same persisted volume:

```bash
git checkout <previous-good-commit>
docker compose up -d --build
```

## Operational Notes

- Keep system Docker and Caddy images patched.
- Restrict SSH access to the VPS separately from CrowClaw.
- Use firewall rules so only ports `22`, `80`, and `443` are reachable unless
  the host has other explicit duties.
- Do not put API keys in `docker-compose.yml`; keep secrets in `.env` or a
  host-level secret manager.
- `CROWCLAW_TRUSTED_PROXIES=172.16.0.0/12` lets CrowClaw trust the
  `X-Forwarded-For` chain from Caddy on the private Docker bridge while the
  CrowClaw service remains un-published outside Compose.
- Caddy stores ACME certificates in the `caddy-data` volume and auto-renews
  Let's Encrypt certificates for `CROWCLAW_DOMAIN`.
