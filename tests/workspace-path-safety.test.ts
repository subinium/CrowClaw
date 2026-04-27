import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWorkspaceStore, WorkspacePathEscapeError } from '../packages/workspace/src/index.js';

let tempDir: string;
let outsideDir: string;
let store: FileWorkspaceStore;

beforeEach(async () => {
  // Two sibling temp dirs: one is the workspace root, the other is "outside"
  // — used as a symlink target to simulate a malicious symlink already
  // present in the workspace pointing to host files.
  tempDir = await mkdtemp(join(tmpdir(), 'ws-path-safety-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'ws-path-outside-'));
  store = new FileWorkspaceStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe('FileWorkspaceStore path safety (symlink + atomic write)', () => {
  describe('legitimate operations still work', () => {
    it('reads a regular file inside the workspace', async () => {
      await writeFile(join(tempDir, 'note.txt'), 'inside content', 'utf-8');
      const file = await store.read('note.txt');
      expect(file).not.toBeNull();
      expect(file!.content).toBe('inside content');
    });

    it('writes a regular file inside the workspace and persists to disk', async () => {
      const result = await store.write('out.txt', 'hello');
      expect(result.content).toBe('hello');
      const onDisk = await readFile(join(tempDir, 'out.txt'), 'utf-8');
      expect(onDisk).toBe('hello');
    });

    it('writes nested files via mkdir + atomic rename', async () => {
      const result = await store.write('deep/nested/file.txt', 'nested content');
      expect(result.content).toBe('nested content');
      const onDisk = await readFile(join(tempDir, 'deep/nested/file.txt'), 'utf-8');
      expect(onDisk).toBe('nested content');
    });

    it('overwrites an existing file atomically without leaving tmp artifacts', async () => {
      await store.write('overwrite.txt', 'first');
      await store.write('overwrite.txt', 'second');
      const onDisk = await readFile(join(tempDir, 'overwrite.txt'), 'utf-8');
      expect(onDisk).toBe('second');
      // No leftover tmp files in the directory
      const entries = await readdir(tempDir);
      const tmpFiles = entries.filter((e) => e.includes('.tmp.'));
      expect(tmpFiles).toEqual([]);
    });

    it('follows in-root → in-root symlinks for read', async () => {
      // alias → real.txt — both inside the workspace, perfectly fine.
      await writeFile(join(tempDir, 'real.txt'), 'real data', 'utf-8');
      symlinkSync(join(tempDir, 'real.txt'), join(tempDir, 'alias.txt'));
      const file = await store.read('alias.txt');
      expect(file).not.toBeNull();
      expect(file!.content).toBe('real data');
    });
  });

  describe('blocks symlinks pointing outside root', () => {
    it('throws WorkspacePathEscapeError when reading a symlink → /etc/passwd-like path', async () => {
      // Place a symlink inside the workspace that points to a host file
      // outside the workspace. resolveSafe (lexical) sees it as in-root,
      // but realpath unmasks the escape.
      const outsideFile = join(outsideDir, 'secret.txt');
      await writeFile(outsideFile, 'host secret', 'utf-8');
      symlinkSync(outsideFile, join(tempDir, 'leak.txt'));

      await expect(store.read('leak.txt')).rejects.toThrow(WorkspacePathEscapeError);
      await expect(store.read('leak.txt')).rejects.toThrow('Path traversal blocked');
    });

    it('throws WorkspacePathEscapeError on write when parent dir is a symlink to outside', async () => {
      // <root>/sneak is a symlink to a directory outside the workspace.
      // Writing into <root>/sneak/file.txt would land outside.
      symlinkSync(outsideDir, join(tempDir, 'sneak'));

      await expect(store.write('sneak/file.txt', 'pwned')).rejects.toThrow(WorkspacePathEscapeError);

      // Verify nothing was written into the outside dir.
      const outsideContents = await readdir(outsideDir);
      expect(outsideContents).toEqual([]);
    });

    it('throws on patchLines when the file itself is a symlink to outside', async () => {
      const outsideFile = join(outsideDir, 'host.txt');
      await writeFile(outsideFile, 'host content', 'utf-8');
      symlinkSync(outsideFile, join(tempDir, 'evil.txt'));

      await expect(store.patchLines('evil.txt', [{ line: 1, value: 'overwrite' }])).rejects.toThrow(
        WorkspacePathEscapeError,
      );
      // Host file content must remain untouched.
      const after = await readFile(outsideFile, 'utf-8');
      expect(after).toBe('host content');
    });

    it('throws on patchText when the file itself is a symlink to outside', async () => {
      const outsideFile = join(outsideDir, 'host2.txt');
      await writeFile(outsideFile, 'host data', 'utf-8');
      symlinkSync(outsideFile, join(tempDir, 'evil2.txt'));

      await expect(
        store.patchText('evil2.txt', [{ from: 'host', to: 'pwned' }]),
      ).rejects.toThrow(WorkspacePathEscapeError);
      const after = await readFile(outsideFile, 'utf-8');
      expect(after).toBe('host data');
    });

    it('does not allow lexical ../ traversal (still blocked by resolveSafe)', async () => {
      await expect(store.read('../../../etc/passwd')).rejects.toThrow('Path traversal blocked');
      await expect(store.write('../escape.txt', 'bad')).rejects.toThrow('Path traversal blocked');
    });
  });

  describe('atomic-rename guarantees', () => {
    it('leaves no partial file when the target parent is a symlink to outside', async () => {
      symlinkSync(outsideDir, join(tempDir, 'trap'));

      await expect(store.write('trap/payload.txt', 'should not land')).rejects.toThrow(
        WorkspacePathEscapeError,
      );

      // No file in the outside dir, no tmp files in the workspace either.
      const outsideContents = await readdir(outsideDir);
      expect(outsideContents).toEqual([]);
    });

    it('cleans up the temp file when the post-write validation fails', async () => {
      // We can't easily stage a TOCTOU swap in a unit test (race window
      // between mkdir and rename), but we can at least assert that after
      // a failed write, the workspace contains no `.tmp.` artifacts.
      symlinkSync(outsideDir, join(tempDir, 'tocrace'));
      try {
        await store.write('tocrace/x.txt', 'data');
      } catch {
        // expected
      }
      const entries = await readdir(tempDir);
      const tmpEntries = entries.filter((e) => e.includes('.tmp.'));
      expect(tmpEntries).toEqual([]);
    });

    it('overwriting an existing in-root symlink replaces it without writing through the link', async () => {
      // <root>/aliased → <root>/realfile.txt. Writing to "aliased" should
      // produce an in-root regular file at <root>/aliased and leave the
      // original target file untouched (because rename replaces the
      // symlink atomically rather than following it).
      await writeFile(join(tempDir, 'realfile.txt'), 'untouched', 'utf-8');
      symlinkSync(join(tempDir, 'realfile.txt'), join(tempDir, 'aliased'));

      const result = await store.write('aliased', 'new content');
      expect(result.content).toBe('new content');

      // The original file the symlink pointed at must NOT have been overwritten.
      const original = await readFile(join(tempDir, 'realfile.txt'), 'utf-8');
      expect(original).toBe('untouched');
      // And `aliased` is now a real file with the new content.
      const aliased = await readFile(join(tempDir, 'aliased'), 'utf-8');
      expect(aliased).toBe('new content');
    });
  });

  describe('WorkspacePathEscapeError', () => {
    it('is an Error with a clear message and the attempted path', async () => {
      const outsideFile = join(outsideDir, 'x.txt');
      await writeFile(outsideFile, 'x', 'utf-8');
      symlinkSync(outsideFile, join(tempDir, 'lk.txt'));

      let caught: unknown = null;
      try {
        await store.read('lk.txt');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkspacePathEscapeError);
      expect(caught).toBeInstanceOf(Error);
      const e = caught as WorkspacePathEscapeError;
      expect(e.attemptedPath).toBe('lk.txt');
      expect(e.resolvedPath).toContain(outsideDir);
      expect(e.message).toContain('Path traversal blocked');
    });
  });

  describe('sanity: outsideDir was set up correctly', () => {
    it('outsideDir exists and is distinct from tempDir', () => {
      expect(existsSync(outsideDir)).toBe(true);
      expect(existsSync(tempDir)).toBe(true);
      expect(outsideDir).not.toBe(tempDir);
    });
  });
});
