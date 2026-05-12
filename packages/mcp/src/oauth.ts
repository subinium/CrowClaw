import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeSecretAtomic } from '@crowclaw/shared';

const CROWCLAW_DIR = join(homedir(), '.crowclaw');
const RUNTIME_CONFIG_PATH = join(CROWCLAW_DIR, 'runtime-config.json');

export interface OAuthConfig {
  provider: string;
  clientId?: string;
  scopes: string[];
  authUrl: string;
  tokenUrl: string;
  envVarName: string;
  /** 'device_code' for terminal-friendly flows, 'pat' for manual token entry */
  flowType: 'device_code' | 'pat';
}

export const OAUTH_CONFIGS: Record<string, OAuthConfig> = {
  github: {
    provider: 'github',
    // Users must create their own GitHub OAuth App and set this client_id.
    // Create one at: https://github.com/settings/applications/new
    // Set "Device flow" enabled in the OAuth App settings.
    clientId: undefined,
    scopes: ['repo', 'read:org'],
    authUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    envVarName: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    flowType: 'device_code',
  },
  slack: {
    provider: 'slack',
    scopes: ['channels:read', 'chat:write', 'users:read'],
    authUrl: '',
    tokenUrl: '',
    envVarName: 'SLACK_BOT_TOKEN',
    flowType: 'pat',
  },
  google: {
    provider: 'google',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    authUrl: '',
    tokenUrl: '',
    envVarName: 'GOOGLE_APPLICATION_CREDENTIALS',
    flowType: 'pat',
  },
};

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
}

export interface RuntimeTokenStore {
  tokens: Record<string, { token: string; expiresAt?: string; savedAt: string }>;
}

function loadRuntimeConfig(): RuntimeTokenStore {
  try {
    if (existsSync(RUNTIME_CONFIG_PATH)) {
      const raw = readFileSync(RUNTIME_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<RuntimeTokenStore>;
      return { tokens: parsed.tokens ?? {} };
    }
  } catch {
    // Corrupt or missing file — start fresh
  }
  return { tokens: {} };
}

async function writeRuntimeConfig(store: RuntimeTokenStore): Promise<void> {
  // #296 — Hermes parity: route OAuth token persistence through the atomic
  // helper. `writeFileSync` followed `existsSync` with no `O_NOFOLLOW`
  // protection; an attacker on a shared box could plant a symlink at
  // RUNTIME_CONFIG_PATH between mkdir and write to redirect the secret
  // (NousResearch/hermes-agent#21176). `writeSecretAtomic` opens with
  // O_EXCL|O_NOFOLLOW or atomic temp-rename and enforces 0o600 perms.
  mkdirSync(CROWCLAW_DIR, { recursive: true, mode: 0o700 });
  await writeSecretAtomic(RUNTIME_CONFIG_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Request a device code from GitHub's OAuth device flow endpoint */
export async function requestDeviceCode(
  clientId: string,
  scopes: string[]
): Promise<DeviceCodeResponse> {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: scopes.join(' '),
    }),
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as DeviceCodeResponse;
}

/** Poll GitHub's token endpoint until the user authorizes the device */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!response.ok) {
      continue;
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (data.error === 'authorization_pending') {
      continue;
    }

    if (data.error === 'slow_down') {
      intervalSeconds += 5;
      continue;
    }

    if (data.error) {
      throw new Error(`OAuth token error: ${String(data.error)} — ${String(data.error_description ?? '')}`);
    }

    if (typeof data.access_token === 'string') {
      return data as unknown as TokenResponse;
    }
  }

  throw new Error('Device code flow timed out — user did not authorize in time');
}

/**
 * Start the device code OAuth flow for GitHub.
 * Returns the token on success.
 *
 * The caller is responsible for displaying the user_code and verification_uri
 * to the user (e.g., via console output).
 */
export async function startDeviceCodeFlow(provider: string): Promise<{
  token: string;
  expiresAt?: string;
}> {
  const config = OAUTH_CONFIGS[provider];
  if (!config) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  if (config.flowType !== 'device_code') {
    throw new Error(
      `Provider '${provider}' does not support device code flow. ` +
      `Use a Personal Access Token instead and run: crowclaw mcp auth ${provider}`
    );
  }

  if (!config.clientId) {
    throw new Error(
      `No client_id configured for '${provider}'. ` +
      `Create a GitHub OAuth App at https://github.com/settings/applications/new ` +
      `with Device Flow enabled, then set the client_id in the OAuth config.`
    );
  }

  const deviceCode = await requestDeviceCode(config.clientId, config.scopes);

  // The caller should display this to the user:
  // `Go to ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}`
  const tokenResponse = await pollForToken(
    config.clientId,
    deviceCode.device_code,
    deviceCode.interval,
    deviceCode.expires_in
  );

  const expiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
    : undefined;

  await saveOAuthToken(provider, tokenResponse.access_token, expiresAt);

  return {
    token: tokenResponse.access_token,
    expiresAt,
  };
}

/** Save an OAuth token to ~/.crowclaw/runtime-config.json */
export async function saveOAuthToken(
  provider: string,
  token: string,
  expiresAt?: string
): Promise<void> {
  const store = loadRuntimeConfig();
  store.tokens[provider] = {
    token,
    expiresAt,
    savedAt: new Date().toISOString(),
  };
  await writeRuntimeConfig(store);
}

/** Check if a provider has a valid (non-expired) token stored */
export function hasValidToken(provider: string): boolean {
  const store = loadRuntimeConfig();
  const entry = store.tokens[provider];
  if (!entry) {
    return false;
  }

  // If there's an expiry, check it
  if (entry.expiresAt) {
    return new Date(entry.expiresAt).getTime() > Date.now();
  }

  // No expiry means the token is valid until revoked
  return true;
}

/** Retrieve a stored token for a provider, or undefined if not found/expired */
export function getStoredToken(provider: string): string | undefined {
  if (!hasValidToken(provider)) {
    return undefined;
  }
  const store = loadRuntimeConfig();
  return store.tokens[provider]?.token;
}

/** Remove a stored token for a provider */
export async function removeToken(provider: string): Promise<boolean> {
  const store = loadRuntimeConfig();
  if (provider in store.tokens) {
    delete store.tokens[provider];
    await writeRuntimeConfig(store);
    return true;
  }
  return false;
}

/** List all providers that have stored tokens */
export function listStoredTokenProviders(): string[] {
  const store = loadRuntimeConfig();
  return Object.keys(store.tokens);
}
