/**
 * v0.7.2: ChatGPT (Codex backend) provider factory.
 *
 * Wires a CodexAuthStore into the existing OpenAICompatibleProvider via the
 * tokenProvider / extraHeaders / onAuthFailure hooks. Targets the
 * undocumented Codex backend at chatgpt.com/backend-api/codex/responses,
 * which is what `codex` CLI itself uses.
 */

import { OpenAICompatibleProvider } from '@crowclaw/providers';
import { CodexAuthStore, detectCodexChatGPTAuth } from './codex-auth.js';

export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
// The Codex backend rejects most named OpenAI models for ChatGPT-account auth.
// `gpt-5.5` is the entitlement the Codex CLI itself uses on a Plus/Pro account
// (verified via probe 2026-05-01); change with CROWCLAW_CODEX_MODEL when needed.
export const CHATGPT_CODEX_DEFAULT_MODEL = 'gpt-5.5';

export interface CreateOpenAIChatGPTProviderOptions {
  /** Override model. Defaults to CHATGPT_CODEX_DEFAULT_MODEL (`gpt-5.5`). */
  model?: string;
  /** Override base URL — useful for tests / proxies. */
  baseUrl?: string;
  /** Override originator header. Defaults to codex_cli_rs (matches Codex CLI). */
  originator?: string;
}

export function createOpenAIChatGPTProvider(
  store: CodexAuthStore,
  options: CreateOpenAIChatGPTProviderOptions = {}
): OpenAICompatibleProvider {
  const baseUrl = options.baseUrl ?? CHATGPT_CODEX_BASE_URL;
  const model = options.model ?? CHATGPT_CODEX_DEFAULT_MODEL;
  const originator = options.originator ?? 'codex_cli_rs';
  const accountId = store.getAccountId();

  const extraHeaders: Record<string, string> = {
    'OpenAI-Beta': 'responses=experimental',
    originator,
  };
  if (accountId) {
    extraHeaders['chatgpt-account-id'] = accountId;
  }

  return new OpenAICompatibleProvider({
    baseUrl,
    model,
    endpointPath: '/responses',
    tokenProvider: () => store.getAccessToken(),
    extraHeaders,
    // Codex backend rejects calls without `store: false` and expects the
    // system prompt at the top-level `instructions` field, not inside the
    // input array. Both are observed via the official Codex CLI traffic.
    extraBodyFields: { store: false },
    systemPromptAsInstructions: true,
    // Codex backend rejects non-streaming POSTs ("Stream must be set to true").
    // Route the non-streaming generate() path through SSE + collectStream.
    requireStream: true,
    onAuthFailure: async () => {
      try {
        await store.refresh();
        return true;
      } catch {
        return false;
      }
    },
  });
}

/**
 * Convenience: detect ~/.codex/auth.json and return a ready provider, or
 * null when the user isn't signed in to ChatGPT via Codex CLI.
 */
export async function tryCreateOpenAIChatGPTProvider(
  options: CreateOpenAIChatGPTProviderOptions & { authPath?: string } = {}
): Promise<OpenAICompatibleProvider | null> {
  const detected = await detectCodexChatGPTAuth(options.authPath);
  if (!detected) return null;
  return createOpenAIChatGPTProvider(detected.store, options);
}
