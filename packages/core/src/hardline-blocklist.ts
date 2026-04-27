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
 * Default hardline patterns. Each entry matches against a NORMALIZED form of
 * the tool call: shell line-continuations, ANSI escapes, and backtick / $(...)
 * substitutions are collapsed before matching so adversarial encoding cannot
 * evade detection. Patterns are intended to be conservative — true positives
 * only. False positives here mean an operator can never approve the call at
 * all (vs. just being prompted), so patterns target shapes that have no
 * legitimate agent use.
 *
 * Parity: OpenClaw CVE-2026-28460 (line-continuation bypass) + named
 * system-path coverage (issue #65).
 */
export const HARDLINE_BLOCKLIST: ReadonlyArray<{
  pattern: RegExp;
  description: string;
}> = [
  // Recursive root deletion (any flag ordering, with or without -- separator).
  // The `(?:-…[rRf]…\s+|__SUBST__\s+)` group also matches the placeholder left
  // by command-substitution collapse so `rm $(echo -rf) /` is still caught.
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+|__SUBST__\s+)+(?:--\s+)?\/(?:\s|$|"|')/, description: 'Recursive force delete from /' },
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+|__SUBST__\s+)+(?:--\s+)?~(?:\/|\s|$|"|')/, description: 'Recursive force delete from $HOME' },
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+|__SUBST__\s+)+(?:--\s+)?\$HOME(?:\/|\s|$|"|')/, description: 'Recursive force delete from $HOME variable' },
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+|__SUBST__\s+)+(?:--\s+)?\*(?:\s|$|"|')/, description: 'Recursive force delete with bare wildcard' },

  // Recursive deletion targeting named system paths (CVE-2026-28460 family —
  // these slid past the `/`-only pattern previously). Matches only paths
  // immediately under root to avoid hitting innocent relative segments.
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+|__SUBST__\s+)+(?:--\s+)?\/(?:etc|usr|var|boot|sys|lib|lib64|opt|proc|root|bin|sbin)(?:\/|\s|$|"|')/, description: 'Recursive force delete on named system path' },

  // Raw block-device writes — overwriting whole disks/partitions.
  { pattern: /\bdd\s+[^|]*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|disk\d+|hd[a-z])/i, description: 'Raw block device overwrite via dd' },
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//i, description: 'Filesystem format on raw block device' },
  { pattern: /\bdd\s+if=\/dev\/(?:zero|random|urandom)\s+[^|]*\bof=\/dev\//i, description: 'Zero/random fill of raw block device' },

  // Fork bombs — denial of service on the host.
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, description: 'Fork bomb (classic)' },
  // Renamed fork bomb: any function calling itself in a pipe-fork pattern.
  { pattern: /\b([A-Za-z_]\w*)\s*\(\)\s*\{[^}]*\b\1\s*\|\s*\1\s*&\s*[^}]*\}\s*;\s*\1/, description: 'Fork bomb (renamed function)' },

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
 * Normalize the haystack before pattern matching. Collapses:
 *   - shell line-continuations (`\\\n`, `\\\r\n`)
 *   - ANSI/CSI escapes (`[...m` etc.)
 *   - backtick command substitution (`...`) into a single placeholder
 *   - `$(...)` command substitution into a single placeholder
 *   - escape-quoted backslash sequences within shell single-quote pairs that
 *     terminate then resume (`'\''` style continuation)
 *   - whitespace runs into single spaces
 *
 * This ensures `rm -rf /\\<newline>etc` and `rm $(echo -rf) /etc` are both
 * caught by the same `rm -rf /etc`-shaped pattern — defense against
 * CVE-2026-28460-class evasion.
 *
 * Note: we DON'T evaluate substitutions; we only collapse them so the
 * SURROUNDING command is matchable. A pattern matching against the substitution
 * body itself can be expressed by anchoring to the placeholder if needed.
 */
export function normalizeForHardline(haystack: string): string {
  let s = haystack;
  // Strip ANSI / CSI escape sequences first (they fragment patterns visually).
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\[[0-9;?]*[A-Za-z]/g, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[@-_]/g, '');
  // Collapse shell line continuations: a backslash followed by CR/LF-ish.
  s = s.replace(/\\(\r\n|\n|\r)/g, '');
  // JSON-encoded line continuations: in JSON.stringify output a literal
  // backslash-newline becomes the four-character sequence `\\n`. Collapse those
  // too so payloads embedded inside a serialized tool input are still caught.
  s = s.replace(/\\\\n/g, '');
  s = s.replace(/\\\\r\\\\n/g, '');
  // Collapse `$(...)` substitution (non-greedy, allow nesting one level).
  s = s.replace(/\$\((?:[^()]|\([^()]*\))*\)/g, '__SUBST__');
  // Collapse backtick substitution.
  s = s.replace(/`[^`]*`/g, '__SUBST__');
  // Collapse `'\''` shell-quote escape sequences (single-quote within
  // single-quoted string) — prevents fragmenting a literal command.
  s = s.replace(/'\\''/g, "'");
  // Collapse repeated whitespace.
  s = s.replace(/[ \t]+/g, ' ');
  return s;
}

/**
 * Stringify the tool call for pattern matching. Walks the input recursively
 * and concatenates raw string values — deliberately NOT JSON-stringifying so
 * that `\<newline>` line continuations remain matchable as actual byte
 * sequences (JSON would escape them as `\\n` and force the regex layer to
 * model JSON escaping). Output is then run through normalizeForHardline
 * to handle shell-level encoding evasion.
 */
function serializeToolCall(toolCall: ToolCall): string {
  const parts: string[] = [toolCall.name];
  const seen = new WeakSet<object>();
  function walk(value: unknown): void {
    if (typeof value === 'string') {
      parts.push(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === 'object') {
      if (seen.has(value as object)) return;
      seen.add(value as object);
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  }
  walk(toolCall.input);
  return normalizeForHardline(parts.join(' '));
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
