# CrowClaw - Docker Deployment Notes

The Docker image packages the Node.js runtime and starts the HTTP server on
port `8787`.

## Build

```bash
docker build -t crowclaw:0.8.2 .
```

## Run

```bash
docker run --rm \
  --name crowclaw \
  -p 8787:8787 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  -v crowclaw-data:/data \
  -e CROWCLAW_DASHBOARD_TOKEN="$CROWCLAW_DASHBOARD_TOKEN" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  crowclaw:0.8.2
```

The image sets `CROWCLAW_DATA_DIR=/data`, so runtime config, scheduler state,
memory files, checkpoints, and security audit logs are written under the
mounted volume instead of the container home directory.

## Hardening defaults

- Multi-stage build: dev dependencies stay out of the runtime layer.
- Non-root runtime user: UID/GID `10001`.
- `tini` is PID 1 so signals and child processes are reaped correctly.
- `/healthz` is used by the Docker `HEALTHCHECK`.
- `/data` is the only persistent writable location expected by the runtime.
- Use `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--read-only`
  for standalone containers. The Compose template applies the same defaults.

Keep `CROWCLAW_DASHBOARD_TOKEN` set whenever the dashboard is reachable from
anything other than local development.
