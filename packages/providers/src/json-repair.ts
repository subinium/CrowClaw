// ---------------------------------------------------------------------------
// json-repair — best-effort recovery for malformed tool-call arguments
// ---------------------------------------------------------------------------
//
// v0.8.0 Hermes parity (#232). Models occasionally emit JSON that is *almost*
// well-formed but trips `JSON.parse` — trailing commas, unquoted keys, single
// quotes, line/block comments, or raw truncation when the model hits a token
// budget mid-argument. Rather than failing the tool call (and forcing the
// agent to retry the whole turn), we attempt a localized repair pass.
//
// Design constraints:
//   - Self-contained. No third-party libraries — this ships in @crowclaw/providers.
//   - Never silently corrupt valid input. The fast path is `JSON.parse`; we
//     only enter the repair pipeline when that throws.
//   - Never invent values. If we close an unfinished key string mid-stream,
//     drop the dangling key — do not synthesize a placeholder value.
//   - Track which repairs were applied so observability can surface chronic
//     model misbehaviour (#232 emits `tool:args_repaired` with the reason).
//
// ~150 LOC, hand-rolled. The single-pass char walker handles strings,
// comments, and structural balancing in one go; trailing commas and
// unquoted keys are then patched as preprocessor steps before retry.
// ---------------------------------------------------------------------------

export interface RepairResult {
  value: unknown;
  repaired: boolean;
  reason?: string;
}

/**
 * Attempt to parse `raw` as JSON. Returns the parsed value with `repaired:
 * false` on the fast path. On parse failure, runs the repair pipeline; if
 * the repaired payload parses, returns `{ value, repaired: true, reason }`.
 * If the repair itself still fails to parse, throws the *original*
 * `JSON.parse` error so callers see the real diagnostic, not a transformed
 * one.
 */
export function repairJson(raw: string): RepairResult {
  // Fast path: identical to JSON.parse on success.
  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch (originalError) {
    const reasons: string[] = [];
    let working = raw;

    // 1. Strip BOM.
    if (working.charCodeAt(0) === 0xfeff) {
      working = working.slice(1);
      reasons.push('stripped BOM');
    }

    // 2. Strip line + block comments outside of strings.
    const stripped = stripCommentsOutsideStrings(working);
    if (stripped.text !== working) {
      working = stripped.text;
      if (stripped.lineComments > 0) reasons.push(`stripped ${stripped.lineComments} line comment(s)`);
      if (stripped.blockComments > 0) reasons.push(`stripped ${stripped.blockComments} block comment(s)`);
    }

    // 3. Convert single-quoted string literals to double-quoted (only outside
    //    of double-quoted strings).
    const converted = convertSingleQuotedStrings(working);
    if (converted.text !== working) {
      working = converted.text;
      reasons.push(`converted ${converted.count} single-quoted string(s)`);
    }

    // 4. Quote unquoted object keys: `{foo: 1}` → `{"foo": 1}`.
    const quoted = quoteUnquotedKeys(working);
    if (quoted.text !== working) {
      working = quoted.text;
      reasons.push(`quoted ${quoted.count} unquoted key(s)`);
    }

    // 5. Strip trailing commas in objects + arrays.
    const trailing = stripTrailingCommas(working);
    if (trailing.text !== working) {
      working = trailing.text;
      reasons.push(`stripped ${trailing.count} trailing comma(s)`);
    }

    // 6. Close unclosed strings, objects, arrays at end-of-input.
    const closed = closeUnclosed(working);
    if (closed.text !== working) {
      working = closed.text;
      if (closed.closedStrings > 0) reasons.push(`closed ${closed.closedStrings} string(s)`);
      if (closed.droppedDanglingKeys > 0) reasons.push(`dropped ${closed.droppedDanglingKeys} dangling key(s)`);
      if (closed.closedObjects > 0) reasons.push(`closed ${closed.closedObjects} object(s)`);
      if (closed.closedArrays > 0) reasons.push(`closed ${closed.closedArrays} array(s)`);
      if (closed.strippedTrailingComma) reasons.push('stripped trailing comma after close');
    }

    // 7. Retry parse. If still fails, surface the *original* error so the
    //    caller sees the real diagnostic (not a transformed offset).
    try {
      const value = JSON.parse(working) as unknown;
      return {
        value,
        repaired: true,
        reason: reasons.length > 0 ? reasons.join('; ') : 'reformatted',
      };
    } catch {
      throw originalError;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — each returns a small report so the top-level reason string can
// summarize what happened.
// ---------------------------------------------------------------------------

function stripCommentsOutsideStrings(input: string): {
  text: string;
  lineComments: number;
  blockComments: number;
} {
  let out = '';
  let i = 0;
  let lineComments = 0;
  let blockComments = 0;
  let inString: '"' | "'" | null = null;

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      // Line comment until newline.
      lineComments++;
      i += 2;
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      // Block comment until */.
      blockComments++;
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      if (i < input.length) i += 2; // skip */
      continue;
    }

    out += ch;
    i++;
  }

  return { text: out, lineComments, blockComments };
}

/**
 * Convert single-quoted strings to double-quoted. Walks chars; only triggers
 * when the single quote is *outside* an already-open double-quoted region.
 * Inside the converted span, unescaped double quotes become \" and previously
 * escaped \' becomes a bare ' (since it no longer needs escaping).
 */
function convertSingleQuotedStrings(input: string): { text: string; count: number } {
  let out = '';
  let i = 0;
  let count = 0;
  let inDouble = false;

  while (i < input.length) {
    const ch = input[i]!;

    if (inDouble) {
      out += ch;
      if (ch === '\\' && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "'") {
      // Convert this single-quoted run.
      count++;
      out += '"';
      i++;
      while (i < input.length) {
        const c = input[i]!;
        if (c === '\\' && i + 1 < input.length) {
          const escNext = input[i + 1]!;
          if (escNext === "'") {
            // \' inside single-quoted → just '.
            out += "'";
          } else {
            out += '\\' + escNext;
          }
          i += 2;
          continue;
        }
        if (c === '"') {
          // Bare " inside single-quoted → escape it.
          out += '\\"';
          i++;
          continue;
        }
        if (c === "'") {
          out += '"';
          i++;
          break;
        }
        out += c;
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return { text: out, count };
}

/**
 * Quote unquoted object keys. After `{` or `,` (skipping whitespace),
 * if we see an identifier followed by `:`, wrap it in double quotes.
 */
function quoteUnquotedKeys(input: string): { text: string; count: number } {
  let out = '';
  let i = 0;
  let count = 0;
  let inString: '"' | "'" | null = null;
  let lastStructural: string | null = null;

  while (i < input.length) {
    const ch = input[i]!;

    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      lastStructural = ch;
      i++;
      continue;
    }

    // After `{` or `,`, peek for an unquoted identifier followed by `:`.
    if ((lastStructural === '{' || lastStructural === ',') && /[A-Za-z_$]/.test(ch)) {
      // Walk identifier.
      let j = i;
      while (j < input.length && /[A-Za-z0-9_$]/.test(input[j]!)) j++;
      // Skip whitespace.
      let k = j;
      while (k < input.length && /\s/.test(input[k]!)) k++;
      if (input[k] === ':') {
        // Quote it.
        out += '"' + input.slice(i, j) + '"';
        count++;
        i = j;
        lastStructural = null;
        continue;
      }
    }

    if (!/\s/.test(ch)) lastStructural = ch;
    out += ch;
    i++;
  }

  return { text: out, count };
}

function stripTrailingCommas(input: string): { text: string; count: number } {
  let out = '';
  let i = 0;
  let count = 0;
  let inString: '"' | "'" | null = null;

  while (i < input.length) {
    const ch = input[i]!;

    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === ',') {
      // Look ahead past whitespace for `}` or `]`.
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (input[j] === '}' || input[j] === ']') {
        count++;
        i++; // drop the comma
        continue;
      }
    }

    out += ch;
    i++;
  }

  return { text: out, count };
}

interface CloseReport {
  text: string;
  closedStrings: number;
  closedObjects: number;
  closedArrays: number;
  droppedDanglingKeys: number;
  strippedTrailingComma: boolean;
}

/**
 * Walk `input` once tracking string / object / array nesting; at end-of-input
 * close anything still open. If we are inside a key string (i.e. the most
 * recent structural was `{` or `,` and we never saw a `:` after the closing
 * quote), the dangling key is dropped instead of synthesized with a value.
 *
 * We track three pieces of state per nesting level so we can recover from
 * partial pair states:
 *   - sawColon: whether the current pair has progressed past `:` already
 *   - hasValueAfterColon: whether anything (including the start of a value)
 *     followed the colon
 *   - pairStart: byte index of the most recent `{` or `,` that opened this
 *     pair, used to roll back when the pair never completed
 */
function closeUnclosed(input: string): CloseReport {
  let out = input;
  let closedStrings = 0;
  let closedObjects = 0;
  let closedArrays = 0;
  let droppedDanglingKeys = 0;
  let strippedTrailingComma = false;

  interface ObjectFrame {
    sawColon: boolean;
    hasValueAfterColon: boolean;
    pairStart: number; // index right after `{` or `,`
  }

  const stack: Array<'{' | '['> = [];
  const objectStack: ObjectFrame[] = [];
  let inString = false;
  let stringStart = -1;
  let i = 0;

  const markValueProgress = () => {
    if (objectStack.length > 0) {
      const top = objectStack[objectStack.length - 1]!;
      if (top.sawColon) top.hasValueAfterColon = true;
    }
  };

  while (i < input.length) {
    const ch = input[i]!;

    if (inString) {
      if (ch === '\\' && i + 1 < input.length) {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
        stringStart = -1;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringStart = i;
      // A string mid-pair counts as value progress only if we're past `:`.
      markValueProgress();
      i++;
      continue;
    }

    if (ch === '{') {
      stack.push('{');
      objectStack.push({ sawColon: false, hasValueAfterColon: false, pairStart: i + 1 });
    } else if (ch === '[') {
      stack.push('[');
      // Arrays don't need pair tracking; objectStack is unaffected.
    } else if (ch === '}') {
      stack.pop();
      objectStack.pop();
    } else if (ch === ']') {
      stack.pop();
    } else if (ch === ':') {
      if (objectStack.length > 0) {
        objectStack[objectStack.length - 1]!.sawColon = true;
      }
    } else if (ch === ',') {
      if (objectStack.length > 0) {
        const top = objectStack[objectStack.length - 1]!;
        top.sawColon = false;
        top.hasValueAfterColon = false;
        top.pairStart = i + 1;
      }
    } else if (!/\s/.test(ch)) {
      // Any non-whitespace literal advances value progress.
      markValueProgress();
    }

    i++;
  }

  // If we are inside a string at EOF, decide whether it's a dangling key.
  if (inString) {
    const innermost = stack[stack.length - 1];
    const insideObject = innermost === '{';
    const top = insideObject ? objectStack[objectStack.length - 1] : undefined;
    const isKey = !!top && !top.sawColon;

    if (isKey) {
      // Drop everything from the start of this incomplete pair (i.e. since
      // the last `,` or `{`) — this also strips a preceding comma so
      // `{"a":1,"b` → `{"a":1`.
      const cut = top!.pairStart;
      out = out.slice(0, cut).replace(/[\s,]+$/u, (m) => {
        if (m.includes(',')) strippedTrailingComma = true;
        return '';
      });
      // Re-trim back to the last `{` if the trim ate the entire opener body.
      droppedDanglingKeys++;
    } else {
      out += '"';
      closedStrings++;
    }
  } else if (objectStack.length > 0) {
    // Not in a string — but the innermost open object may still have an
    // incomplete pair (key without colon, or key:value with no value yet).
    const top = objectStack[objectStack.length - 1]!;
    if (!top.sawColon || !top.hasValueAfterColon) {
      // Roll back to pairStart so we don't emit `{"foo":1,"baz"}` (no value)
      // or `{"foo":1,"baz":}` (no value after colon).
      const cut = top.pairStart;
      // Only trim if there's actually content past pairStart (else this is a
      // fresh `,` with nothing after it — already handled by the trailing
      // strip below).
      if (cut < out.length) {
        const slice = out.slice(cut);
        if (slice.trim().length > 0) {
          out = out.slice(0, cut).replace(/[\s,]+$/u, (m) => {
            if (m.includes(',')) strippedTrailingComma = true;
            return '';
          });
          droppedDanglingKeys++;
        }
      }
    }
  }

  // Strip dangling commas + whitespace at the new tail.
  out = out.replace(/[\s,]+$/u, (m) => {
    if (m.includes(',')) strippedTrailingComma = true;
    return '';
  });

  // Close remaining containers.
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top === '{') {
      out += '}';
      closedObjects++;
    } else {
      out += ']';
      closedArrays++;
    }
  }

  return {
    text: out,
    closedStrings,
    closedObjects,
    closedArrays,
    droppedDanglingKeys,
    strippedTrailingComma,
  };
}
