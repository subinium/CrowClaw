/**
 * `crowclaw skill install <source>`
 *
 * Installs a SKILL.md from one of three sources:
 *   1. HTTP(S) URL  — `https://example.com/skills/my-skill.md`
 *   2. agentskills.io slug  — `agentskills:author/skill-name` (resolved to
 *      https://agentskills.io/api/skills/<author>/<skill-name>/raw)
 *   3. Local filesystem path — `./my-skill.md` or `/abs/path/my-skill.md`
 *
 * Response payloads supported:
 *   - raw `SKILL.md` text (markdown with YAML frontmatter)
 *   - JSON `{ markdown: "..." }` envelope (agentskills.io registry shape)
 *
 * Tarballs are NOT unpacked here — agentskills.io v1.0 ships single-file
 * skills. If we later support multi-file bundles, extend the source resolver.
 *
 * Side effect: writes to `~/.crowclaw/skills/installed/<name>.md`
 * (or `opts.destination` if provided).
 *
 * The same logic is reachable from the runtime via
 * `POST /api/skills/install` so dashboard and CLI stay in lock-step.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { parseSkillFile, validateSkillManifest } from '@crowclaw/core';

export interface SkillInstallOptions {
  /** Override destination directory. Defaults to ~/.crowclaw/skills/installed. */
  destination?: string;
  /** Inject a fetch implementation for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Inject a logger sink (for tests / runtime). Defaults to process.stdout. */
  log?: (line: string) => void;
}

export interface SkillInstallResult {
  ok: boolean;
  slug?: string;
  destinationPath?: string;
  error?: string;
}

const AGENTSKILLS_REGISTRY_BASE = 'https://agentskills.io/api/skills';

/**
 * Fetch + validate + write a skill from a URL, registry slug, or local path.
 * Returns a structured result (does NOT throw on validation failures — those
 * are reported via { ok: false, error }).
 */
export async function skillInstall(
  source: string,
  opts: SkillInstallOptions = {}
): Promise<SkillInstallResult> {
  const log = opts.log ?? ((line) => process.stdout.write(line + '\n'));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const destinationDir =
    opts.destination ?? join(homedir(), '.crowclaw', 'skills', 'installed');

  if (!source || typeof source !== 'string') {
    return { ok: false, error: 'source is required' };
  }

  let rawContent: string;
  try {
    rawContent = await fetchSkillSource(source, fetchImpl);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to fetch skill source: ${msg}` };
  }

  // Parse: try JSON envelope first, fall back to raw markdown
  const markdown = unwrapJsonEnvelope(rawContent);

  const parsed = parseSkillFile(markdown);
  if (!parsed) {
    return {
      ok: false,
      error: 'Source does not look like a SKILL.md (missing YAML frontmatter)',
    };
  }

  const validation = validateSkillManifest(parsed.manifest);
  if (!validation.valid) {
    return {
      ok: false,
      error: `Invalid skill manifest:\n  - ${validation.errors.join('\n  - ')}`,
    };
  }
  for (const w of validation.warnings) {
    log(`warning: ${w}`);
  }

  const slug = parsed.manifest.name;
  const destinationPath = join(destinationDir, `${slug}.md`);

  try {
    await mkdir(destinationDir, { recursive: true });
    await writeFile(destinationPath, markdown, 'utf-8');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to write skill file: ${msg}` };
  }

  log(`Installed skill "${slug}" v${parsed.manifest.version ?? '0.0.0'} → ${destinationPath}`);
  return { ok: true, slug, destinationPath };
}

/**
 * Resolve `source` into raw text content.
 * - http(s):// URL → GET it
 * - `agentskills:<author>/<slug>` → fetch from registry
 * - otherwise → treat as filesystem path
 */
async function fetchSkillSource(source: string, fetchImpl: typeof fetch): Promise<string> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetchImpl(source);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${source}`);
    }
    return await res.text();
  }

  if (source.startsWith('agentskills:')) {
    const slug = source.slice('agentskills:'.length).trim();
    if (!slug) throw new Error('agentskills: source missing slug');
    const url = `${AGENTSKILLS_REGISTRY_BASE}/${encodeURI(slug)}/raw`;
    const res = await fetchImpl(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return await res.text();
  }

  const path = isAbsolute(source) ? source : resolve(process.cwd(), source);
  if (!existsSync(path)) {
    throw new Error(`Local path does not exist: ${path}`);
  }
  return await readFile(path, 'utf-8');
}

/**
 * Some registries wrap the SKILL.md body in JSON: `{ "markdown": "..." }`.
 * Detect that shape and extract the body. If the input is plain markdown,
 * return it untouched.
 */
function unwrapJsonEnvelope(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return content;
  try {
    const parsed = JSON.parse(trimmed) as { markdown?: unknown; body?: unknown };
    if (typeof parsed.markdown === 'string') return parsed.markdown;
    if (typeof parsed.body === 'string') return parsed.body;
  } catch {
    /* fall through — treat as raw */
  }
  return content;
}
