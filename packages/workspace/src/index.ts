import { readFile, writeFile, readdir, access, unlink, rename as fsRename, mkdir, stat } from 'node:fs/promises';
import { resolve, relative, dirname, extname, isAbsolute } from 'node:path';

export interface WorkspaceFile {
  path: string;
  content: string;
  updatedAt: string;
}

export interface WorkspaceStore {
  read(path: string): Promise<WorkspaceFile | null>;
  write(path: string, content: string): Promise<WorkspaceFile>;
  list(prefix?: string): Promise<WorkspaceFile[]>;
  patchLines(path: string, patches: Array<{ line: number; value: string }>): Promise<WorkspaceFile>;
  patchText(path: string, replacements: Array<{ from: string; to: string }>): Promise<WorkspaceFile>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  rename(fromPath: string, toPath: string): Promise<WorkspaceFile | null>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface FileWorkspaceStoreOptions {
  allowedExtensions?: string[];
  maxFileSize?: number;
  ignorePatterns?: string[];
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_IGNORE_PATTERNS = ['node_modules', '.git', '.env', '.env.*', '*.pem', '*.key'];
const MAX_SEARCH_MATCHES = 50;

function matchesIgnorePattern(segment: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) {
      // Extension glob: *.pem matches files ending with .pem
      const ext = pattern.slice(1); // '.pem'
      if (segment.endsWith(ext)) return true;
    } else if (pattern.endsWith('.*')) {
      // Prefix glob: .env.* matches .env.local, .env.production, etc.
      const prefix = pattern.slice(0, -2); // '.env'
      if (segment.startsWith(prefix + '.')) return true;
    } else {
      // Exact match
      if (segment === pattern) return true;
    }
  }
  return false;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 512);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export class FileWorkspaceStore implements WorkspaceStore {
  private readonly rootDir: string;
  private readonly allowedExtensions: string[] | undefined;
  private readonly maxFileSize: number;
  private readonly ignorePatterns: string[];

  constructor(rootDir: string, options?: FileWorkspaceStoreOptions) {
    this.rootDir = resolve(rootDir);
    this.allowedExtensions = options?.allowedExtensions;
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.ignorePatterns = options?.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
  }

  private resolveSafe(filePath: string): string {
    const resolved = resolve(this.rootDir, filePath);
    // Cross-platform containment check: on Windows, `resolve` returns
    // backslash-separated paths (`C:\workspace\...`), so `startsWith(rootDir + '/')`
    // returned false even for legitimate in-root paths — and conversely, could
    // miss `..\..\etc\passwd` style traversals because the pre-v0.4.1 check
    // compared with `/` only. `relative()` is platform-aware: a legitimate
    // in-root path returns "" or a subpath; a traversal returns "..", and an
    // absolute path on a different drive returns a rooted string.
    const rel = relative(this.rootDir, resolved);
    const isInRoot = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (!isInRoot) {
      throw new Error(`Path traversal blocked: ${filePath}`);
    }
    return resolved;
  }

  private isIgnored(filePath: string): boolean {
    const parts = filePath.split('/');
    return parts.some((part) => matchesIgnorePattern(part, this.ignorePatterns));
  }

  private checkExtension(filePath: string): void {
    if (!this.allowedExtensions) return;
    const ext = extname(filePath);
    if (!this.allowedExtensions.includes(ext)) {
      throw new Error(`Extension not allowed: ${ext}`);
    }
  }

  async read(path: string): Promise<WorkspaceFile | null> {
    try {
      const abs = this.resolveSafe(path);
      const content = await readFile(abs, 'utf-8');
      const stats = await stat(abs);
      return { path, content, updatedAt: stats.mtime.toISOString() };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Path traversal')) throw error;
      return null;
    }
  }

  async write(path: string, content: string): Promise<WorkspaceFile> {
    const abs = this.resolveSafe(path);
    this.checkExtension(path);
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > this.maxFileSize) {
      throw new Error(`File size ${bytes} exceeds max ${this.maxFileSize} bytes`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
    const stats = await stat(abs);
    return { path, content, updatedAt: stats.mtime.toISOString() };
  }

  async list(prefix = ''): Promise<WorkspaceFile[]> {
    const results: WorkspaceFile[] = [];
    const targetDir = this.resolveSafe(prefix || '.');

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matchesIgnorePattern(entry.name, this.ignorePatterns)) continue;
        const absPath = resolve(dir, entry.name);
        const relPath = relative(this.rootDir, absPath);
        if (entry.isDirectory()) {
          await walk(absPath);
        } else if (entry.isFile()) {
          try {
            const content = await readFile(absPath, 'utf-8');
            const stats = await stat(absPath);
            results.push({ path: relPath, content, updatedAt: stats.mtime.toISOString() });
          } catch {
            // Skip unreadable files
          }
        }
      }
    };

    await walk(targetDir);
    return results;
  }

  async patchLines(path: string, patches: Array<{ line: number; value: string }>): Promise<WorkspaceFile> {
    const abs = this.resolveSafe(path);
    let content = '';
    try {
      content = await readFile(abs, 'utf-8');
    } catch {
      // Start from empty if file doesn't exist
    }
    const lines = content.split('\n');
    for (const patch of patches) {
      const index = patch.line - 1;
      if (index < 0) continue;
      while (index >= lines.length) {
        lines.push('');
      }
      lines[index] = patch.value;
    }
    const newContent = lines.join('\n');
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, newContent, 'utf-8');
    const stats = await stat(abs);
    return { path, content: newContent, updatedAt: stats.mtime.toISOString() };
  }

  async patchText(path: string, replacements: Array<{ from: string; to: string }>): Promise<WorkspaceFile> {
    const abs = this.resolveSafe(path);
    let content = '';
    try {
      content = await readFile(abs, 'utf-8');
    } catch {
      // Start from empty if file doesn't exist
    }
    for (const replacement of replacements) {
      content = content.split(replacement.from).join(replacement.to);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
    const stats = await stat(abs);
    return { path, content, updatedAt: stats.mtime.toISOString() };
  }

  async exists(path: string): Promise<boolean> {
    try {
      const abs = this.resolveSafe(path);
      await access(abs);
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Path traversal')) throw error;
      return false;
    }
  }

  async remove(path: string): Promise<boolean> {
    try {
      const abs = this.resolveSafe(path);
      const stats = await stat(abs);
      if (!stats.isFile()) return false;
      await unlink(abs);
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Path traversal')) throw error;
      return false;
    }
  }

  async rename(fromPath: string, toPath: string): Promise<WorkspaceFile | null> {
    try {
      const absFrom = this.resolveSafe(fromPath);
      const absTo = this.resolveSafe(toPath);
      await mkdir(dirname(absTo), { recursive: true });
      await fsRename(absFrom, absTo);
      const content = await readFile(absTo, 'utf-8');
      const stats = await stat(absTo);
      return { path: toPath, content, updatedAt: stats.mtime.toISOString() };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Path traversal')) throw error;
      return null;
    }
  }

  /**
   * Walk and search file contents for a query string or regex.
   * Returns matches with file paths and line numbers, skipping binary files and ignored paths.
   */
  async search(query: string, dir?: string): Promise<Array<{ path: string; line: number; content: string }>> {
    const results: Array<{ path: string; line: number; content: string }> = [];
    const targetDir = this.resolveSafe(dir || '.');
    const lowered = query.toLowerCase();

    const walk = async (currentDir: string): Promise<void> => {
      if (results.length >= MAX_SEARCH_MATCHES) return;
      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= MAX_SEARCH_MATCHES) return;
        if (matchesIgnorePattern(entry.name, this.ignorePatterns)) continue;
        const absPath = resolve(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(absPath);
        } else if (entry.isFile()) {
          try {
            const buffer = await readFile(absPath);
            if (isBinaryBuffer(buffer)) continue;
            const text = buffer.toString('utf-8');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= MAX_SEARCH_MATCHES) break;
              if (lines[i].toLowerCase().includes(lowered)) {
                results.push({
                  path: relative(this.rootDir, absPath),
                  line: i + 1,
                  content: lines[i],
                });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    };

    await walk(targetDir);
    return results;
  }
}

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly files = new Map<string, WorkspaceFile>();

  async read(path: string): Promise<WorkspaceFile | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<WorkspaceFile> {
    const file = { path, content, updatedAt: nowIso() } satisfies WorkspaceFile;
    this.files.set(path, file);
    return file;
  }

  async list(prefix = ''): Promise<WorkspaceFile[]> {
    return [...this.files.values()].filter((file) => file.path.startsWith(prefix));
  }

  async patchLines(path: string, patches: Array<{ line: number; value: string }>): Promise<WorkspaceFile> {
    const current = this.files.get(path) ?? { path, content: '', updatedAt: nowIso() };
    const lines = current.content.split('\n');
    for (const patch of patches) {
      const index = patch.line - 1;
      if (index < 0) continue;
      while (index >= lines.length) {
        lines.push('');
      }
      lines[index] = patch.value;
    }
    const next = { path, content: lines.join('\n'), updatedAt: nowIso() } satisfies WorkspaceFile;
    this.files.set(path, next);
    return next;
  }

  async patchText(path: string, replacements: Array<{ from: string; to: string }>): Promise<WorkspaceFile> {
    const current = this.files.get(path) ?? { path, content: '', updatedAt: nowIso() };
    let nextContent = current.content;
    for (const replacement of replacements) {
      nextContent = nextContent.split(replacement.from).join(replacement.to);
    }
    const next = { path, content: nextContent, updatedAt: nowIso() } satisfies WorkspaceFile;
    this.files.set(path, next);
    return next;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async remove(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async rename(fromPath: string, toPath: string): Promise<WorkspaceFile | null> {
    const current = this.files.get(fromPath);
    if (!current) {
      return null;
    }

    this.files.delete(fromPath);
    const next = { path: toPath, content: current.content, updatedAt: nowIso() } satisfies WorkspaceFile;
    this.files.set(toPath, next);
    return next;
  }
}
