import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWorkspaceStore } from '../packages/workspace/src/index.js';

let tempDir: string;
let store: FileWorkspaceStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'file-workspace-test-'));
  store = new FileWorkspaceStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('FileWorkspaceStore', () => {
  describe('read', () => {
    it('reads an actual file from the directory', async () => {
      await writeFile(join(tempDir, 'hello.txt'), 'hello world', 'utf-8');
      const file = await store.read('hello.txt');
      expect(file).not.toBeNull();
      expect(file!.path).toBe('hello.txt');
      expect(file!.content).toBe('hello world');
      expect(file!.updatedAt).toBeTruthy();
    });

    it('returns null for non-existent file', async () => {
      const file = await store.read('missing.txt');
      expect(file).toBeNull();
    });
  });

  describe('write', () => {
    it('creates a file and verifies with fs.readFile', async () => {
      const result = await store.write('output.txt', 'file content');
      expect(result.path).toBe('output.txt');
      expect(result.content).toBe('file content');

      const onDisk = await readFile(join(tempDir, 'output.txt'), 'utf-8');
      expect(onDisk).toBe('file content');
    });

    it('creates nested directories automatically', async () => {
      const result = await store.write('a/b/c/deep.txt', 'nested');
      expect(result.content).toBe('nested');

      const onDisk = await readFile(join(tempDir, 'a/b/c/deep.txt'), 'utf-8');
      expect(onDisk).toBe('nested');
    });
  });

  describe('list', () => {
    it('lists files and directories recursively', async () => {
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(join(tempDir, 'root.txt'), 'root', 'utf-8');
      await writeFile(join(tempDir, 'src/app.ts'), 'app code', 'utf-8');

      const files = await store.list();
      const paths = files.map((f) => f.path);
      expect(paths).toContain('root.txt');
      expect(paths).toContain('src/app.ts');
    });

    it('lists files under a prefix/subdirectory', async () => {
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await mkdir(join(tempDir, 'docs'), { recursive: true });
      await writeFile(join(tempDir, 'src/app.ts'), 'app', 'utf-8');
      await writeFile(join(tempDir, 'docs/readme.md'), 'docs', 'utf-8');

      const files = await store.list('src');
      const paths = files.map((f) => f.path);
      expect(paths).toContain('src/app.ts');
      expect(paths).not.toContain('docs/readme.md');
    });
  });

  describe('exists', () => {
    it('returns true for existing file', async () => {
      await writeFile(join(tempDir, 'exists.txt'), 'yes', 'utf-8');
      expect(await store.exists('exists.txt')).toBe(true);
    });

    it('returns false for non-existent file', async () => {
      expect(await store.exists('nope.txt')).toBe(false);
    });
  });

  describe('remove', () => {
    it('removes a file', async () => {
      await writeFile(join(tempDir, 'doomed.txt'), 'bye', 'utf-8');
      expect(await store.remove('doomed.txt')).toBe(true);
      expect(await store.exists('doomed.txt')).toBe(false);
    });

    it('returns false for non-existent file', async () => {
      expect(await store.remove('ghost.txt')).toBe(false);
    });

    it('refuses to delete a directory', async () => {
      await mkdir(join(tempDir, 'somedir'), { recursive: true });
      expect(await store.remove('somedir')).toBe(false);
    });
  });

  describe('search', () => {
    it('finds text in files and returns line numbers', async () => {
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(join(tempDir, 'src/app.ts'), 'line one\nfind me here\nline three', 'utf-8');
      await writeFile(join(tempDir, 'src/lib.ts'), 'nothing interesting', 'utf-8');

      const results = await store.search('find me');
      expect(results.length).toBe(1);
      expect(results[0].path).toBe('src/app.ts');
      expect(results[0].line).toBe(2);
      expect(results[0].content).toContain('find me here');
    });

    it('skips binary files', async () => {
      await writeFile(join(tempDir, 'text.txt'), 'searchable text', 'utf-8');
      // Write a file with null bytes to simulate a binary
      const binaryContent = Buffer.alloc(100);
      binaryContent.write('searchable text');
      binaryContent[50] = 0; // null byte
      await writeFile(join(tempDir, 'binary.bin'), binaryContent);

      const results = await store.search('searchable');
      const paths = results.map((r) => r.path);
      expect(paths).toContain('text.txt');
      expect(paths).not.toContain('binary.bin');
    });

    it('respects ignorePatterns', async () => {
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await mkdir(join(tempDir, 'node_modules/pkg'), { recursive: true });
      await writeFile(join(tempDir, 'src/app.ts'), 'findable', 'utf-8');
      await writeFile(join(tempDir, 'node_modules/pkg/index.js'), 'findable', 'utf-8');

      const results = await store.search('findable');
      const paths = results.map((r) => r.path);
      expect(paths).toContain('src/app.ts');
      expect(paths).not.toContain('node_modules/pkg/index.js');
    });

    it('limits results to 50 matches', async () => {
      // Create 60 files each with a match
      await mkdir(join(tempDir, 'bulk'), { recursive: true });
      for (let i = 0; i < 60; i++) {
        await writeFile(join(tempDir, `bulk/file${i}.txt`), 'match_target', 'utf-8');
      }

      const results = await store.search('match_target');
      expect(results.length).toBeLessThanOrEqual(50);
    });
  });

  describe('rename', () => {
    it('moves a file from old path to new path', async () => {
      await writeFile(join(tempDir, 'old.txt'), 'content', 'utf-8');
      const result = await store.rename('old.txt', 'new.txt');
      expect(result).not.toBeNull();
      expect(result!.path).toBe('new.txt');
      expect(result!.content).toBe('content');

      expect(await store.exists('old.txt')).toBe(false);
      expect(await store.exists('new.txt')).toBe(true);
    });

    it('creates parent directories for target', async () => {
      await writeFile(join(tempDir, 'flat.txt'), 'data', 'utf-8');
      const result = await store.rename('flat.txt', 'deep/nested/file.txt');
      expect(result).not.toBeNull();
      expect(result!.content).toBe('data');
    });

    it('returns null for non-existent source', async () => {
      const result = await store.rename('ghost.txt', 'new.txt');
      expect(result).toBeNull();
    });
  });

  describe('patchLines', () => {
    it('replaces specific lines in a file', async () => {
      await writeFile(join(tempDir, 'lines.txt'), 'alpha\nbeta\ngamma', 'utf-8');
      const result = await store.patchLines('lines.txt', [{ line: 2, value: 'BETA' }]);
      expect(result.content).toBe('alpha\nBETA\ngamma');

      const onDisk = await readFile(join(tempDir, 'lines.txt'), 'utf-8');
      expect(onDisk).toBe('alpha\nBETA\ngamma');
    });

    it('creates file if it does not exist', async () => {
      const result = await store.patchLines('new.txt', [{ line: 1, value: 'first line' }]);
      expect(result.content).toBe('first line');
    });
  });

  describe('patchText', () => {
    it('replaces text occurrences in a file', async () => {
      await writeFile(join(tempDir, 'text.txt'), 'hello old world', 'utf-8');
      const result = await store.patchText('text.txt', [
        { from: 'old', to: 'new' },
        { from: 'hello', to: 'hi' },
      ]);
      expect(result.content).toBe('hi new world');

      const onDisk = await readFile(join(tempDir, 'text.txt'), 'utf-8');
      expect(onDisk).toBe('hi new world');
    });

    it('creates file if it does not exist', async () => {
      const result = await store.patchText('new.txt', [{ from: 'placeholder', to: 'replaced' }]);
      // File starts empty, so no replacements match — content stays empty
      expect(result.content).toBe('');
      expect(await store.exists('new.txt')).toBe(true);
    });
  });

  describe('security', () => {
    it('blocks path traversal with ..', async () => {
      await expect(store.read('../../../etc/passwd')).rejects.toThrow('Path traversal blocked');
    });

    it('blocks path traversal on write', async () => {
      await expect(store.write('../escape.txt', 'bad')).rejects.toThrow('Path traversal blocked');
    });

    it('blocks path traversal on exists', async () => {
      await expect(store.exists('../../../etc/passwd')).rejects.toThrow('Path traversal blocked');
    });

    it('blocks path traversal on remove', async () => {
      await expect(store.remove('../escape.txt')).rejects.toThrow('Path traversal blocked');
    });

    it('blocks path traversal on rename (source)', async () => {
      await expect(store.rename('../escape.txt', 'safe.txt')).rejects.toThrow('Path traversal blocked');
    });

    it('blocks path traversal on rename (target)', async () => {
      await writeFile(join(tempDir, 'source.txt'), 'data', 'utf-8');
      await expect(store.rename('source.txt', '../escape.txt')).rejects.toThrow('Path traversal blocked');
    });

    it('enforces maxFileSize', async () => {
      const small = new FileWorkspaceStore(tempDir, { maxFileSize: 10 });
      await expect(small.write('big.txt', 'a'.repeat(20))).rejects.toThrow('exceeds max');
    });

    it('ignores .env files in list', async () => {
      await writeFile(join(tempDir, '.env'), 'SECRET=key', 'utf-8');
      await writeFile(join(tempDir, '.env.local'), 'SECRET=local', 'utf-8');
      await writeFile(join(tempDir, 'app.ts'), 'code', 'utf-8');

      const files = await store.list();
      const paths = files.map((f) => f.path);
      expect(paths).toContain('app.ts');
      expect(paths).not.toContain('.env');
      expect(paths).not.toContain('.env.local');
    });

    it('ignores .env files in search', async () => {
      await writeFile(join(tempDir, '.env'), 'SECRET=findme', 'utf-8');
      await writeFile(join(tempDir, 'app.ts'), 'findme in code', 'utf-8');

      const results = await store.search('findme');
      const paths = results.map((r) => r.path);
      expect(paths).toContain('app.ts');
      expect(paths).not.toContain('.env');
    });

    it('ignores .git directory in list', async () => {
      await mkdir(join(tempDir, '.git/objects'), { recursive: true });
      await writeFile(join(tempDir, '.git/HEAD'), 'ref: refs/heads/main', 'utf-8');
      await writeFile(join(tempDir, 'app.ts'), 'code', 'utf-8');

      const files = await store.list();
      const paths = files.map((f) => f.path);
      expect(paths).toContain('app.ts');
      expect(paths.some((p) => p.startsWith('.git'))).toBe(false);
    });

    it('enforces allowedExtensions on write', async () => {
      const restricted = new FileWorkspaceStore(tempDir, { allowedExtensions: ['.ts', '.js'] });
      await expect(restricted.write('data.json', '{}')).rejects.toThrow('Extension not allowed');
      // Allowed extension should work
      const result = await restricted.write('app.ts', 'code');
      expect(result.content).toBe('code');
    });
  });
});
