/**
 * `crowclaw skills install <urlOrPath>` and `/reload-skills` —
 * Hermes v0.12 parity (#333).
 *
 * Adds two pieces:
 *   1. URL-direct skill install — fetch a SKILL.md (or zipped skill bundle)
 *      from any HTTP(S) URL, validate against the agentskills.io v1.0
 *      manifest shape, optionally verify the manifest sha256, and unpack
 *      into `~/.crowclaw/skills/<name>/`. Bundled (builtin) skills are
 *      never overwritten — installed copies live in a separate dir.
 *   2. `/reload-skills` slash command — rebuilds the in-memory skill index
 *      without restarting. Dispatched in the CLI REPL.
 *
 * SSRF protection: HTTP(S) URLs are validated via `assertSafeUrl({ kind:
 * 'fetch' })` from `@crowclaw/tools` (ssrf-blocklist). This is the central
 * SSRF choke point (#298) — it blocks private IPs, link-local addresses,
 * cloud-metadata hosts, and non-http(s) protocols, and is DNS-aware so a
 * public-looking hostname that resolves into a private/metadata range is
 * also rejected. v0.9.1 (#333 debt-closure) switched off the local
 * `validateFetchUrl` call so skill install emits the same structured
 * forensic codes (`SSRF_CLOUD_METADATA` / `SSRF_PRIVATE_NETWORK` /
 * `SSRF_INVALID_URL`) as every other outbound-fetch surface.
 *
 * sha256 manifest verification: relies on `parseSkillFile` +
 * `verifySkillContentHash` from `@crowclaw/core/skill-manifest`. Reused
 * v0.8.2 #271 primitive — we do NOT duplicate the hash logic here.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { parseSkillFile, validateSkillManifest } from '@crowclaw/core';
import { assertSafeUrl } from '@crowclaw/tools';
import type { CliRuntimeLike } from '../runtime-types.js';

/**
 * Reserved slugs that point at bundled (builtin) skills. Installing a skill
 * with one of these names is rejected to keep `crowclaw skills install` from
 * shadowing a builtin. The bundled list lives under `packages/skills/builtin/`
 * — keep this set in sync if new builtins are added.
 */
export const BUNDLED_SKILL_SLUGS = new Set(['skill-author', 'code-pipeline']);

export interface SkillsInstallOptions {
  /** Override destination dir. Defaults to ~/.crowclaw/skills/installed. */
  destination?: string;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Inject logger sink. Defaults to process.stdout. */
  log?: (line: string) => void;
  /**
   * Optional override list of bundled slugs that cannot be overwritten by
   * install. Defaults to BUNDLED_SKILL_SLUGS.
   */
  bundledSlugs?: Set<string>;
}

export interface SkillsInstallResult {
  ok: boolean;
  slug?: string;
  destinationPath?: string;
  /** Error code for programmatic checks: NETWORK | SHA256 | VALIDATION | BUNDLED | IO. */
  code?: 'NETWORK' | 'SHA256' | 'VALIDATION' | 'BUNDLED' | 'IO' | 'SSRF';
  error?: string;
}

/**
 * Install a skill from a URL or local path. URLs are SSRF-validated and
 * fetched directly. Local paths are read from disk (used by tests + skill
 * dev workflow). Both go through the same parse/validate/hash pipeline.
 */
export async function skillsInstallFromUrl(
  source: string,
  opts: SkillsInstallOptions = {},
): Promise<SkillsInstallResult> {
  const log = opts.log ?? ((line) => process.stdout.write(line + '\n'));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const destinationDir =
    opts.destination ?? join(homedir(), '.crowclaw', 'skills', 'installed');
  const bundled = opts.bundledSlugs ?? BUNDLED_SKILL_SLUGS;

  if (!source || typeof source !== 'string') {
    return { ok: false, code: 'VALIDATION', error: 'source is required' };
  }

  let raw: string;
  try {
    raw = await fetchSource(source, fetchImpl);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = msg.startsWith('SSRF:') ? 'SSRF' : 'NETWORK';
    return {
      ok: false,
      code,
      error: code === 'SSRF' ? msg.slice('SSRF:'.length).trim() : `Failed to fetch source: ${msg}`,
    };
  }

  // Some registries wrap the SKILL.md body in JSON: { markdown: "..." }
  const markdown = unwrapJsonEnvelope(raw);

  const parsed = parseSkillFile(markdown);
  if (!parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      error: 'Source does not look like a SKILL.md (missing YAML frontmatter)',
    };
  }

  const validation = validateSkillManifest(parsed.manifest);
  if (!validation.valid) {
    return {
      ok: false,
      code: 'VALIDATION',
      error: `Invalid skill manifest:\n  - ${validation.errors.join('\n  - ')}`,
    };
  }
  for (const w of validation.warnings) {
    log(`warning: ${w}`);
  }

  // sha256 validation (v0.8.2 #271 parity). When manifest.content_hash is
  // present, recompute over the instruction body. Mismatch fails the install
  // hard. We reimplement the hash computation locally to avoid pulling
  // `verifySkillContentHash` (not in @crowclaw/core's public surface) via a
  // deep import — the math is a single SHA-256 over the instruction text.
  if (parsed.manifest.content_hash) {
    let actual: string;
    try {
      actual = await computeInstructionsHash(parsed.instructions);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: 'SHA256',
        error: `content_hash verification failed: ${msg}`,
      };
    }
    if (actual.toLowerCase() !== parsed.manifest.content_hash.toLowerCase()) {
      return {
        ok: false,
        code: 'SHA256',
        error: `content_hash mismatch (manifest says ${parsed.manifest.content_hash}, computed ${actual})`,
      };
    }
  }

  const slug = parsed.manifest.name;
  if (!slug) {
    return { ok: false, code: 'VALIDATION', error: 'manifest is missing name' };
  }
  if (bundled.has(slug)) {
    return {
      ok: false,
      code: 'BUNDLED',
      error: `Cannot overwrite bundled skill "${slug}". Choose a different slug.`,
    };
  }

  const destinationPath = join(destinationDir, `${slug}.md`);
  try {
    await mkdir(destinationDir, { recursive: true });
    await writeFile(destinationPath, markdown, 'utf-8');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'IO', error: `Failed to write file: ${msg}` };
  }

  log(`Installed skill "${slug}" v${parsed.manifest.version ?? '0.0.0'} -> ${destinationPath}`);
  return { ok: true, slug, destinationPath };
}

/**
 * Fetch `source` into raw text. http(s):// is SSRF-validated and GETted.
 * Anything else is treated as a filesystem path.
 *
 * Non-http(s) URL schemes (file://, ftp://, javascript:, data:) are
 * rejected explicitly as SSRF — letting them fall through to the
 * filesystem-path branch would produce confusing "file not found" errors
 * for what is really a protocol-policy violation.
 */
async function fetchSource(source: string, fetchImpl: typeof fetch): Promise<string> {
  // Explicit reject of non-http(s) URL-like sources before the path branch.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    if (!(source.startsWith('http://') || source.startsWith('https://'))) {
      throw new Error(`SSRF: Disallowed URL scheme in "${source.split('://', 1)[0]}://"`);
    }
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    // -- v0.9.1 #298/#333 central SSRF guard BEGIN --
    // SSRF guard: refuse private IPs, link-local, cloud-metadata hosts,
    // file://, etc. Routed through the central `assertSafeUrl` choke point so
    // skill install shares the same forensic codes as every other web tool.
    await assertSafeSkillUrl(source, 'fetch source');
    // Manual redirect so we re-validate on each hop. fetch() default would
    // silently follow into a private network.
    const res = await fetchImpl(source, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) {
        await assertSafeSkillUrl(loc, 'redirect target');
        const followed = await fetchImpl(loc);
        if (!followed.ok) {
          throw new Error(`HTTP ${followed.status} ${followed.statusText} for ${loc}`);
        }
        return await followed.text();
      }
    }
    // -- v0.9.1 #298/#333 central SSRF guard END --
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${source}`);
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
 * Run the central SSRF preflight (`assertSafeUrl`) on a skill-install URL.
 * On denial, throws an `SSRF:`-prefixed error whose message embeds the
 * structured forensic code (e.g. `SSRF_CLOUD_METADATA`,
 * `SSRF_PRIVATE_NETWORK`, `SSRF_INVALID_URL`). The `SSRF:` prefix is the
 * existing contract `skillsInstallFromUrl` uses to map the failure to
 * `code: 'SSRF'`; embedding the central code keeps the forensic signal in
 * the user-facing error and lets callers/tests assert on it.
 *
 * `context` distinguishes the originating URL from a redirect hop in the
 * thrown message without changing the `SSRF:` contract.
 */
async function assertSafeSkillUrl(url: string, context: string): Promise<void> {
  const verdict = await assertSafeUrl(url, { kind: 'fetch' });
  if (!verdict.safe) {
    throw new Error(`SSRF: ${context} blocked [${verdict.code}]: ${verdict.reason}`);
  }
}

/**
 * Compute `sha256:<hex>` over an instruction body. Matches
 * `computeSkillInstructionsHash` in `@crowclaw/core/skill-manifest.ts` so
 * manifests stamped by either path validate against the other. Inlined here
 * to avoid a deep-import into a non-public core module.
 */
async function computeInstructionsHash(instructions: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API is not available');
  }
  const bytes = new TextEncoder().encode(instructions);
  const digest = await subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

function unwrapJsonEnvelope(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return content;
  try {
    const parsed = JSON.parse(trimmed) as { markdown?: unknown; body?: unknown };
    if (typeof parsed.markdown === 'string') return parsed.markdown;
    if (typeof parsed.body === 'string') return parsed.body;
  } catch {
    /* fall through */
  }
  return content;
}

// ---------------------------------------------------------------------------
// /reload-skills slash command — rebuild in-memory skill index.
// ---------------------------------------------------------------------------

export interface ReloadSkillsResult {
  ok: boolean;
  /** Skill counts after reload. */
  builtin?: number;
  learned?: number;
  local?: number;
  installed?: number;
  total?: number;
  error?: string;
}

/**
 * Trigger a runtime-side skill reload. The runtime endpoint refreshes
 * learned skills from the store and re-scans the local skill dir (and the
 * installed dir if configured). Emits `skills:reloaded` event.
 *
 * The endpoint is wired in route-handlers.ts under `POST /api/skills/reload`.
 * When the endpoint is missing (older runtime), this returns ok:false with
 * a descriptive error so REPL users get a clear "upgrade your runtime"
 * message instead of a silent no-op.
 */
export async function reloadSkills(
  runtime: CliRuntimeLike,
): Promise<ReloadSkillsResult> {
  const headers = new Headers({ 'content-type': 'application/json' });
  const dashToken = process.env.CROWCLAW_DASHBOARD_TOKEN;
  if (dashToken) headers.set('authorization', `Bearer ${dashToken}`);
  let response: Response;
  try {
    response = await runtime.fetch(
      new Request('http://localhost/api/skills/reload', {
        method: 'POST',
        headers,
        body: '{}',
      }),
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `reload request failed: ${msg}` };
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: 'runtime does not support /api/skills/reload — upgrade to v0.9.0+',
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `reload failed: HTTP ${response.status} ${response.statusText}`,
    };
  }
  try {
    const body = (await response.json()) as {
      ok?: unknown;
      builtin?: unknown;
      learned?: unknown;
      local?: unknown;
      installed?: unknown;
      total?: unknown;
      error?: unknown;
    };
    if (body.ok !== true) {
      return {
        ok: false,
        error: typeof body.error === 'string' ? body.error : 'reload returned ok=false',
      };
    }
    return {
      ok: true,
      ...(typeof body.builtin === 'number' ? { builtin: body.builtin } : {}),
      ...(typeof body.learned === 'number' ? { learned: body.learned } : {}),
      ...(typeof body.local === 'number' ? { local: body.local } : {}),
      ...(typeof body.installed === 'number' ? { installed: body.installed } : {}),
      ...(typeof body.total === 'number' ? { total: body.total } : {}),
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `failed to parse reload response: ${msg}` };
  }
}

export function formatReloadSkillsResult(result: ReloadSkillsResult): string {
  if (!result.ok) {
    return `reload failed: ${result.error ?? 'unknown error'}`;
  }
  const lines: string[] = ['Skills reloaded.'];
  const parts: string[] = [];
  if (result.builtin !== undefined) parts.push(`${result.builtin} builtin`);
  if (result.learned !== undefined) parts.push(`${result.learned} learned`);
  if (result.local !== undefined) parts.push(`${result.local} local`);
  if (result.installed !== undefined) parts.push(`${result.installed} installed`);
  if (parts.length > 0) lines.push(`  ${parts.join(', ')}`);
  if (result.total !== undefined) lines.push(`  total: ${result.total}`);
  return lines.join('\n');
}
