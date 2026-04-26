import type { Sandbox } from '@cloudflare/sandbox';
import type { D1DatabaseLike, R2BucketLike } from '@crowclaw/shared';

export interface RuntimeEnv {
  AGENT_SESSIONS: DurableObjectNamespace;
  Sandbox: DurableObjectNamespace<Sandbox>;
  SANDBOX?: DurableObjectNamespace<Sandbox>;
  DB: D1DatabaseLike;
  ARTIFACTS: R2BucketLike;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  MCP_BASE_URL?: string;
  SLACK_SIGNING_SECRET?: string;
  /**
   * When set, every /api/* and /ws request must present either
   *   `Authorization: Bearer <CROWCLAW_DASHBOARD_TOKEN>` OR
   *   a cookie `crowclaw_auth=<HMAC-derived>` obtained from /api/auth/verify.
   * When unset, the deployment is treated as public and rejects every /api/*
   * route (fail-closed). Only /health and /webhooks/* remain accessible.
   */
  CROWCLAW_DASHBOARD_TOKEN?: string;
  GENERIC_WEBHOOK_SECRET?: string;
  /**
   * Discord application public key used to verify Ed25519 signatures on
   * `/webhooks/discord`. When unset, the webhook handler returns 403 — same
   * fail-closed semantics as the Node runtime (#24).
   */
  DISCORD_PUBLIC_KEY?: string;
}
