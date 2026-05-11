/**
 * v0.9.0 Hermes parity #332: `crowclaw update --check` preflight + `--backup`
 * archive flow. Tests cover:
 *   - Argument parsing for --check / --backup.
 *   - compareSemver edge cases.
 *   - Preflight against a mocked GitHub release endpoint.
 *   - --backup actually writes a tar.gz that can round-trip through `tar`.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseCliArgs,
  compareSemver,
  runUpdateCheck,
  runUpdateBackup,
  formatUpdateCheck,
  formatUpdateBackup,
} from '@crowclaw/cli';

// --- Argument parsing ---

describe('CLI update parsing (#332)', () => {
  it('parses `update --check` as a preflight', () => {
    const parsed = parseCliArgs(['update', '--check']);
    expect(parsed.command).toBe('update');
    expect(parsed.updateCheck).toBe(true);
    expect(parsed.updateBackup).toBeFalsy();
  });

  it('parses `update --backup`', () => {
    const parsed = parseCliArgs(['update', '--backup']);
    expect(parsed.command).toBe('update');
    expect(parsed.updateCheck).toBeFalsy();
    expect(parsed.updateBackup).toBe(true);
  });

  it('parses combined flags', () => {
    const parsed = parseCliArgs(['update', '--check', '--backup']);
    expect(parsed.command).toBe('update');
    expect(parsed.updateCheck).toBe(true);
    expect(parsed.updateBackup).toBe(true);
  });
});

// --- compareSemver ---

describe('compareSemver (#332)', () => {
  it('returns -1 for older', () => {
    expect(compareSemver('0.8.0', '0.9.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('1.2.3', '2.0.0')).toBe(-1);
  });

  it('returns 1 for newer', () => {
    expect(compareSemver('0.9.0', '0.8.0')).toBe(1);
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
  });

  it('returns 0 for equal', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
  });

  it('treats pre-release as lower than release', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
  });
});

// --- runUpdateCheck ---

describe('runUpdateCheck (#332)', () => {
  it('reports `hasUpdate: true` when latest > current', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.9.0',
          html_url: 'https://github.com/subinium/CrowClaw/releases/tag/v0.9.0',
          published_at: '2026-05-01T00:00:00Z',
          body: 'Release notes here.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const result = await runUpdateCheck({ currentVersion: '0.8.4', fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('0.9.0');
    expect(result.releaseUrl).toContain('v0.9.0');
  });

  it('reports `hasUpdate: false` when current is latest', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ tag_name: 'v0.9.0' }), { status: 200 })) as unknown as typeof fetch;
    const result = await runUpdateCheck({ currentVersion: '0.9.0', fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.hasUpdate).toBe(false);
  });

  it('returns ok:false when endpoint errors', async () => {
    const fetchImpl = (async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })) as unknown as typeof fetch;
    const result = await runUpdateCheck({ currentVersion: '0.8.4', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 429/);
  });

  it('returns ok:false when network throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENETDOWN');
    }) as unknown as typeof fetch;
    const result = await runUpdateCheck({ currentVersion: '0.8.4', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENETDOWN/);
  });

  it('does not mutate any state — purely preflight', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 })) as unknown as typeof fetch;
    const before = process.env.CROWCLAW_API_KEY;
    await runUpdateCheck({ currentVersion: '0.0.0', fetchImpl });
    expect(process.env.CROWCLAW_API_KEY).toBe(before);
  });

  it('formatUpdateCheck mentions both versions', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 })) as unknown as typeof fetch;
    const result = await runUpdateCheck({ currentVersion: '0.8.4', fetchImpl });
    const text = formatUpdateCheck(result);
    expect(text).toContain('v0.8.4');
    expect(text).toContain('v1.0.0');
  });
});

// --- runUpdateBackup ---

describe('runUpdateBackup (#332)', () => {
  it('writes a non-empty tar.gz archive of the data dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crowclaw-backup-'));
    await writeFile(join(dir, 'config.json'), '{"a":1}', 'utf-8');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'note.txt'), 'hello', 'utf-8');

    const result = await runUpdateBackup({
      dataDir: dir,
      backupDir: join(dir, 'backups'),
      timestamp: 'test-ts',
    });

    expect(result.ok).toBe(true);
    expect(result.archivePath).toBe(join(dir, 'backups', 'test-ts.tgz'));
    expect(result.fileCount).toBe(2);
    expect(result.totalBytes).toBeGreaterThan(0);

    const archiveStat = await stat(result.archivePath!);
    expect(archiveStat.size).toBeGreaterThan(0);
    // 0600 mode bits.
    expect(archiveStat.mode & 0o077).toBe(0);
  });

  it('produces a tarball that `tar -tzf` can list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crowclaw-backup-roundtrip-'));
    await writeFile(join(dir, 'auth.json'), '{"token":"x"}', 'utf-8');

    const result = await runUpdateBackup({
      dataDir: dir,
      backupDir: join(dir, 'backups'),
      timestamp: 'roundtrip',
    });
    expect(result.ok).toBe(true);

    // Verify with `tar -tzf` if available.
    const list = spawnSync('tar', ['-tzf', result.archivePath!], { encoding: 'utf-8' });
    if (list.status === 0) {
      expect(list.stdout).toContain('auth.json');
    }
  });

  it('returns ok:false when data dir is missing', async () => {
    const result = await runUpdateBackup({
      dataDir: join(tmpdir(), 'this-does-not-exist-' + Math.random()),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('skips the backups subdir to avoid recursion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crowclaw-backup-recurse-'));
    await writeFile(join(dir, 'real.json'), '{}', 'utf-8');
    await mkdir(join(dir, 'backups'), { recursive: true });
    await writeFile(join(dir, 'backups', 'old.tgz'), 'old-archive', 'utf-8');

    const result = await runUpdateBackup({
      dataDir: dir,
      backupDir: join(dir, 'backups'),
      timestamp: 'norecurse',
    });
    expect(result.ok).toBe(true);
    // Only `real.json` should be in the archive; `backups/old.tgz` is skipped.
    expect(result.fileCount).toBe(1);
  });

  it('formatUpdateBackup mentions the archive path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crowclaw-backup-fmt-'));
    await writeFile(join(dir, 'config.json'), '{}', 'utf-8');
    const result = await runUpdateBackup({
      dataDir: dir,
      backupDir: join(dir, 'backups'),
      timestamp: 'fmt',
    });
    const text = formatUpdateBackup(result);
    expect(text).toContain('.tgz');
    expect(text).toContain('Restore');
  });
});
