/**
 * Auto-capture digest extraction (v0.8.0 #238).
 *
 * Hardens the digest produced from a (userMessage, toolCallChain, assistantMessage)
 * triple so the SkillPromotionEngine can count recurrences and decide whether a
 * draft pattern should be auto-promoted into a real skill.
 *
 * Output is intentionally pure — emit `learning:draft_captured` from the caller
 * with these fields rather than coupling the digest function to the EventBus.
 */
import { createHash } from 'node:crypto';
import type { ConversationMessage } from '@crowclaw/core';

/**
 * Structured digest of a captured trajectory. Used by SkillPromotionEngine to
 * fingerprint recurring patterns and by the `learning:draft_captured` event
 * payload so the dashboard can surface what was captured.
 */
export interface AutoCaptureDigest {
  /** Top-3 keyword phrases extracted from the user message(s). */
  triggerPhrases: string[];
  /** Tool names in the order they were invoked, deduplicated only when adjacent. */
  toolSequence: string[];
  /** True iff the agent's last assistant turn contained completion language. */
  successMarker: boolean;
  /** sha256(triggerPhrases.sort() + '|' + toolSequence.join(',')) — stable across runs. */
  fingerprint: string;
  /** First user message (trimmed) — handy for dashboards. */
  userMessage: string;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'it', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'with', 'for', 'of', 'to', 'in', 'on', 'at',
  'by', 'from', 'as', 'about', 'into', 'over', 'under',
  'i', 'you', 'we', 'me', 'my', 'your', 'our', 'us',
  'be', 'am', 'are', 'was', 'were', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'doing',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
  'please', 'thanks', 'thank',
]);

const SUCCESS_PATTERNS = [
  'done', 'completed', 'complete', 'finished', 'success', 'successful',
  'shipped', 'deployed', 'verified', 'confirmed', 'all set',
  "here you go", 'here is', "here's the result", 'task complete',
];

/**
 * Extract up to 3 keyword phrases from the user message.
 * Strategy: lowercase → split on non-word → drop stop words / short tokens →
 * pick the top-3 most distinctive bi-grams (or unigrams if not enough).
 */
export function extractTriggerPhrases(userMessage: string, limit = 3): string[] {
  const cleaned = userMessage.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return [];

  // Build bi-grams; fall back to unigrams when the message is too short.
  const phrases: string[] = [];
  if (tokens.length >= 2) {
    for (let i = 0; i < tokens.length - 1; i++) {
      phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }
  // Also include single distinctive tokens so very short messages get captured.
  for (const t of tokens) {
    if (!phrases.some((p) => p.includes(t))) phrases.push(t);
  }

  // Frequency-rank, prefer bi-grams, then take top-N unique.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of phrases) {
    if (seen.has(p)) continue;
    seen.add(p);
    result.push(p);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Reduce a tool-call chain to just the ordered tool names.
 * Adjacent duplicates collapse (web.fetch, web.fetch → web.fetch) to keep the
 * fingerprint stable when the agent retries the same tool.
 */
export function abstractToolSequence(toolCalls: Array<{ name: string }>): string[] {
  const out: string[] = [];
  for (const call of toolCalls) {
    const last = out[out.length - 1];
    if (call.name && call.name !== last) out.push(call.name);
  }
  return out;
}

/**
 * Detect success language in the final assistant turn.
 * Keep this lightweight — promotion logic uses it as a soft signal, not a
 * blocking gate.
 */
export function detectSuccessMarker(messages: ConversationMessage[]): boolean {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return false;
  const text = lastAssistant.content.toLowerCase();
  return SUCCESS_PATTERNS.some((p) => text.includes(p));
}

/**
 * Compute the canonical fingerprint used for recurrence counting.
 * Important: triggerPhrases are sorted before hashing so two captures that
 * extracted the same phrases in different orders collide on the same fingerprint.
 */
export function computeDraftFingerprint(
  triggerPhrases: string[],
  toolSequence: string[],
): string {
  const sorted = [...triggerPhrases].sort();
  const key = `${sorted.join(',')}|${toolSequence.join(',')}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Build a structured digest for one captured trajectory.
 *
 * Caller is expected to emit `learning:draft_captured` with this payload after
 * the underlying draft has been persisted via `LearningPipeline.captureDraft`.
 */
export function buildAutoCaptureDigest(input: {
  messages: ConversationMessage[];
  toolCalls?: Array<{ name: string }>;
}): AutoCaptureDigest {
  const firstUser = input.messages.find((m) => m.role === 'user');
  const userMessage = firstUser?.content?.trim() ?? '';
  const triggerPhrases = extractTriggerPhrases(userMessage);
  const toolSequence = abstractToolSequence(input.toolCalls ?? []);
  const successMarker = detectSuccessMarker(input.messages);
  const fingerprint = computeDraftFingerprint(triggerPhrases, toolSequence);
  return { triggerPhrases, toolSequence, successMarker, fingerprint, userMessage };
}
