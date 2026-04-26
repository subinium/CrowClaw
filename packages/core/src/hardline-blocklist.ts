/**
 * #53: Hardline blocklist for unrecoverable commands.
 *
 * Sits *before* the human approval gate. Patterns matched here short-circuit
 * with no human prompt — preventing "consent fatigue" attacks where an
 * adversarial agent spams the approval queue with the same destructive call
 * to train the operator into reflexive approval.
 *
 * Approval gate flow becomes:
 *   1. Hardline blocklist  →  reject + audit (no operator prompt)
 *   2. Approval gate       →  human-confirm queue
 *   3. Tool execution
 *
 * Operators may extend defaults via env config; see runtime-node for wiring.
 */

import type { ToolCall } from './index.js';

/**
 * Default hardline patterns. Each entry matches against a stringified form of
 * the tool call: `<toolName> <JSON.stringify(input)>`. Patterns are intended
 * to be conservative — true positives only. False positives here mean an
 * operator can never approve the call at all (vs. just being prompted), so
 * patterns target shapes that have no legitimate agent use.
 */
export const HARDLINE_BLOCKLIST: ReadonlyArray<{
  pattern: RegExp;
  description: string;
}> = [
  // Recursive root deletion (any flag ordering, with or without -- separator).
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+(?:--\s+)?\/(?:\s|$|"|')/, description: 'Recursive force delete from /' },
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+(?:--\s+)?~(?:\s|$|"|')/, description: 'Recursive force delete from $HOME' },
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+(?:--\s+)?\*(?:\s|$|"|')/, description: 'Recursive force delete with bare wildcard' },

  // Raw block-device writes — overwriting whole disks/partitions.
  { pattern: /\bdd\s+[^|]*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|disk\d+|hd[a-z])/i, description: 'Raw block device overwrite via dd' },
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//i, description: 'Filesystem format on raw block device' },
  { pattern: /\bdd\s+if=\/dev\/(?:zero|random|urandom)\s+[^|]*\bof=\/dev\//i, description: 'Zero/random fill of raw block device' },

  // Fork bombs — denial of service on the host.
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, description: 'Fork bomb' },

  // Force-push variants targeting protected branches by convention.
  { pattern: /\bgit\s+push\s+(?:[^|;&]*\s+)?(?:-f|--force(?:-with-lease)?|\+(?:HEAD|main|master|trunk|production|prod))(?:\s|$)/i, description: 'Force push to protected branch' },

  // History rewrite operations on tracked branches.
  { pattern: /\bgit\s+(?:filter-branch|filter-repo|update-ref\s+-d\s+refs\/heads\/(?:main|master|trunk|production))\b/i, description: 'Destructive git history rewrite' },
  { pattern: /\bgit\s+reset\s+--hard\s+[a-f0-9]{7,40}\s*$/i, description: 'Hard reset to historical commit (no checkpoint)' },

  // chattr +i / +a applied to system paths — hard to undo from agent context.
  { pattern: /\bchattr\s+\+[ia]\s+\/(?:etc|usr|bin|sbin|var)\b/i, description: 'Setting immutable attribute on system path' },
];

export type HardlineBlockResult =
  | { blocked: true; pattern: string; description: string }
  | { blocked: false };

/**
 * Stringify the tool call for pattern matching. Combines tool name + a
 * compact JSON representation of input so patterns can match either tool
 * names or argument shapes.
 */
function serializeToolCall(toolCall: ToolCall): string {
  let inputStr: string;
  try {
    inputStr = JSON.stringify(toolCall.input);
  } catch {
    inputStr = String(toolCall.input);
  }
  return `${toolCall.name} ${inputStr}`;
}

/**
 * Returns blocked=true with the matched pattern source if the tool call
 * matches any hardline pattern. Operators can extend the static list via the
 * `additionalPatterns` argument (e.g., loaded from env config).
 */
export function isHardlineBlocked(
  toolCall: ToolCall,
  additionalPatterns: ReadonlyArray<{ pattern: RegExp; description: string }> = [],
): HardlineBlockResult {
  const haystack = serializeToolCall(toolCall);
  for (const entry of [...HARDLINE_BLOCKLIST, ...additionalPatterns]) {
    if (entry.pattern.test(haystack)) {
      return {
        blocked: true,
        pattern: entry.pattern.source,
        description: entry.description,
      };
    }
  }
  return { blocked: false };
}
