/**
 * v0.7.2: Codex CLI auth bridge.
 *
 * Lets users sign in to ChatGPT via the official `codex` CLI
 * (`codex login` → OAuth + PKCE → ~/.codex/auth.json) and reuse the
 * resulting access token to drive CrowClaw's runtime against the
 * ChatGPT subscription Codex backend.
 *
 * The token format is whatever Codex CLI persists; the refresh path
 * uses OpenAI's documented OAuth token endpoint with the stored
 * refresh_token. On success the file is rewritten so the next CLI
 * invocation also sees the updated tokens.
 *
 * NOTE: The Codex backend (`chatgpt.com/backend-api/codex`) is an
 * undocumented surface. This integration may break if OpenAI changes
 * the endpoint or auth flow.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexTokens {
  id_token?: string | null;
  access_token: string;
  refresh_token: string;
  account_id?: string | null;
}

export interface CodexAuthFile {
  auth_mode?: 'chatgpt' | 'apikey' | string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens | null;
  last_refresh?: string | null;
}

export interface CodexAuthStoreOptions {
  /** Override path. Defaults to ~/.codex/auth.json. */
  authPath?: string;
  /** Refresh endpoint. Defaults to https://auth.openai.com/oauth/token. */
  refreshUrl?: string;
  /** OAuth client id Codex CLI registers under. Defaults to the public CLI client id. */
  clientId?: string;
  /** Window before expiry to proactively refresh (ms). Default 60s. */
  proactiveRefreshMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  now?: () => number;
}

const DEFAULT_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const DEFAULT_REFRESH_URL = 'https://auth.openai.com/oauth/token';
// The Codex CLI ships a public OAuth client id. Mirroring it lets the
// stored refresh_token continue to validate against OpenAI's auth server.
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

interface JwtPayload {
  exp?: number;
  [k: string]: unknown;
}

/** Decode a JWT payload without verifying the signature. Returns null on parse failure. */
function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

export class CodexAuthStore {
  private readonly authPath: string;
  private readonly refreshUrl: string;
  private readonly clientId: string;
  private readonly proactiveRefreshMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: CodexAuthFile | null = null;
  private inflightRefresh: Promise<string> | null = null;

  constructor(options: CodexAuthStoreOptions = {}) {
    this.authPath = options.authPath ?? DEFAULT_AUTH_PATH;
    this.refreshUrl = options.refreshUrl ?? DEFAULT_REFRESH_URL;
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    this.proactiveRefreshMs = options.proactiveRefreshMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Load the auth file from disk. Returns null when the file is missing,
   * unreadable, or in an unrecognised shape — callers should treat null as
   * "no Codex login" and fall through to other providers.
   */
  async load(): Promise<CodexAuthFile | null> {
    try {
      const raw = await fs.readFile(this.authPath, 'utf-8');
      const parsed = JSON.parse(raw) as CodexAuthFile;
      if (!parsed || typeof parsed !== 'object') return null;
      this.cached = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Get the cached account id (used as the chatgpt-account-id header). */
  getAccountId(): string | undefined {
    return this.cached?.tokens?.account_id ?? undefined;
  }

  /** Returns true when the loaded file looks like a ChatGPT-mode login. */
  static isChatGPTAuth(file: CodexAuthFile | null): boolean {
    return !!(
      file &&
      file.auth_mode === 'chatgpt' &&
      file.tokens &&
      file.tokens.access_token &&
      file.tokens.refresh_token
    );
  }

  /**
   * Return a valid access token, refreshing if the cached one is missing,
   * expired, or within `proactiveRefreshMs` of expiry.
   */
  async getAccessToken(): Promise<string> {
    if (!this.cached) {
      await this.load();
    }
    const tokens = this.cached?.tokens;
    if (!tokens?.access_token) {
      throw new Error('Codex auth: no access_token available');
    }
    if (this.shouldRefresh(tokens.access_token)) {
      return this.refresh();
    }
    return tokens.access_token;
  }

  /** Force a refresh and return the new access token. Concurrent calls share the same in-flight refresh. */
  async refresh(): Promise<string> {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.doRefresh().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private shouldRefresh(accessToken: string): boolean {
    const payload = decodeJwtPayload(accessToken);
    const expSec = typeof payload?.exp === 'number' ? payload.exp : null;
    if (expSec === null) return false;
    const expiresAtMs = expSec * 1000;
    return expiresAtMs - this.now() <= this.proactiveRefreshMs;
  }

  private async doRefresh(): Promise<string> {
    if (!this.cached) {
      await this.load();
    }
    const refreshToken = this.cached?.tokens?.refresh_token;
    if (!refreshToken) {
      throw new Error('Codex auth: no refresh_token available — run `codex login` again');
    }

    const res = await this.fetchImpl(this.refreshUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Codex auth refresh failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }

    const payload = (await res.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
    };

    if (!payload.access_token) {
      throw new Error('Codex auth refresh returned no access_token');
    }

    const next: CodexAuthFile = {
      ...(this.cached ?? {}),
      auth_mode: this.cached?.auth_mode ?? 'chatgpt',
      tokens: {
        id_token: payload.id_token ?? this.cached?.tokens?.id_token ?? null,
        access_token: payload.access_token,
        refresh_token: payload.refresh_token ?? refreshToken,
        account_id: this.cached?.tokens?.account_id ?? null,
      },
      last_refresh: new Date().toISOString(),
    };

    this.cached = next;
    // Best-effort persist; failure is non-fatal — the in-memory cache is enough for this process.
    try {
      await fs.writeFile(this.authPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    } catch {
      // Ignore — read-only mounts, perms etc. shouldn't break the runtime.
    }

    return payload.access_token;
  }
}

/**
 * Convenience: read ~/.codex/auth.json once and report whether the user is
 * signed in to ChatGPT via the Codex CLI. Used by provider-factory to decide
 * whether to wire the ChatGPT provider before falling back to EchoProvider.
 */
export async function detectCodexChatGPTAuth(authPath?: string): Promise<{
  store: CodexAuthStore;
  accountId: string | undefined;
} | null> {
  const store = new CodexAuthStore(authPath ? { authPath } : {});
  const file = await store.load();
  if (!CodexAuthStore.isChatGPTAuth(file)) return null;
  return { store, accountId: store.getAccountId() };
}
