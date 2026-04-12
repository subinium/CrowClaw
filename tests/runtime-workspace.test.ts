import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

describe('runtime workspace integration', () => {
  it('supports workspace write/read/patch/list/exists/delete/rename routes in the node runtime', async () => {
    const runtime = createNodeRuntime();

    const write = await runtime.fetch(new Request('http://localhost/api/workspace/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts', content: 'alpha\nbeta' })
    }));
    expect((await write.json() as { content: string }).content).toBe('alpha\nbeta');

    const patch = await runtime.fetch(new Request('http://localhost/api/workspace/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts', patches: [{ line: 2, value: 'BETA' }] })
    }));
    expect((await patch.json() as { content: string }).content).toBe('alpha\nBETA');

    const patchText = await runtime.fetch(new Request('http://localhost/api/workspace/patch-text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts', replacements: [{ from: 'BETA', to: 'beta!' }] })
    }));
    expect((await patchText.json() as { content: string }).content).toBe('alpha\nbeta!');

    const read = await runtime.fetch(new Request('http://localhost/api/workspace/src/app.ts'));
    expect((await read.json() as { content: string }).content).toBe('alpha\nbeta!');

    const list = await runtime.fetch(new Request('http://localhost/api/workspace?prefix=src/'));
    const files = await list.json() as Array<{ path: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/app.ts');

    const queryRead = await runtime.fetch(new Request('http://localhost/api/workspace?path=src/app.ts'));
    expect((await queryRead.json() as { content: string }).content).toBe('alpha\nbeta!');

    const exists = await runtime.fetch(new Request('http://localhost/api/workspace/exists?path=src/app.ts'));
    expect((await exists.json() as { exists: boolean }).exists).toBe(true);

    const remove = await runtime.fetch(new Request('http://localhost/api/workspace/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts' })
    }));
    expect((await remove.json() as { removed: boolean }).removed).toBe(true);

    const existsAfterDelete = await runtime.fetch(new Request('http://localhost/api/workspace/exists?path=src/app.ts'));
    expect((await existsAfterDelete.json() as { exists: boolean }).exists).toBe(false);

    await runtime.fetch(new Request('http://localhost/api/workspace/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/old.ts', content: 'rename-me' })
    }));

    const rename = await runtime.fetch(new Request('http://localhost/api/workspace/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromPath: 'src/old.ts', toPath: 'src/new.ts' })
    }));
    expect((await rename.json() as { path: string; content: string }).path).toBe('src/new.ts');

    const oldExists = await runtime.fetch(new Request('http://localhost/api/workspace/exists?path=src/old.ts'));
    const newExists = await runtime.fetch(new Request('http://localhost/api/workspace/exists?path=src/new.ts'));
    expect((await oldExists.json() as { exists: boolean }).exists).toBe(false);
    expect((await newExists.json() as { exists: boolean }).exists).toBe(true);
  });
});
