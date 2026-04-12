import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('project positioning', () => {
  it('describes CrowClaw as a TypeScript agent framework in README', () => {
    const readme = read('README.md');
    expect(readme).toContain('CrowClaw');
    expect(readme).toContain('TypeScript');
    expect(readme).toContain('agent framework');
    expect(readme).not.toContain('Cloudflare-first TypeScript rewrite scaffold');
  });

  it('mentions Cloudflare as a runtime adapter', () => {
    const readme = read('README.md');
    expect(readme).toContain('Cloudflare');
    expect(readme).toContain('runtime-cloudflare');
  });
});
