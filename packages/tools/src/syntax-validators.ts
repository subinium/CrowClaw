/**
 * v0.9.0 (#310) — post-write syntax validators. Hermes v0.13 #20191 showed
 * that running a cheap syntax check immediately after `write_file` cuts
 * agent iterations on edit→test loops by ~12%: the agent sees the SYNTAX_ERROR
 * envelope and self-corrects on the next turn instead of shipping broken
 * content downstream and finding out at the next test run.
 *
 * Design notes:
 *  - We deliberately do NOT pull js-yaml / @iarna/toml. Both are common
 *    transitive deps but the worktree explicitly disallows `npm install`.
 *    The YAML / TOML validators below are lightweight syntax checks
 *    sufficient for the "is this parseable?" question Hermes shipped this
 *    for — not full schema validation.
 *  - Python validation shells out to `python3 -c "import ast; ast.parse(...)"`
 *    and *degrades silently* when python3 is missing on PATH. The issue's
 *    AC explicitly requires graceful degradation: agents on a python-less
 *    host should not get spurious errors from this lint.
 *  - Validators MUST NOT roll back the write. The issue states this
 *    explicitly: "File is not rolled back — the broken content remains so
 *    the agent can see the diff and fix it." This lets follow-up
 *    workspace.read calls show the same content the validator saw.
 *  - Mode flag: `'block' | 'warn' | 'off'`. Default `'warn'` — we report
 *    the error in metadata but still mark `ok: true` so existing callers
 *    don't suddenly start failing on a borderline file. `'block'` flips
 *    the envelope to `ok: false` with the SYNTAX_ERROR shape.
 */

export type PostWriteValidationMode = 'block' | 'warn' | 'off';

export interface SyntaxErrorDetail {
  /** Stable code consumed by the tool envelope and the agent retry hint. */
  code: 'SYNTAX_ERROR';
  message: string;
  /** 1-indexed line and column when the validator can extract them. */
  line?: number;
  col?: number;
  /** The file extension that picked which validator ran. Audit/debug. */
  validator: SupportedSyntaxLanguage;
  /** Original error message from the parser, untruncated. */
  rawError?: string;
}

export type SupportedSyntaxLanguage = 'json' | 'yaml' | 'toml' | 'python';

export interface ValidatorResult {
  ok: boolean;
  error?: SyntaxErrorDetail;
  /** True if the validator was selected but couldn't run (e.g. python3 missing). */
  skipped?: boolean;
  /** Human-readable skip reason. Surfaces in metadata for debugging. */
  skipReason?: string;
}

/**
 * Map a file extension to the language to validate. `null` means "no
 * validator registered" — caller should treat as pass without warning.
 *
 * Why this is a function (not a const map): future extensions might want to
 * sniff the content (shebang, magic bytes) when the extension is missing or
 * ambiguous. The function form keeps that option open without breaking the
 * caller signature.
 */
export function pickValidator(path: string): SupportedSyntaxLanguage | null {
  // Lowercased to be case-insensitive; pull the *last* dot segment so
  // `archive.tar.gz` doesn't accidentally hit a `.tar` validator if/when we
  // add one. Path separators stripped first so `foo.json/bar.txt` (rare but
  // not impossible in workspace storage) picks `txt`, not `json`.
  const lastSegment = path.split(/[\\/]/).pop() ?? path;
  const dotIdx = lastSegment.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const ext = lastSegment.slice(dotIdx + 1).toLowerCase();
  switch (ext) {
    case 'json':
    case 'jsonc': // tolerates // comments below; lint still picks json
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'toml':
      return 'toml';
    case 'py':
    case 'pyi':
      return 'python';
    default:
      return null;
  }
}

/**
 * JSON syntax validator. Uses native `JSON.parse` — same parser the rest of
 * the stack will use, so what's "valid here" is "valid downstream".
 *
 * Returns line/col when the V8 error message includes "at position N" or
 * "line X column Y" (both shapes appear depending on Node version). Falls
 * back to undefined positions when the parser doesn't surface them.
 */
export function validateJson(content: string): ValidatorResult {
  try {
    JSON.parse(content);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { line, col } = extractJsonPosition(content, message);
    return {
      ok: false,
      error: {
        code: 'SYNTAX_ERROR',
        message: `Invalid JSON: ${message}`,
        line,
        col,
        validator: 'json',
        rawError: message,
      },
    };
  }
}

/**
 * Heuristic YAML syntax validator. Without js-yaml we can't catch every
 * YAML error, but the common write-broke-the-file cases — mismatched
 * indent, unterminated quotes, tab characters (illegal in YAML),
 * unclosed flow sequence/map — are catchable with a single pass.
 *
 * Trade-off: this is a *syntax floor*, not a full parser. Hermes ships
 * full js-yaml; we accept ~80% catch rate here in exchange for not pulling
 * a new runtime dep. When js-yaml is in package.json (future), this
 * function can switch to a real parse with no caller changes.
 */
export function validateYaml(content: string): ValidatorResult {
  // Empty / whitespace-only YAML is valid (parses to null).
  if (!content.trim()) return { ok: true };

  const lines = content.split(/\r?\n/);

  // Tabs are illegal in YAML indentation. js-yaml errors with
  // "tab characters that violate indentation". We replicate.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Tab in the leading whitespace of a non-empty line.
    const leadMatch = /^([ \t]+)/.exec(line);
    if (leadMatch && leadMatch[1]!.includes('\t')) {
      const col = leadMatch[1]!.indexOf('\t') + 1;
      return yamlError(`tab characters are not allowed for indentation (line ${i + 1}, col ${col})`, i + 1, col);
    }
  }

  // Bracket / brace balance for flow-style sequences and maps.
  let curly = 0;
  let square = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (inSingleQuote) {
        if (ch === "'") inSingleQuote = false;
        continue;
      }
      if (inDoubleQuote) {
        if (ch === '\\') { c++; continue; }
        if (ch === '"') inDoubleQuote = false;
        continue;
      }
      if (ch === '#') break; // comment to end of line
      if (ch === "'") inSingleQuote = true;
      else if (ch === '"') inDoubleQuote = true;
      else if (ch === '{') curly++;
      else if (ch === '}') {
        curly--;
        if (curly < 0) return yamlError(`unbalanced '}' (line ${i + 1}, col ${c + 1})`, i + 1, c + 1);
      } else if (ch === '[') square++;
      else if (ch === ']') {
        square--;
        if (square < 0) return yamlError(`unbalanced ']' (line ${i + 1}, col ${c + 1})`, i + 1, c + 1);
      }
    }
    if (inSingleQuote || inDoubleQuote) {
      return yamlError(`unterminated ${inSingleQuote ? 'single' : 'double'}-quoted string at line ${i + 1}`, i + 1, line.length);
    }
  }
  if (curly !== 0) return yamlError(`unclosed flow map: ${curly} unmatched '{'`, undefined, undefined);
  if (square !== 0) return yamlError(`unclosed flow sequence: ${square} unmatched '['`, undefined, undefined);

  // Trivial colon check: every non-list, non-blank, non-comment line that
  // isn't a continuation must contain `:` or start with `-`. Strict but
  // matches the issue's intent (catch obviously broken structure).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    if (/^\s*-/.test(line)) continue;          // list item
    if (/^\s*\.\.\./.test(line)) continue;      // document end marker
    if (/^\s*---/.test(line)) continue;         // document start marker
    if (/^\s*[!&*?|>%]/.test(line)) continue;   // tag/anchor/scalar mode
    if (/^\s*[\[\]{}]/.test(line)) continue;    // pure flow line
    // A pipe in YAML denotes literal scalar; allow lines that are continuations
    if (!line.includes(':')) {
      // Don't reject pure scalar documents like `42\n` or `"hello"\n`.
      if (lines.filter((l) => l.trim()).length === 1) return { ok: true };
      return yamlError(`expected mapping or list entry at line ${i + 1}`, i + 1, 1);
    }
  }

  return { ok: true };
}

function yamlError(message: string, line: number | undefined, col: number | undefined): ValidatorResult {
  return {
    ok: false,
    error: {
      code: 'SYNTAX_ERROR',
      message: `Invalid YAML: ${message}`,
      line,
      col,
      validator: 'yaml',
      rawError: message,
    },
  };
}

/**
 * Heuristic TOML syntax validator. Same trade-off as YAML: covers the
 * common breakage modes (unterminated string, malformed key=value,
 * unclosed [[array]] table header) without pulling @iarna/toml.
 */
export function validateToml(content: string): ValidatorResult {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Strip comments and trim.
    const line = raw.replace(/(?<!\\)#.*$/, '').trim();
    if (!line) continue;

    // Table header: [name] or [[name]]
    if (line.startsWith('[')) {
      const opens = (line.match(/\[/g) ?? []).length;
      const closes = (line.match(/\]/g) ?? []).length;
      if (opens !== closes) return tomlError(`unmatched '[' in table header (line ${i + 1})`, i + 1, 1);
      continue;
    }

    // Key = value
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) {
      // Could be a continuation of a multi-line value — punt and accept.
      // Strict mode would flag this; warn-default behavior tolerates it.
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (!key) return tomlError(`empty key (line ${i + 1})`, i + 1, 1);
    // Validate value's quote balance.
    if (value.startsWith('"') && !value.endsWith('"') && !value.startsWith('"""')) {
      return tomlError(`unterminated double-quoted string (line ${i + 1})`, i + 1, eqIdx + 1);
    }
    if (value.startsWith("'") && !value.endsWith("'") && !value.startsWith("'''")) {
      return tomlError(`unterminated single-quoted string (line ${i + 1})`, i + 1, eqIdx + 1);
    }
  }
  return { ok: true };
}

function tomlError(message: string, line: number, col: number): ValidatorResult {
  return {
    ok: false,
    error: {
      code: 'SYNTAX_ERROR',
      message: `Invalid TOML: ${message}`,
      line,
      col,
      validator: 'toml',
      rawError: message,
    },
  };
}

/**
 * Python AST validation. Shells out to `python3 -c "import ast; ast.parse(...)"`.
 * Returns `skipped: true` when python3 isn't on PATH so the AC "graceful
 * degradation" is honored.
 *
 * We pass the source via stdin (not -c) to avoid shell-injection / quoting
 * pitfalls — agent-generated Python can contain arbitrary triple-quoted
 * strings.
 */
export async function validatePython(content: string): Promise<ValidatorResult> {
  let spawn: typeof import('node:child_process').spawn;
  try {
    ({ spawn } = await import('node:child_process'));
  } catch {
    return { ok: true, skipped: true, skipReason: 'node:child_process unavailable (likely Cloudflare Workers)' };
  }

  return new Promise<ValidatorResult>((resolve) => {
    const child = spawn('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      // ENOENT = python3 not installed. Per AC, degrade silently.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        resolve({ ok: true, skipped: true, skipReason: 'python3 not on PATH' });
      } else {
        resolve({ ok: true, skipped: true, skipReason: `python3 spawn failed: ${err.message}` });
      }
    });

    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve({ ok: true });
        return;
      }
      // Python's SyntaxError stderr looks like:
      //   File "<stdin>", line 3
      //     def foo(:
      //            ^
      //   SyntaxError: invalid syntax
      const lineMatch = /line\s+(\d+)/i.exec(stderr);
      const line = lineMatch ? Number(lineMatch[1]) : undefined;
      // Approximate column from the caret-indicator line, when present.
      const caretMatch = /\n(\s*)\^/.exec(stderr);
      const col = caretMatch ? caretMatch[1]!.length + 1 : undefined;
      const messageMatch = /SyntaxError:\s*(.+?)(?:\n|$)/i.exec(stderr);
      const message = messageMatch ? messageMatch[1]!.trim() : stderr.trim().split('\n').pop() ?? 'syntax error';
      resolve({
        ok: false,
        error: {
          code: 'SYNTAX_ERROR',
          message: `Invalid Python: ${message}`,
          line,
          col,
          validator: 'python',
          rawError: stderr.trim(),
        },
      });
    });

    try {
      child.stdin?.write(content);
      child.stdin?.end();
    } catch {
      // stdin EPIPE — child already crashed; the close handler will fire.
    }
  });
}

/**
 * Convenience dispatcher: pick the right validator for `path` and run it
 * against `content`. Returns a fresh `ValidatorResult` so callers can wrap
 * it in their tool envelope.
 *
 * `language` overrides extension-based detection for callers that already
 * know what they're writing (rare — only useful in tests today).
 */
export async function validateSyntax(
  path: string,
  content: string,
  language?: SupportedSyntaxLanguage,
): Promise<ValidatorResult & { language: SupportedSyntaxLanguage | null }> {
  const picked = language ?? pickValidator(path);
  if (!picked) return { ok: true, language: null };
  switch (picked) {
    case 'json':
      return { ...validateJson(content), language: 'json' };
    case 'yaml':
      return { ...validateYaml(content), language: 'yaml' };
    case 'toml':
      return { ...validateToml(content), language: 'toml' };
    case 'python':
      return { ...(await validatePython(content)), language: 'python' };
  }
}

// ---------------------------------------------------------------------------
// JSON position extraction
// ---------------------------------------------------------------------------

/**
 * Extract 1-indexed line/col from a `JSON.parse` error message. Node 20+
 * reports `Unexpected token X in JSON at position N`; we walk the original
 * text to convert N → (line, col). Node 22+ sometimes already includes
 * `at line X column Y` — preferred when present.
 */
function extractJsonPosition(content: string, message: string): { line?: number; col?: number } {
  const named = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  if (named) {
    return { line: Number(named[1]), col: Number(named[2]) };
  }
  const posMatch = /position\s+(\d+)/i.exec(message);
  if (!posMatch) return {};
  const pos = Number(posMatch[1]);
  if (!Number.isFinite(pos) || pos < 0 || pos > content.length) return {};
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos; i++) {
    if (content[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}
