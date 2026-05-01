// ---------------------------------------------------------------------------
// SandboxPolicy — per-call gate applied inside tool-rpc.handleRequest
//
// v0.8.0 (#234) — every `code.execute` call carries a SandboxPolicy that
// restricts which host-registry tools the sandbox can transitively invoke,
// caps tool-call budget, and blocks `safety: 'destructive'` tools unless the
// caller explicitly opts in via `allowDangerous: true`.
//
// The policy is checked in tool-rpc.handleRequest BEFORE we route into the
// host's existing `executeTool` path, so plugins / hardline / approval gate
// still run on top of these checks (they apply downstream of the registry).
// ---------------------------------------------------------------------------

export interface SandboxPolicy {
  /** Exact tool names the sandbox is allowed to invoke. Anything not in this
   *  list throws ToolNotAllowed even if the host registry has it. */
  allowedTools: string[];
  /** Hard wall-clock cap on the entire `executeWithTools` run. Default 30000. */
  timeoutMs: number;
  /** Max combined stdout+stderr bytes captured. Output beyond this is truncated. */
  maxOutputBytes: number;
  /** Max number of host-registry tool calls the sandbox can make in one run.
   *  Counted by tool-rpc.handleRequest; an over-budget call throws ToolBudgetExceeded. */
  maxToolCalls: number;
  /** When false (default), tools whose manifest carries `safety: 'destructive'`
   *  are blocked even if listed in `allowedTools`. When true, the caller has
   *  taken explicit responsibility — typically only used by the tested
   *  approval-gate path or by an operator-confirmed automation. */
  allowDangerous: boolean;
}

/** Default policy used when callers don't supply one. Conservative by design:
 *  empty allowlist (sandbox can call nothing), 30s timeout, no destructive
 *  tools. Code that wants to actually do something must override allowedTools. */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  allowedTools: [],
  timeoutMs: 30_000,
  maxOutputBytes: 100_000,
  maxToolCalls: 50,
  allowDangerous: false,
};

/** Distinct error codes used by the host bridge so callers (and tests) can
 *  pattern-match on `.code` instead of fragile message-string matching. */
export type SandboxPolicyErrorCode =
  | 'ToolNotAllowed'
  | 'DangerousToolBlocked'
  | 'ToolBudgetExceeded';

export class SandboxPolicyError extends Error {
  readonly code: SandboxPolicyErrorCode;
  readonly toolName?: string;
  constructor(code: SandboxPolicyErrorCode, message: string, toolName?: string) {
    super(message);
    this.name = 'SandboxPolicyError';
    this.code = code;
    this.toolName = toolName;
  }
}

export function makePolicy(overrides?: Partial<SandboxPolicy>): SandboxPolicy {
  return { ...DEFAULT_SANDBOX_POLICY, ...(overrides ?? {}) };
}
