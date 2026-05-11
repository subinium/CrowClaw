/**
 * v0.9.0 (#329) — `[[as_document]]` media-routing directive. Hermes v0.13
 * #21210 lets skill authors flag a skill so its rendered output ships as a
 * file attachment instead of inline text. Solves the "long report gets
 * truncated by Telegram's 4096-char limit" problem for consulting/exec
 * decks, code dumps, large markdown.
 *
 * Two equivalent ways to author the directive:
 *  1. Inline marker in the instructions body: literal `[[as_document]]`
 *     anywhere in the skill markdown.
 *  2. Front-matter field: `as_document: true` in the YAML block.
 *
 * Why two forms: legacy CrowClaw skills predate strict front-matter; some
 * shipped with the directive embedded in body comments. Supporting both
 * is one regex and zero coupling — matches Hermes' behavior.
 *
 * This helper deliberately lives in `packages/tools/` (not `packages/core/`)
 * so Agent C's core ownership isn't disturbed. The helper consumes the
 * existing `ParsedSkillFile` shape from `@crowclaw/core` without modifying
 * it; the directive lives in `instructions` (body) or the parsed
 * front-matter dict, both of which are read-only inputs here.
 */

import type { ParsedSkillFile } from '@crowclaw/core';

/**
 * How a rendered skill output should be delivered to the user's channel.
 * Agent B's gateway branch consumes this field on the OutgoingMessage shape
 * (either as a top-level field or under metadata.deliveryMode — see the
 * cross-cut note in the recovery brief).
 */
export type DeliveryMode = 'inline' | 'document';

/**
 * Result of inspecting a parsed skill for the `[[as_document]]` directive.
 */
export interface SkillDeliveryDirective {
  /** The effective delivery mode for this skill. Defaults to 'inline'. */
  deliveryMode: DeliveryMode;
  /** Where the directive came from. Useful for debugging "why did Telegram
   *  upload as a file?" — `'frontmatter'`, `'body'`, or `'none'`. */
  source: 'frontmatter' | 'body' | 'none';
  /** Suggested filename when `deliveryMode === 'document'`. Derived from
   *  the skill name + a sensible extension (`.md` by default). */
  filename?: string;
  /** Suggested MIME for the upload. Most adapters auto-detect, but having
   *  it here lets channels that require explicit MIME (S3 presigned URLs)
   *  skip the sniff. */
  mime?: string;
}

const INLINE_DIRECTIVE_RE = /\[\[\s*as[_-]document\s*\]\]/i;

/**
 * Inspect a parsed skill for the `[[as_document]]` directive. Front-matter
 * (`manifest.as_document` or `manifest.delivery_mode`) takes precedence over
 * body markers — that lets a skill author override an inherited body
 * directive via explicit YAML.
 *
 * Returns a `SkillDeliveryDirective` regardless; callers compare
 * `result.deliveryMode === 'document'` and route accordingly. The default
 * is `'inline'` so existing skills are unaffected.
 */
export function detectSkillDeliveryDirective(skill: ParsedSkillFile): SkillDeliveryDirective {
  // 1. Front-matter wins. We accept either `as_document: true` or the more
  //    explicit `delivery_mode: document`. First form mirrors Hermes; the
  //    second matches the OutgoingMessage shape Agent B is shipping.
  //
  //    Why we read from `skill.raw` and not `skill.manifest`: the typed
  //    SkillManifest in `@crowclaw/core` enumerates supported fields and
  //    drops unknown ones during parsing. To avoid editing Agent C's
  //    core package, we re-scan the YAML block from `raw` for our two
  //    directive keys only. This is forward-compatible: if the core
  //    parser starts retaining the field later, we'll see it there too,
  //    and either source resolves identically.
  const fromManifest = readDirectiveFromManifest(skill);
  const fromRawFront = readDirectiveFromRawFrontmatter(skill.raw);
  const fmDecision = fromManifest ?? fromRawFront;
  if (fmDecision === 'document') return finalize('document', 'frontmatter', skill);
  if (fmDecision === 'inline') return finalize('inline', 'frontmatter', skill);

  // 2. Inline body marker. We don't strip it — the rendered instructions
  //    keep the literal `[[as_document]]` for forward compatibility (some
  //    channel adapters may want to display the marker as-is).
  if (INLINE_DIRECTIVE_RE.test(skill.instructions)) {
    return finalize('document', 'body', skill);
  }

  return finalize('inline', 'none', skill);
}

/**
 * If a future core parser exposes the field directly, this picks it up.
 * Today the typed manifest drops unknown YAML keys, so this returns null
 * in practice — `readDirectiveFromRawFrontmatter` is the workhorse.
 */
function readDirectiveFromManifest(skill: ParsedSkillFile): 'document' | 'inline' | null {
  const ext = skill.manifest as unknown as Record<string, unknown>;
  if (ext.as_document === true || ext.as_document === 'true') return 'document';
  const dm = ext.delivery_mode;
  if (typeof dm === 'string') {
    const v = dm.toLowerCase();
    if (v === 'document') return 'document';
    if (v === 'inline') return 'inline';
  }
  return null;
}

/**
 * Scan the raw front-matter block for `as_document` / `delivery_mode`.
 * We deliberately keep this regex-only — no YAML parser dep, no need to
 * round-trip the entire front-matter. Two lookups, done.
 */
function readDirectiveFromRawFrontmatter(raw: string): 'document' | 'inline' | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('---')) return null;
  const end = trimmed.indexOf('---', 3);
  if (end === -1) return null;
  const yaml = trimmed.slice(3, end);

  const asDoc = /^\s*as_document\s*:\s*([^\s#]+)/im.exec(yaml);
  if (asDoc) {
    const v = asDoc[1]!.toLowerCase();
    if (v === 'true' || v === 'yes') return 'document';
    if (v === 'false' || v === 'no') return null; // explicit-off doesn't flip; caller falls through
  }
  const dm = /^\s*delivery_mode\s*:\s*['"]?([a-z]+)['"]?/im.exec(yaml);
  if (dm) {
    const v = dm[1]!.toLowerCase();
    if (v === 'document') return 'document';
    if (v === 'inline') return 'inline';
  }
  return null;
}

function finalize(
  mode: DeliveryMode,
  source: SkillDeliveryDirective['source'],
  skill: ParsedSkillFile,
): SkillDeliveryDirective {
  if (mode === 'inline') return { deliveryMode: 'inline', source };
  // For document mode, compute a default filename + mime. Skill names are
  // already kebab-case slugs (validateSkillManifest enforces this), so we
  // can use them directly. Default to .md since most skills produce
  // markdown; channel adapters can override based on actual content type.
  const safeName = (skill.manifest.name || 'skill-output').replace(/[^a-z0-9._-]/gi, '-');
  return {
    deliveryMode: 'document',
    source,
    filename: `${safeName}.md`,
    mime: 'text/markdown; charset=utf-8',
  };
}

/**
 * Apply the directive to an outgoing-message shape. Returns a new object
 * with `deliveryMode` set as a top-level field *and* echoed under
 * `metadata.deliveryMode` — the cross-cut from the recovery brief says
 * Agent B's branch may consume either, so we set both for safety.
 *
 * The mutation-free API matches the rest of the tools/ surface; callers
 * don't have to worry about aliasing the input.
 */
export function applyDeliveryDirective<TMsg extends Record<string, unknown>>(
  message: TMsg,
  directive: SkillDeliveryDirective,
): TMsg & {
  deliveryMode: DeliveryMode;
  metadata: Record<string, unknown>;
  attachments?: unknown[];
} {
  const baseMetadata: Record<string, unknown> = (message.metadata && typeof message.metadata === 'object')
    ? { ...(message.metadata as Record<string, unknown>) }
    : {};
  baseMetadata.deliveryMode = directive.deliveryMode;
  if (directive.source !== 'none') {
    baseMetadata.deliveryModeSource = directive.source;
  }

  if (directive.deliveryMode !== 'document') {
    return {
      ...message,
      deliveryMode: directive.deliveryMode,
      metadata: baseMetadata,
    };
  }

  // For document mode: build (or augment) an attachment carrying the
  // rendered text. We don't *replace* an existing `text` field — channel
  // adapters that fall back to inline (because the channel forbids file
  // uploads) need the text. The fallback path is Agent B's gateway code;
  // we just leave the door open.
  const existingAttachments = Array.isArray(message.attachments)
    ? [...(message.attachments as unknown[])]
    : [];
  const text = typeof message.text === 'string' ? message.text : '';
  const attachment = {
    filename: directive.filename ?? 'skill-output.md',
    mime: directive.mime ?? 'text/markdown; charset=utf-8',
    content: text,
    source: 'skill-as-document',
  };
  existingAttachments.push(attachment);

  return {
    ...message,
    deliveryMode: 'document',
    metadata: baseMetadata,
    attachments: existingAttachments,
  };
}
