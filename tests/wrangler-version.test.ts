import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('wrangler version define', () => {
  it('matches package.json version', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf-8')) as { version: string };
    const wrangler = await readFile('wrangler.jsonc', 'utf-8');
    const match = wrangler.match(/"__CROWCLAW_VERSION__"\s*:\s*"\\"([^"]+)\\""/);
    expect(match?.[1]).toBe(pkg.version);
  });
});
