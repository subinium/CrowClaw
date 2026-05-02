FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json tsconfig.base.json vitest.config.ts ./
RUN npm ci --no-audit

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r crowclaw \
  && useradd -r -g crowclaw -u 10001 -m -d /home/crowclaw crowclaw \
  && mkdir -p /data \
  && chown crowclaw:crowclaw /data
WORKDIR /app

COPY --from=builder --chown=crowclaw:crowclaw /app/package.json ./package.json
COPY --from=builder --chown=crowclaw:crowclaw /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=crowclaw:crowclaw /app/node_modules ./node_modules
COPY --from=builder --chown=crowclaw:crowclaw /app/packages ./packages
COPY --from=builder --chown=crowclaw:crowclaw /app/scripts ./scripts

USER crowclaw
ENV CROWCLAW_DATA_DIR=/data \
  NODE_ENV=production \
  PORT=8787
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# CrowClaw HTTP server: bind explicitly to 0.0.0.0 for container port publishing.
ENTRYPOINT ["/usr/bin/tini", "--", "node"]
CMD ["scripts/docker-serve.mjs"]
