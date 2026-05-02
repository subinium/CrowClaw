import {
  readFile,
  writeFile,
  readdir,
  access,
  unlink,
  rename as fsRename,
  mkdir,
  stat,
  realpath,
  open as fsOpen,
} from 'node:fs/promises';
import { resolve, relative, dirname, extname, isAbsolute, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

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

/**
 * Thrown when a workspace path resolves (after realpath / symlink expansion)
 * to a location outside the configured rootDir. Message includes
 * "Path traversal blocked" so prior callers / tests matching that substring
 * continue to work.
 */
export class WorkspacePathEscapeError extends Error {
  readonly attemptedPath: string;
  readonly resolvedPath: string;

  constructor(attemptedPath: string, resolvedPath: string) {
    super(`Path traversal blocked: ${attemptedPath} resolves to ${resolvedPath} outside workspace root`);
    this.name = 'WorkspacePathEscapeError';
    this.attemptedPath = attemptedPath;
    this.resolvedPath = resolvedPath;
  }
}

/**
 * Resolve `p` under `rootReal`, expanding symlinks via realpath on the
 * deepest existing ancestor. Returns the canonical absolute path even if
 * the file does not yet exist. Throws WorkspacePathEscapeError if the
 * canonical result is outside `rootReal`.
 */
async function realpathOrAncestor(rootReal: string, attempted: string, target: string): Promise<string> {
  // Walk upward until we find an existing path; realpath that, then
  // re-append the trailing components.
  const trailing: string[] = [];
  let current = target;
  // Guard: bail out if we walk above filesystem root.
  while (true) {
    try {
      const real = await realpath(current);
      const canonical = trailing.length === 0 ? real : resolve(real, ...trailing);
      const rel = relative(rootReal, canonical);
      const inRoot = rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
      if (!inRoot) {
        throw new WorkspacePathEscapeError(attempted, canonical);
      }
      return canonical;
    } catch (err: unknown) {
      if (err instanceof WorkspacePathEscapeError) throw err;
      // ENOENT (or similar): walk up
      const parent = dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding an existing ancestor.
        throw new WorkspacePathEscapeError(attempted, target);
      }
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

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
  private rootRealCache: string | null = null;

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
      throw new WorkspacePathEscapeError(filePath, resolved);
    }
    return resolved;
  }

  /**
   * Lazily resolves and caches the realpath of `rootDir`. The rootDir itself
   * is trusted (operator-supplied), but we need its canonical form for
   * containment checks against realpath'd children.
   */
  private async getRootReal(): Promise<string> {
    if (this.rootRealCache !== null) return this.rootRealCache;
    try {
      this.rootRealCache = await realpath(this.rootDir);
    } catch {
      // rootDir might not exist yet (rare). Fall back to lexical resolve.
      this.rootRealCache = this.rootDir;
    }
    return this.rootRealCache;
  }

  /**
   * Resolve a workspace-relative path to an absolute path, expanding
   * symlinks via realpath. If the file does not yet exist, walks up to
   * the deepest existing ancestor for realpath, then re-appends the
   * trailing components. Throws WorkspacePathEscapeError if the canonical
   * path is outside rootDir.
   *
   * This is the security-critical resolver used for read/write/patch
   * operations — it defends against in-workspace symlinks pointing
   * outside the workspace (e.g. a symlink at `notes/passwd → /etc/passwd`
   * placed by an attacker before the agent runs).
   */
  private async resolveSafeWithRealpath(filePath: string): Promise<string> {
    // First-pass lexical check. Cheap, fails fast on `../etc/passwd` style.
    const resolved = this.resolveSafe(filePath);
    const rootReal = await this.getRootReal();
    return realpathOrAncestor(rootReal, filePath, resolved);
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
    let abs: string;
    try {
      abs = await this.resolveSafeWithRealpath(path);
    } catch (error: unknown) {
      // Path-escape errors are always raised; missing-file errors are not.
      if (error instanceof WorkspacePathEscapeError) throw error;
      return null;
    }
    try {
      const content = await readFile(abs, 'utf-8');
      const stats = await stat(abs);
      return { path, content, updatedAt: stats.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  async write(path: string, content: string): Promise<WorkspaceFile> {
    this.checkExtension(path);
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > this.maxFileSize) {
      throw new Error(`File size ${bytes} exceeds max ${this.maxFileSize} bytes`);
    }
    const abs = await this.atomicWrite(path, content);
    const stats = await stat(abs);
    return { path, content, updatedAt: stats.mtime.toISOString() };
  }

  /**
   * Atomically write `content` to the workspace path `relPath`:
   *   1. resolveSafe (lexical) the target
   *   2. mkdir parent dir, then realpath parent and reject if outside root
   *   3. open `<target>.tmp.<random>` with `wx` (exclusive create — fails if
   *      a symlink/file with that name already exists)
   *   4. write bytes, close, rename → target (atomic on POSIX)
   *   5. realpath the final target — if it is somehow outside root, unlink
   *      it and throw
   *
   * Returns the absolute (realpath'd) target path on success.
   */
  private async atomicWrite(relPath: string, content: string): Promise<string> {
    const lexicalTarget = this.resolveSafe(relPath);
    const rootReal = await this.getRootReal();

    // Ensure the parent directory exists, then realpath it. Doing mkdir
    // first lets us write into a freshly-created subtree; realpath after
    // mkdir guarantees we resolve any symlinks introduced along the way.
    const lexicalParent = dirname(lexicalTarget);
    await mkdir(lexicalParent, { recursive: true });
    const realParent = await realpathOrAncestor(rootReal, relPath, lexicalParent);

    const targetName = basename(lexicalTarget);
    const target = resolve(realParent, targetName);

    // Re-verify the target itself is in-root after realpath of parent.
    const targetRel = relative(rootReal, target);
    if (targetRel.startsWith('..' + sep) || targetRel === '..' || isAbsolute(targetRel)) {
      throw new WorkspacePathEscapeError(relPath, target);
    }

    const tmpName = `.${targetName}.tmp.${randomBytes(8).toString('hex')}`;
    const tmpPath = resolve(realParent, tmpName);

    // `wx` flag: exclusive create. If `tmpPath` somehow already exists
    // (e.g. attacker-planted symlink with the random suffix — astronomically
    // unlikely), the open fails with EEXIST rather than following the link.
    let handle;
    try {
      handle = await fsOpen(tmpPath, 'wx');
    } catch (err: unknown) {
      throw new Error(
        `Failed to create temp file for atomic write: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    try {
      await handle.writeFile(content, 'utf-8');
    } finally {
      await handle.close();
    }

    try {
      await fsRename(tmpPath, target);
    } catch (err: unknown) {
      // Clean up the orphaned temp file before re-throwing.
      try {
        await unlink(tmpPath);
      } catch {
        // best-effort
      }
      throw err;
    }

    // Post-write re-validation: realpath the final target. If a symlink
    // was swapped in between mkdir and rename, this will catch it.
    let finalReal: string;
    try {
      finalReal = await realpath(target);
    } catch (err: unknown) {
      // realpath failure on a file we just wrote is itself suspicious.
      try {
        await unlink(target);
      } catch {
        // best-effort
      }
      throw new Error(
        `Post-write realpath failed for ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const finalRel = relative(rootReal, finalReal);
    if (finalRel.startsWith('..' + sep) || finalRel === '..' || isAbsolute(finalRel)) {
      try {
        await unlink(target);
      } catch {
        // best-effort
      }
      throw new WorkspacePathEscapeError(relPath, finalReal);
    }
    return finalReal;
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
    // Read existing content via the realpath-aware resolver; if the file
    // doesn't exist yet, fall through with empty content.
    let content = '';
    try {
      const absRead = await this.resolveSafeWithRealpath(path);
      content = await readFile(absRead, 'utf-8');
    } catch (error: unknown) {
      if (error instanceof WorkspacePathEscapeError) throw error;
      // ENOENT — start from empty.
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
    const bytes = Buffer.byteLength(newContent, 'utf-8');
    if (bytes > this.maxFileSize) {
      throw new Error(`File size ${bytes} exceeds max ${this.maxFileSize} bytes`);
    }
    const abs = await this.atomicWrite(path, newContent);
    const stats = await stat(abs);
    return { path, content: newContent, updatedAt: stats.mtime.toISOString() };
  }

  async patchText(path: string, replacements: Array<{ from: string; to: string }>): Promise<WorkspaceFile> {
    let content = '';
    try {
      const absRead = await this.resolveSafeWithRealpath(path);
      content = await readFile(absRead, 'utf-8');
    } catch (error: unknown) {
      if (error instanceof WorkspacePathEscapeError) throw error;
      // ENOENT — start from empty.
    }
    for (const replacement of replacements) {
      content = content.split(replacement.from).join(replacement.to);
    }
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > this.maxFileSize) {
      throw new Error(`File size ${bytes} exceeds max ${this.maxFileSize} bytes`);
    }
    const abs = await this.atomicWrite(path, content);
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
              const line = lines[i];
              if (line && line.toLowerCase().includes(lowered)) {
                results.push({
                  path: relative(this.rootDir, absPath),
                  line: i + 1,
                  content: line,
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
