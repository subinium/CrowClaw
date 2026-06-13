/**
 * v0.9.1 (#298/#333 debt-closure): `crowclaw skills install <url>` now routes
 * its SSRF preflight through the central `assertSafeUrl({ kind: 'fetch' })`
 * choke point in `@crowclaw/tools` instead of the local `validateFetchUrl`
 * primitive.
 *
 * These tests prove that:
 *   - cloud-metadata and private-network skill URLs are rejected, and
 *   - the structured *central forensic code* (`SSRF_CLOUD_METADATA` /
 *     `SSRF_PRIVATE_NETWORK` / `SSRF_INVALID_URL`) is surfaced in the install
 *     error, while the top-level `code` stays `'SSRF'` (the stable contract
 *     `skillsInstallFromUrl` already exposes).
 *   - the manifest sha256 + BUNDLED_SKILL_SLUGS guards still run after a URL
 *     passes the SSRF gate (the swap did not regress them).
 *
 * Distinct from `skills-install-url.test.ts` (which asserts only the coarse
 * `code: 'SSRF'`): here we pin the forensic code so a future refactor that
 * drops back to a non-forensic guard fails loudly.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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

/**
 * A fetch impl that explodes if it is ever called. Every SSRF-rejected URL
 * must be blocked *before* any network call, so reaching this is a test
 * failure (an SSRF bypass).
 */
const explodingFetch = (async () => {
  throw new Error('fetch must not run for an SSRF-rejected URL');
}) as unknown as typeof fetch;

describe('skillsInstallFromUrl SSRF — central assertSafeUrl forensic codes (#298/#333)', () => {
  let dest: string;

  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'crowclaw-skills-ssrf-'));
  });

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
  });

  it('rejects the AWS/GCP cloud-metadata IP with SSRF_CLOUD_METADATA', async () => {
    const result = await skillsInstallFromUrl('http://169.254.169.254/latest/meta-data/', {
      destination: dest,
      fetchImpl: explodingFetch,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF');
    expect(result.error).toContain('SSRF_CLOUD_METADATA');
    // No file should have been written.
    expect(result.destinationPath).toBeUndefined();
  });

  it('rejects the GCP metadata DNS host with SSRF_CLOUD_METADATA', async () => {
    const result = await skillsInstallFromUrl(
      'http://metadata.google.internal/computeMetadata/v1/',
      {
        destination: dest,
        fetchImpl: explodingFetch,
        log: () => {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF');
    expect(result.error).toContain('SSRF_CLOUD_METADATA');
  });

  it('rejects a private-network (RFC1918) host with SSRF_PRIVATE_NETWORK', async () => {
    const result = await skillsInstallFromUrl('http://10.0.0.5/skill.md', {
      destination: dest,
      fetchImpl: explodingFetch,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF');
    expect(result.error).toContain('SSRF_PRIVATE_NETWORK');
  });

  it('rejects loopback (127.0.0.1) with SSRF_PRIVATE_NETWORK', async () => {
    const result = await skillsInstallFromUrl('http://127.0.0.1/skill.md', {
      destination: dest,
      fetchImpl: explodingFetch,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF');
    expect(result.error).toContain('SSRF_PRIVATE_NETWORK');
  });

  it('rejects a non-http(s) scheme before reaching the central guard', async () => {
    // file:// is caught by the explicit scheme reject in fetchSource (which
    // also throws an SSRF:-prefixed error), so the top-level code is SSRF.
    const result = await skillsInstallFromUrl('file:///etc/passwd', {
      destination: dest,
      fetchImpl: explodingFetch,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF');
  });

  it('does not write a destination file when an SSRF URL is rejected', async () => {
    const result = await skillsInstallFromUrl('http://192.168.1.1/skill.md', {
      destination: dest,
      fetchImpl: explodingFetch,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF');
    // The installed dir must remain empty — nothing leaked past the gate.
    const installed = join(dest, 'hello-world.md');
    expect(existsSync(installed)).toBe(false);
  });

  it('re-validates a redirect Location through the central guard', async () => {
    // First hop is a public *IP literal* (skips DNS — keeps the test
    // network-free) that returns a 302 pointing at the metadata service. The
    // redirect target must be re-checked and rejected with the central
    // forensic code; fetch is only allowed for the first hop.
    const firstHop = 'http://93.184.216.34/skill.md';
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      calls += 1;
      const u =
        typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (calls === 1) {
        expect(u).toBe(firstHop);
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      throw new Error('redirect target must not be fetched');
    }) as unknown as typeof fetch;

    const result = await skillsInstallFromUrl(firstHop, {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF');
    expect(result.error).toContain('SSRF_CLOUD_METADATA');
    expect(result.error).toContain('redirect target');
    // The first hop fetched once; the second (metadata) hop never ran.
    expect(calls).toBe(1);
  });

  it('still enforces the sha256 manifest guard after a URL passes the SSRF gate', async () => {
    const wrongHash = 'sha256:' + '0'.repeat(64);
    const skillWithBadHash = `---
name: hashed-ssrf
description: tests hash validation post-SSRF
version: 1.0.0
triggers:
  - test
content_hash: ${wrongHash}
---

# Hashed

1. step
`;
    const fetchImpl = (async () =>
      new Response(skillWithBadHash, { status: 200 })) as unknown as typeof fetch;
    // Public IP literal skips DNS so the SSRF gate passes without a network
    // lookup, letting us reach the downstream sha256 check.
    const result = await skillsInstallFromUrl('https://93.184.216.34/hash.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SHA256');
    expect(result.error).toMatch(/content_hash mismatch/);
  });

  it('still refuses bundled slugs after a URL passes the SSRF gate', async () => {
    const [firstBundled] = [...BUNDLED_SKILL_SLUGS];
    expect(firstBundled).toBeDefined();
    const skill = VALID_SKILL.replace('name: hello-world', `name: ${firstBundled}`);
    const fetchImpl = (async () =>
      new Response(skill, { status: 200 })) as unknown as typeof fetch;
    const result = await skillsInstallFromUrl('https://93.184.216.34/bundled.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BUNDLED');
  });

  it('allows a public URL through the central guard (positive control)', async () => {
    const fetchImpl = (async () =>
      new Response(VALID_SKILL, { status: 200 })) as unknown as typeof fetch;
    // Public IP literal so the positive control stays network-free (no DNS).
    const result = await skillsInstallFromUrl('https://93.184.216.34/skill.md', {
      destination: dest,
      fetchImpl,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.slug).toBe('hello-world');
    expect(existsSync(result.destinationPath!)).toBe(true);
  });
});
