// ---------------------------------------------------------------------------
// structured-output — typed contract for `provider.generateStructured<T>()`
// ---------------------------------------------------------------------------
//
// v0.8.0 Hermes parity (#237). Wraps the provider with a JSON-schema-aware
// helper that returns either a parsed value (`ok: true`) or a structured
// failure envelope (`ok: false`). The provider implementation lives in
// @crowclaw/providers — this file owns only the shared types so callers
// outside the provider package (runtime-node route handler, dashboard
// client, MCP tools) can depend on the contract without pulling the whole
// HTTP-shaped provider module in.
// ---------------------------------------------------------------------------

import type { ConversationMessage } from './index.js';

/**
 * Request payload for `provider.generateStructured<T>()`.
 *
 * - `schema` is a JSON Schema document. Providers that support a native JSON
 *   mode (OpenAI gpt-4o family on api.openai.com via `response_format:
 *   json_schema`) pass this through; everything else injects it into a system
 *   message envelope.
 * - `schemaDescription` is a human-readable hint optionally appended to the
 *   prompt (for non-native modes).
 * - `validator` is an optional caller-supplied refinement that throws on
 *   invalid values. When provided it overrides the inline schema check.
 */
export interface StructuredOutputRequest<T> {
  messages: ConversationMessage[];
  schema: object;
  schemaDescription?: string;
  validator?: (value: unknown) => T;
}

/**
 * Response envelope. `ok: true` carries the parsed (and validated) value;
 * `ok: false` distinguishes between three failure modes:
 *   - 'parse'    — model output could not be JSON-parsed (even after repair)
 *   - 'validate' — parsed but failed schema/validator
 *   - 'provider' — upstream HTTP / network / 4xx-5xx failure
 *
 * `raw` is included on every failure path so the caller can surface it in
 * dashboards or retry with a longer prompt.
 */
export type StructuredOutputResponse<T> =
  | { ok: true; value: T; raw: string; repaired?: boolean }
  | { ok: false; error: 'parse' | 'validate' | 'provider'; details: string; raw?: string };
