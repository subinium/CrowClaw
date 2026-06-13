/**
 * v0.9.0 Hermes parity #297: TOCTOU-safe credential writers.
 *
 * Verifies:
 *   - `writeSecretAtomic` writes with the requested mode (0600 by default).
 *   - Output file is a regular file (not a symlink) — the temp-then-rename
 *     pattern doesn't follow attacker-placed symlinks.
 *   - `runFixPerms` chmod-fixes credential files with insecure modes.
 *   - `checkSecretPerms` warns on insecure modes without modifying them.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeSecretAtomic,
  runFixPerms,
  checkSecretPerms,
  SECRET_FILE_BASENAMES,
} from '@crowclaw/cli';

describe('writeSecretAtomic (#297)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crowclaw-toctou-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes new files with 0600 by default', async () => {
    const target = join(dir, 'config.json');
    await writeSecretAtomic(target, '{"k":"v"}');
    const stats = statSync(target);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(readFileSync(target, 'utf-8')).toBe('{"k":"v"}');
  });

  it('overwrites existing files atomically and forces mode to 0600', async () => {
    const target = join(dir, 'auth.json');
    // Pre-existing world-readable file.
    writeFileSync(target, 'old', 'utf-8');
    chmodSync(target, 0o644);
    expect(statSync(target).mode & 0o077).not.toBe(0);

    await writeSecretAtomic(target, 'new');
    const stats = statSync(target);
    expect(stats.mode & 0o077).toBe(0);
    expect(readFileSync(target, 'utf-8')).toBe('new');
  });

  it('leaves no .tmp file behind on success', async () => {
    const target = join(dir, 'runtime-config.json');
    await writeSecretAtomic(target, '{}');
    const ls = readdirSync(dir);
    expect(ls.filter((n) => n.includes('.tmp.'))).toHaveLength(0);
  });

  it('rejects a symlinked destination and leaves the victim untouched', async () => {
    // Attacker scenario: `auth.json` is a symlink pointing at a victim file.
    // The canonical @crowclaw/shared writeSecretAtomic (Hermes #296) refuses
    // to write through a symlinked destination — O_NOFOLLOW short-circuits the
    // create, lstat classifies the EEXIST case, and a symlink target is
    // rejected with ELOOP rather than replaced. The victim is never written.
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'original', 'utf-8');
    const target = join(dir, 'auth.json');
    symlinkSync(victim, target);
    // Sanity: pre-write, `target` is a symlink (lstat tells us so).
    expect(lstatSync(target).isSymbolicLink()).toBe(true);

    await expect(writeSecretAtomic(target, 'safe-payload')).rejects.toThrow(/symbolic link|ELOOP/i);

    // Victim untouched — the write never followed the symlink.
    expect(readFileSync(victim, 'utf-8')).toBe('original');
    // Target is still the original symlink (not replaced with a real file).
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('honors custom mode', async () => {
    const target = join(dir, 'special.json');
    await writeSecretAtomic(target, 'x', { mode: 0o640 });
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });
});

describe('runFixPerms (#297)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crowclaw-fixperms-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('chmod-fixes known credential basenames to 0600', async () => {
    const a = join(dir, 'auth.json');
    const c = join(dir, 'config.json');
    writeFileSync(a, '{}', 'utf-8');
    writeFileSync(c, '{}', 'utf-8');
    chmodSync(a, 0o644);
    chmodSync(c, 0o600);

    const result = await runFixPerms({ dataDir: dir });
    expect(result.ok).toBe(true);
    expect(result.fixed).toContain(a);
    expect(result.fixed).not.toContain(c); // already 0600
    expect(statSync(a).mode & 0o077).toBe(0);
  });

  it('returns ok:true with no work when data dir is missing', async () => {
    const result = await runFixPerms({ dataDir: join(dir, 'no-such') });
    expect(result.ok).toBe(true);
    expect(result.fixed).toHaveLength(0);
    expect(result.inspected).toHaveLength(0);
  });

  it('does not touch unrelated files', async () => {
    const a = join(dir, 'auth.json');
    const unrelated = join(dir, 'history');
    writeFileSync(a, '{}', 'utf-8');
    writeFileSync(unrelated, 'logs', 'utf-8');
    chmodSync(a, 0o644);
    chmodSync(unrelated, 0o644);

    await runFixPerms({ dataDir: dir });
    // Unrelated file's mode is preserved.
    expect(statSync(unrelated).mode & 0o077).not.toBe(0);
  });

  it('SECRET_FILE_BASENAMES covers all three credential files', () => {
    expect(SECRET_FILE_BASENAMES.has('auth.json')).toBe(true);
    expect(SECRET_FILE_BASENAMES.has('config.json')).toBe(true);
    expect(SECRET_FILE_BASENAMES.has('runtime-config.json')).toBe(true);
  });
});

describe('checkSecretPerms (#297)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crowclaw-checkperms-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists insecure files without modifying them', async () => {
    const a = join(dir, 'auth.json');
    writeFileSync(a, '{}', 'utf-8');
    chmodSync(a, 0o644);

    const warnings: string[] = [];
    const result = await checkSecretPerms({
      dataDir: dir,
      warn: (line) => warnings.push(line),
    });
    expect(result.insecure).toContain(a);
    // Mode unchanged.
    expect(statSync(a).mode & 0o077).not.toBe(0);
    // Warning was emitted.
    expect(warnings.some((l) => l.includes('credential file'))).toBe(true);
    expect(warnings.some((l) => l.includes('fix-perms'))).toBe(true);
  });

  it('emits no warning when all files are 0600', async () => {
    const a = join(dir, 'auth.json');
    writeFileSync(a, '{}', 'utf-8');
    chmodSync(a, 0o600);
    const warnings: string[] = [];
    const result = await checkSecretPerms({
      dataDir: dir,
      warn: (line) => warnings.push(line),
    });
    expect(result.insecure).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

