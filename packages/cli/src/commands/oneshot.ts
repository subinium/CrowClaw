/**
 * `crowclaw -z "<prompt>" [--model <m>] [--provider <p>]` — Hermes v0.12 parity (#332)
 *
 * Runs the agent loop once with a single prompt and exits. The prompt comes
 * from the positional argument, or stdin when no argument is supplied
 * (`echo "summarize this" | crowclaw -z`). Final assistant response is
 * printed to stdout. Tool transcripts are not surfaced — use `serve` or the
 * REPL for that.
 *
 * Why: makes CrowClaw scriptable in shell pipelines without spinning up the
 * HTTP server. Mirrors `hermes -z` and stays consistent with `crowclaw chat
 * -q`. The difference vs `chat -q`: `-z` is a top-level flag (no subcommand),
 * always one-shot, never interactive, and reads stdin when stdin is a pipe.
 */

import type { CliRuntimeLike } from '../runtime-types.js';

export interface OneshotOptions {
  /** Prompt passed positionally. When undefined, reads stdin. */
  prompt?: string;
  /** Override model (sets OPENROUTER_MODEL / CROWCLAW_MODEL). */
  model?: string;
  /** Override provider key. */
  provider?: string;
  /** Session id. Defaults to a unique `oneshot-<ts>`. */
  sessionId?: string;
  /** Inject stdin reader for tests. Defaults to process.stdin. */
  readStdin?: () => Promise<string>;
}

export interface OneshotResult {
  /** Final assistant response (stdout payload). */
  output: string;
  /** Exit code — 0 on success, 1 on internal error, 2 on user-cancel. */
  exitCode: number;
}

const ONESHOT_SESSION_PREFIX = 'oneshot-';

function readStdinDefault(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const stdin = process.stdin;
    if (stdin.isTTY) {
      // No piped input — return empty so caller can error cleanly.
      resolve('');
      return;
    }
    stdin.setEncoding('utf-8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

/**
 * Run a single agent turn and return its final response.
 * Does not write to stdout — that's the caller's job. The CLI dispatch in
 * `index.ts` calls this and prints the result so tests can capture output
 * via the returned `OneshotResult`.
 */
export async function runOneshot(
  runtime: CliRuntimeLike,
  opts: OneshotOptions = {},
): Promise<OneshotResult> {
  // Apply model/provider overrides BEFORE the runtime touches its provider
  // factory. Caller is expected to invoke this from main() where
  // process.env mutation is acceptable; tests should pass model/provider
  // via env directly to avoid coupling.
  if (opts.model) {
    process.env.OPENROUTER_MODEL = opts.model;
    process.env.CROWCLAW_MODEL = opts.model;
  }
  if (opts.provider) {
    process.env.CROWCLAW_PROVIDER = opts.provider;
  }

  let prompt = opts.prompt?.trim();
  if (!prompt) {
    const reader = opts.readStdin ?? readStdinDefault;
    try {
      const stdinText = (await reader()).trim();
      if (stdinText) prompt = stdinText;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        output: `error: failed to read stdin: ${msg}`,
        exitCode: 1,
      };
    }
  }

  if (!prompt) {
    return {
      output: 'usage: crowclaw -z "<prompt>"  (or pipe via stdin)',
      exitCode: 1,
    };
  }

  const sessionId = opts.sessionId ?? `${ONESHOT_SESSION_PREFIX}${Date.now()}`;

  try {
    const headers = new Headers({ 'content-type': 'application/json' });
    const dashToken = process.env.CROWCLAW_DASHBOARD_TOKEN;
    if (dashToken) headers.set('authorization', `Bearer ${dashToken}`);
    const request = new Request(`http://localhost/api/sessions/${sessionId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userMessage: prompt }),
    });
    const response = await runtime.fetch(request);
    if (!response.ok) {
      return {
        output: `error: session POST failed: ${response.status} ${response.statusText}`,
        exitCode: 1,
      };
    }
    const payload = (await response.json()) as {
      finalResponse?: unknown;
      session?: { sessionId?: unknown };
    };
    const finalResponse =
      typeof payload.finalResponse === 'string' ? payload.finalResponse : '';
    return { output: finalResponse, exitCode: 0 };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { output: `error: ${msg}`, exitCode: 1 };
  }
}
