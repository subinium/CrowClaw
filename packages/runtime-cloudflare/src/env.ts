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
}
