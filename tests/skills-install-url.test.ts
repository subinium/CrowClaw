/**
 * v0.9.0 Hermes parity #333: `crowclaw skills install <urlOrPath>` —
 * URL install with SSRF + sha256 verification.
 *
 * Distinct from the legacy `skill install` tests in `skill-install.test.ts`:
 *   - new path is `commands/skills.ts` (plural)
 *   - rejects private/loopback URLs (SSRF gate)
 *   - hard-fails on content_hash mismatch
 *   - refuses to overwrite bundled skill slugs
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  skillsInstallFromUrl,
  BUNDLED_SKILL_SLUGS,
} from '@crowclaw/cli';

const VALID_SKILL = `---
name: hello-world
description: A demo agentskills.io skill
version: 1.0.0
license: MIT
triggers:
  - hello
---

# Hello World

1. Print hello
`;

const NOT_A_SKILL = `# Just markdown\n\nno frontmatter.\n`;

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

describe('skillsInstallFromUrl (#333)', () => {
  let dest: string;

  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'crowclaw-skills-url-'));
  });

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
  });

  it('installs from a public http(s) URL', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      expect(u).toBe('https://example.com/skill.md');
      return new Response(VALID_SKILL, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await skillsInstallFromUrl('https://example.com/skill.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.slug).toBe('hello-world');
    expect(existsSync(result.destinationPath!)).toBe(true);
  });

  it('unwraps a JSON envelope { markdown: "..." }', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ markdown: VALID_SKILL }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const result = await skillsInstallFromUrl('https://example.com/api/skill', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.slug).toBe('hello-world');
  });

  it('rejects http://127.0.0.1 (SSRF)', async () => {
    const fetchImpl = (async () => new Response(VALID_SKILL, { status: 200 })) as unknown as typeof fetch;
    const result = await skillsInstallFromUrl('http://127.0.0.1/skill.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF');
  });

  it('rejects file:// URLs (SSRF)', async () => {
    const fetchImpl = (async () => new Response(VALID_SKILL, { status: 200 })) as unknown as typeof fetch;
    const result = await skillsInstallFromUrl('file:///etc/passwd', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    // file:// fails validation as a non-http(s) protocol → SSRF code path.
    expect(result.code).toBe('SSRF');
  });

  it('reports NETWORK when the fetch returns non-2xx', async () => {
    const fetchImpl = (async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    const result = await skillsInstallFromUrl('https://example.com/missing.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NETWORK');
    expect(result.error).toMatch(/HTTP 404/);
  });

  it('reports VALIDATION when content is not a SKILL.md', async () => {
    const fetchImpl = (async () => new Response(NOT_A_SKILL, { status: 200 })) as unknown as typeof fetch;
    const result = await skillsInstallFromUrl('https://example.com/plain.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('VALIDATION');
  });

  it('reports SHA256 on content_hash mismatch', async () => {
    const wrongHash = 'sha256:' + '0'.repeat(64);
    const skillWithBadHash = `---
name: hashed
description: tests hash validation
version: 1.0.0
triggers:
  - test
content_hash: ${wrongHash}
---

# Hashed

1. step
`;
    const fetchImpl = (async () => new Response(skillWithBadHash, { status: 200 })) as unknown as typeof fetch;
    const result = await skillsInstallFromUrl('https://example.com/hash.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SHA256');
    expect(result.error).toMatch(/content_hash mismatch/);
  });

  it('accepts a matching content_hash', async () => {
    // Build a skill whose instruction body's hash matches its declared
    // content_hash. parseSkillFile trims the post-frontmatter body, so we
    // compute the hash over the TRIMMED body to match what the install
    // path will verify against.
    const trimmedBody = '# Hashed Good\n\n1. step';
    const hash = await sha256(trimmedBody);
    const skill = `---
name: hashed-good
description: matches its hash
version: 1.0.0
triggers:
  - test
content_hash: ${hash}
---

${trimmedBody}
`;

    const fetchImpl = (async () => new Response(skill, { status: 200 })) as unknown as typeof fetch;
    const result = await skillsInstallFromUrl('https://example.com/hashed-good.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    if (!result.ok) {
      // Print the error to aid diagnosis if hash math diverges from core.
      throw new Error(`install failed: ${result.code} ${result.error}`);
    }
    expect(result.ok).toBe(true);
    expect(result.slug).toBe('hashed-good');
  });

  it('refuses to overwrite bundled skill slugs', async () => {
    // Pick any bundled slug to install — should reject.
    const [firstBundled] = [...BUNDLED_SKILL_SLUGS];
    expect(firstBundled).toBeDefined();
    const skill = VALID_SKILL.replace('name: hello-world', `name: ${firstBundled}`);
    const fetchImpl = (async () => new Response(skill, { status: 200 })) as unknown as typeof fetch;
    const result = await skillsInstallFromUrl('https://example.com/bundled.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BUNDLED');
  });

  it('installs from a local filesystem path', async () => {
    const localPath = join(dest, 'local-skill.md');
    await import('node:fs/promises').then((m) => m.writeFile(localPath, VALID_SKILL, 'utf-8'));
    const result = await skillsInstallFromUrl(localPath, {
      destination: dest,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.slug).toBe('hello-world');
    const written = readFileSync(result.destinationPath!, 'utf-8');
    expect(written).toContain('name: hello-world');
  });

  it('rejects empty source', async () => {
    const result = await skillsInstallFromUrl('', { destination: dest, log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('VALIDATION');
  });
});
