/**
 * Regression tests for `writeSecretAtomic` (Hermes v0.13 parity, #296).
 *
 * Covers:
 *   - happy path: file is created with `0o600` regardless of umask.
 *   - symlink-attack: a pre-existing symlink at the target path causes
 *     the write to FAIL (the symlink is never followed).
 *   - overwrite path: replacing an existing regular file is atomic and
 *     refreshes mode bits.
 *   - world-writable parent guard.
 *   - concurrent writes do not interleave or corrupt the file.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, symlinkSync, writeFileSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSecretAtomic } from '../packages/shared/src/atomic-secret-write.js';

describe('writeSecretAtomic — happy path', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crowclaw-atomic-secret-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a new file with the contents', async () => {
    const target = join(tmp, 'secret.json');
    const payload = JSON.stringify({ token: 'sk-abc123' });

    await writeSecretAtomic(target, payload);

    expect(readFileSync(target, 'utf-8')).toBe(payload);
  });

  it('creates the file with mode 0o600 regardless of umask', async () => {
    const target = join(tmp, 'creds.json');

    // Simulate a permissive umask by setting and immediately restoring
    // it; writeSecretAtomic must still enforce the strict mode bits.
    const previous = process.umask(0);
    try {
      await writeSecretAtomic(target, 'data');
    } finally {
      process.umask(previous);
    }

    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('accepts a Uint8Array payload', async () => {
    const target = join(tmp, 'bytes.bin');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    await writeSecretAtomic(target, bytes);

    const written = readFileSync(target);
    expect(Array.from(written)).toEqual([1, 2, 3, 4, 5]);
  });

  it('respects an explicit mode option', async () => {
    const target = join(tmp, 'rw-only.txt');
    await writeSecretAtomic(target, 'x', { mode: 0o400 });
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o400);
  });
});

describe('writeSecretAtomic — symlink attack regression', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crowclaw-atomic-symlink-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to follow a pre-existing symlink at the target path', async () => {
    const target = join(tmp, 'creds.json');
    const decoy = join(tmp, 'attacker-controlled.txt');

    // Plant: an attacker creates a symlink at the destination path that
    // points to a file they control.
    writeFileSync(decoy, 'attacker-owned content', 'utf-8');
    symlinkSync(decoy, target);

    await expect(writeSecretAtomic(target, 'real-secret-token'))
      .rejects.toThrow();

    // Critical: the attacker-controlled file MUST NOT have been
    // overwritten. The symlink redirected the write nowhere.
    expect(readFileSync(decoy, 'utf-8')).toBe('attacker-owned content');
  });

  it('refuses dangling symlinks at the target', async () => {
    const target = join(tmp, 'creds.json');
    const dangling = join(tmp, 'does-not-exist.txt');
    symlinkSync(dangling, target);

    await expect(writeSecretAtomic(target, 'real-secret-token'))
      .rejects.toThrow();

    // No file should have been created at the dangling target either.
    expect(existsSync(dangling)).toBe(false);
  });
});

describe('writeSecretAtomic — atomic overwrite', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crowclaw-atomic-overwrite-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces an existing regular file atomically', async () => {
    const target = join(tmp, 'tokens.json');
    writeFileSync(target, JSON.stringify({ v: 1 }), { mode: 0o644 });

    await writeSecretAtomic(target, JSON.stringify({ v: 2 }));

    expect(readFileSync(target, 'utf-8')).toBe('{"v":2}');
    // Mode must be re-asserted on overwrite — the previous file had 0o644.
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not leak a leftover .tmp file on success', async () => {
    const target = join(tmp, 'tokens.json');
    writeFileSync(target, 'old', { mode: 0o600 });

    await writeSecretAtomic(target, 'new');

    // Walk the parent dir and confirm no <target>.tmp.* siblings remain.
    const siblings = readdirSync(tmp);
    const tmpSiblings = siblings.filter((name) => name.startsWith('tokens.json.tmp.'));
    expect(tmpSiblings).toEqual([]);
  });
});

describe('writeSecretAtomic — world-writable parent guard', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crowclaw-atomic-world-'));
  });

  afterEach(() => {
    try {
      chmodSync(tmp, 0o700);
    } catch {
      /* ignore — cleanup will catch */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses writes when parent is world-writable', async () => {
    chmodSync(tmp, 0o777);
    const target = join(tmp, 'creds.json');

    await expect(writeSecretAtomic(target, 'secret'))
      .rejects.toThrow(/world-writable/);
  });

  it('permits writes when guard is explicitly disabled (opt-out)', async () => {
    chmodSync(tmp, 0o777);
    const target = join(tmp, 'creds.json');

    await expect(
      writeSecretAtomic(target, 'secret', { rejectWorldWritableParent: false }),
    ).resolves.toBeUndefined();
  });
});

describe('writeSecretAtomic — concurrent writes', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crowclaw-atomic-concurrent-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('serializes concurrent writes so the file always has one writer\'s payload', async () => {
    const target = join(tmp, 'tokens.json');
    // Seed so all writers take the rename path.
    writeFileSync(target, 'seed', { mode: 0o600 });

    const writers = Array.from({ length: 8 }, (_, i) =>
      writeSecretAtomic(target, `payload-${i}`),
    );
    await Promise.all(writers);

    // The final content must be exactly one of the writers' payloads —
    // never a torn/partial mix.
    const final = readFileSync(target, 'utf-8');
    expect(final).toMatch(/^payload-[0-7]$/);
  });
});

