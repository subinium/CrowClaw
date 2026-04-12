/**
 * Markdown Memory Store
 *
 * Stores memories as plain Markdown files in a directory.
 * Inspired by the plain-file memory pattern popularized by OpenClaw.
 *
 * Each memory is a file with YAML frontmatter:
 * ```
 * ---
 * scope: session
 * scopeKey: session-123
 * tags: [preference, language]
 * createdAt: 2026-04-12T10:00:00Z
 * ---
 * User prefers TypeScript over JavaScript.
 * ```
 */

export interface MarkdownMemoryRecord {
  id: string;
  scope: 'session' | 'user' | 'workspace';
  scopeKey?: string;
  summary: string;
  tags: string[];
  createdAt: string;
  filePath: string;
}

export interface MarkdownMemoryFileSystem {
  readDir(dirPath: string): Promise<string[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  ensureDir(dirPath: string): Promise<void>;
  joinPath(...segments: string[]): string;
}

export class MarkdownMemoryStore {
  constructor(
    private readonly baseDir: string,
    private readonly fs: MarkdownMemoryFileSystem
  ) {}

  async remember(
    record: Omit<MarkdownMemoryRecord, 'id' | 'filePath'>
  ): Promise<MarkdownMemoryRecord> {
    await this.fs.ensureDir(this.baseDir);

    const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const filePath = this.fs.joinPath(this.baseDir, `${id}.md`);

    const content = [
      '---',
      `scope: ${record.scope}`,
      record.scopeKey ? `scopeKey: ${record.scopeKey}` : null,
      record.tags.length > 0
        ? `tags: [${record.tags.join(', ')}]`
        : null,
      `createdAt: ${record.createdAt}`,
      '---',
      '',
      record.summary,
    ]
      .filter(Boolean)
      .join('\n');

    await this.fs.writeFile(filePath, content);

    return { ...record, id, filePath };
  }

  async recall(
    query?: string,
    scope?: string,
    limit = 20
  ): Promise<MarkdownMemoryRecord[]> {
    const records: MarkdownMemoryRecord[] = [];

    try {
      const files = await this.fs.readDir(this.baseDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = this.fs.joinPath(this.baseDir, file);
        const content = await this.fs.readFile(filePath);
        const parsed = this.parseMemoryFile(
          content,
          file.replace('.md', ''),
          filePath
        );
        if (parsed) {
          if (scope && parsed.scope !== scope) continue;
          if (
            query &&
            !parsed.summary.toLowerCase().includes(query.toLowerCase())
          )
            continue;
          records.push(parsed);
        }
      }
    } catch {
      /* dir doesn't exist */
    }

    return records
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.fs.removeFile(this.fs.joinPath(this.baseDir, `${id}.md`));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<MarkdownMemoryRecord[]> {
    return this.recall();
  }

  private parseMemoryFile(
    content: string,
    id: string,
    filePath: string
  ): MarkdownMemoryRecord | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith('---')) {
      return {
        id,
        scope: 'session',
        summary: trimmed,
        tags: [],
        createdAt: '',
        filePath,
      };
    }

    const endIndex = trimmed.indexOf('---', 3);
    if (endIndex === -1) return null;

    const frontmatter = trimmed.slice(3, endIndex).trim();
    const summary = trimmed.slice(endIndex + 3).trim();

    let scope: 'session' | 'user' | 'workspace' = 'session';
    let scopeKey: string | undefined;
    let tags: string[] = [];
    let createdAt = '';

    for (const line of frontmatter.split('\n')) {
      const trimLine = line.trim();
      if (trimLine.startsWith('scope:'))
        scope = trimLine.slice(6).trim() as typeof scope;
      if (trimLine.startsWith('scopeKey:'))
        scopeKey = trimLine.slice(9).trim();
      if (trimLine.startsWith('createdAt:'))
        createdAt = trimLine.slice(10).trim();
      if (trimLine.startsWith('tags:')) {
        const match = trimLine.match(/\[([^\]]*)\]/);
        if (match)
          tags = match[1]
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
      }
    }

    return { id, scope, scopeKey, summary, tags, createdAt, filePath };
  }
}
