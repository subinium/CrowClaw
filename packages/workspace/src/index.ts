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
