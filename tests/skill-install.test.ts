/**
 * Tests for `crowclaw skill install` (CLI command + runtime endpoint).
 * Covers local-path source, URL source (mocked fetch), and rejection of
 * invalid manifests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillInstall } from '../packages/cli/src/commands/skill-install.js';

const VALID_SKILL_MD = `---
name: hello-world
description: A demo agentskills.io skill
version: 1.0.0
license: MIT
triggers:
  - hello
  - say hi
---

# Hello World

1. Print hello
`;

const INVALID_SKILL_MD = `---
description: Missing name AND triggers
---

# bad
`;

const NOT_A_SKILL_FILE = `# Just a markdown file\n\nNo frontmatter.\n`;

describe('skillInstall — local file source', () => {
  let tmp: string;
  let dest: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crowclaw-skill-test-'));
    dest = mkdtempSync(join(tmpdir(), 'crowclaw-skill-dest-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('installs a valid skill from a local path', async () => {
    const sourcePath = join(tmp, 'hello.md');
    writeFileSync(sourcePath, VALID_SKILL_MD, 'utf-8');

    const result = await skillInstall(sourcePath, {
      destination: dest,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.slug).toBe('hello-world');
    expect(result.destinationPath).toBe(join(dest, 'hello-world.md'));
    expect(existsSync(result.destinationPath!)).toBe(true);
    const written = readFileSync(result.destinationPath!, 'utf-8');
    expect(written).toContain('name: hello-world');
  });

  it('rejects a manifest missing required fields', async () => {
    const sourcePath = join(tmp, 'broken.md');
    writeFileSync(sourcePath, INVALID_SKILL_MD, 'utf-8');

    const result = await skillInstall(sourcePath, {
      destination: dest,
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid skill manifest|missing YAML frontmatter|name is required/);
  });

  it('rejects a file without YAML frontmatter', async () => {
    const sourcePath = join(tmp, 'plain.md');
    writeFileSync(sourcePath, NOT_A_SKILL_FILE, 'utf-8');

    const result = await skillInstall(sourcePath, {
      destination: dest,
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/frontmatter/);
  });

  it('returns an error when the local path does not exist', async () => {
    const result = await skillInstall(join(tmp, 'nope.md'), {
      destination: dest,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });

  it('rejects empty source string', async () => {
    const result = await skillInstall('', { destination: dest, log: () => {} });
    expect(result.ok).toBe(false);
  });
});

describe('skillInstall — URL source (mocked fetch)', () => {
  let dest: string;

  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'crowclaw-skill-dest-'));
  });

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
  });

  it('fetches and installs from an http(s) URL', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      expect(u).toBe('https://example.com/skill.md');
      return new Response(VALID_SKILL_MD, { status: 200, headers: { 'content-type': 'text/markdown' } });
    }) as unknown as typeof fetch;

    const result = await skillInstall('https://example.com/skill.md', {
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
      new Response(JSON.stringify({ markdown: VALID_SKILL_MD }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const result = await skillInstall('https://registry.example/api/skill', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.slug).toBe('hello-world');
  });

  it('resolves agentskills:<slug> against the registry base URL', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      seen.push(u);
      return new Response(VALID_SKILL_MD, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await skillInstall('agentskills:author/hello-world', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(seen[0]).toContain('agentskills.io/api/skills/');
    expect(seen[0]).toContain('hello-world');
  });

  it('reports a fetch failure (non-2xx)', async () => {
    const fetchImpl = (async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;

    const result = await skillInstall('https://example.com/missing.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 404|Failed to fetch/);
  });

  it('rejects fetched content that is not a valid SKILL.md', async () => {
    const fetchImpl = (async () =>
      new Response(NOT_A_SKILL_FILE, { status: 200 })) as unknown as typeof fetch;

    const result = await skillInstall('https://example.com/plain.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/frontmatter/);
  });
});

// --- Runtime endpoint ------------------------------------------------------
// Smoke-test for POST /api/skills/install. The endpoint inlines the same
// install logic (no @crowclaw/cli dep) so we just verify wiring + 400 path.

describe('POST /api/skills/install — runtime endpoint smoke test', () => {
  it('returns 400 when source is missing', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });
    try {
      const res = await runtime.fetch(
        new Request('http://localhost/api/skills/install', {
          method: 'POST',
          body: JSON.stringify({}),
        })
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/source/);
    } finally {
      await runtime.close?.();
    }
  });

  it('returns 400 when source is a path that does not exist', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });
    try {
      const res = await runtime.fetch(
        new Request('http://localhost/api/skills/install', {
          method: 'POST',
          body: JSON.stringify({ source: '/definitely/not/here.md' }),
        })
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
    } finally {
      await runtime.close?.();
    }
  });
});
