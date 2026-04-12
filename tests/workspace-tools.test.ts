import { describe, expect, it } from 'vitest';
import { ToolRegistry, createWorkspaceDeleteTool, createWorkspaceExistsTool, createWorkspaceListTool, createWorkspacePatchTextTool, createWorkspacePatchTool, createWorkspaceReadTool, createWorkspaceRenameTool, createWorkspaceSearchFilesTool, createWorkspaceWriteTool } from '@crowclaw/tools';
import { InMemoryWorkspaceStore } from '../packages/workspace/src/index.js';

describe('workspace tool integrations', () => {
  it('writes and reads workspace files', async () => {
    const store = new InMemoryWorkspaceStore();
    const registry = new ToolRegistry()
      .register(createWorkspaceWriteTool(store))
      .register(createWorkspaceReadTool(store));

    const write = await registry.execute('workspace.write', {
      path: 'src/app.ts',
      content: 'console.log("hi")'
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-1'
    });
    expect(write.ok).toBe(true);

    const read = await registry.execute('workspace.read', {
      path: 'src/app.ts'
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-1'
    });
    expect(read.output).toBe('console.log("hi")');
  });

  it('lists workspace files by prefix', async () => {
    const store = new InMemoryWorkspaceStore();
    await store.write('src/app.ts', 'a');
    await store.write('src/lib.ts', 'b');
    await store.write('docs/readme.md', 'c');
    const registry = new ToolRegistry().register(createWorkspaceListTool(store));
    const listed = await registry.execute('workspace.list', { prefix: 'src/' }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-list-1'
    });
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain('src/app.ts');
    expect(listed.output).toContain('src/lib.ts');
    expect(listed.output).not.toContain('docs/readme.md');
  });

  it('searches workspace files by substring and regex', async () => {
    const store = new InMemoryWorkspaceStore();
    await store.write('src/app.ts', 'const crowclaw = "hello";');
    await store.write('src/worker.ts', 'const agent = "legacy";');
    await store.write('docs/readme.md', 'CrowClaw release candidate');

    const registry = new ToolRegistry().register(createWorkspaceSearchFilesTool(store));

    const substring = await registry.execute('workspace.searchFiles', {
      prefix: 'src/',
      query: 'crowclaw'
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-search-1'
    });

    expect(substring.ok).toBe(true);
    expect(substring.output).toContain('src/app.ts');
    expect(substring.output).not.toContain('docs/readme.md');

    const regex = await registry.execute('workspace.searchFiles', {
      query: 'release\\s+candidate',
      mode: 'regex'
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-search-2'
    });

    expect(regex.ok).toBe(true);
    expect(regex.output).toContain('docs/readme.md');
  });

  it('patches workspace files by line number', async () => {
    const store = new InMemoryWorkspaceStore();
    await store.write('src/app.ts', 'alpha\nbeta\ngamma');

    const registry = new ToolRegistry().register(createWorkspacePatchTool(store));
    const patched = await registry.execute('workspace.patchLines', {
      path: 'src/app.ts',
      patches: [{ line: 2, value: 'BETA' }]
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-2'
    });

    expect(patched.ok).toBe(true);
    expect(patched.output).toBe('alpha\nBETA\ngamma');
  });

  it('patches workspace files by deterministic text replacement', async () => {
    const store = new InMemoryWorkspaceStore();
    await store.write('src/app.ts', 'hello old world');

    const registry = new ToolRegistry().register(createWorkspacePatchTextTool(store));
    const patched = await registry.execute('workspace.patchText', {
      path: 'src/app.ts',
      replacements: [
        { from: 'old', to: 'new' },
        { from: 'hello', to: 'hi' }
      ]
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-2b'
    });

    expect(patched.ok).toBe(true);
    expect(patched.output).toBe('hi new world');
  });

  it('checks for file existence and deletes workspace files', async () => {
    const store = new InMemoryWorkspaceStore();
    await store.write('src/app.ts', 'alpha');

    const registry = new ToolRegistry()
      .register(createWorkspaceExistsTool(store))
      .register(createWorkspaceDeleteTool(store));

    const exists = await registry.execute('workspace.exists', {
      path: 'src/app.ts'
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-3'
    });
    expect(exists.ok).toBe(true);
    expect(exists.output).toContain('"exists":true');

    const deleted = await registry.execute('workspace.delete', {
      path: 'src/app.ts'
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-3'
    });
    expect(deleted.ok).toBe(true);

    const existsAfterDelete = await registry.execute('workspace.exists', {
      path: 'src/app.ts'
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-3'
    });
    expect(existsAfterDelete.output).toContain('"exists":false');
  });

  it('renames workspace files', async () => {
    const store = new InMemoryWorkspaceStore();
    await store.write('src/old.ts', 'alpha');

    const registry = new ToolRegistry()
      .register(createWorkspaceRenameTool(store))
      .register(createWorkspaceExistsTool(store));

    const renamed = await registry.execute('workspace.rename', {
      fromPath: 'src/old.ts',
      toPath: 'src/new.ts'
    }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-4'
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.metadata).toMatchObject({ fromPath: 'src/old.ts', toPath: 'src/new.ts' });

    const oldExists = await registry.execute('workspace.exists', { path: 'src/old.ts' }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-4'
    });
    const newExists = await registry.execute('workspace.exists', { path: 'src/new.ts' }, {
      agentId: 'crowclaw',
      sessionId: 'workspace-4'
    });
    expect(oldExists.output).toContain('"exists":false');
    expect(newExists.output).toContain('"exists":true');
  });
});
