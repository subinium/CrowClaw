import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

describe('runtime-node plugin routes', () => {
  it('lists plugins in the node runtime', async () => {
    const runtime = createNodeRuntime();
    const response = await runtime.fetch(new Request('http://localhost/api/plugins'));
    const payload = await response.json() as Array<{ name: string }>;
    expect(payload).toEqual([{ name: 'memory-capture' }]);
  });
});
