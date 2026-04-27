/**
 * v0.6.1 / issue #158 — verify the core ↔ plugins layering inversion is fixed.
 *
 * Before #158: `@crowclaw/core` declared `@crowclaw/plugins` as a runtime
 * dependency (and imported PluginManager from it), inverting expected
 * layering. After the fix:
 *   - PluginManager + Plugin contract live in `@crowclaw/core`.
 *   - `@crowclaw/plugins` is a thin re-export shim that depends on core.
 *   - core no longer depends on plugins.
 *
 * These tests pin the contract: package metadata + public API surface from
 * both entry points must keep working.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MemoryCapturePlugin as CoreMemoryCapturePlugin,
  PluginManager as CorePluginManager,
} from '@crowclaw/core';
import type {
  Plugin as CorePlugin,
  PluginContext as CorePluginContext,
  PluginHookName,
  PluginInvocationPayloads,
  PreToolCallVeto,
  ToolResultTransform,
} from '@crowclaw/core';

import {
  MemoryCapturePlugin as ShimMemoryCapturePlugin,
  PluginManager as ShimPluginManager,
} from '@crowclaw/plugins';
import type { Plugin as ShimPlugin } from '@crowclaw/plugins';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

interface PkgManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe('v0.6.1 #158 — core/plugins layering', () => {
  it('core/package.json does NOT depend on @crowclaw/plugins', async () => {
    const pkg = await readJson<PkgManifest>(
      path.join(repoRoot, 'packages/core/package.json'),
    );
    expect(pkg.name).toBe('@crowclaw/core');
    expect(pkg.dependencies?.['@crowclaw/plugins']).toBeUndefined();
    expect(pkg.devDependencies?.['@crowclaw/plugins']).toBeUndefined();
  });

  it('plugins/package.json depends on @crowclaw/core (correct direction)', async () => {
    const pkg = await readJson<PkgManifest>(
      path.join(repoRoot, 'packages/plugins/package.json'),
    );
    expect(pkg.name).toBe('@crowclaw/plugins');
    expect(pkg.dependencies?.['@crowclaw/core']).toBeDefined();
  });

  it('core/src/index.ts contains no import from @crowclaw/plugins', async () => {
    const source = await fs.readFile(
      path.join(repoRoot, 'packages/core/src/index.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from '@crowclaw\/plugins'/);
  });

  it('core/src/plugins.ts is the canonical home for PluginManager', async () => {
    const source = await fs.readFile(
      path.join(repoRoot, 'packages/core/src/plugins.ts'),
      'utf8',
    );
    expect(source).toMatch(/export class PluginManager/);
    expect(source).toMatch(/export interface Plugin\b/);
    expect(source).toMatch(/export class MemoryCapturePlugin/);
  });

  it('plugins/src/index.ts is a re-export shim from @crowclaw/core', async () => {
    const source = await fs.readFile(
      path.join(repoRoot, 'packages/plugins/src/index.ts'),
      'utf8',
    );
    expect(source).toMatch(/from '@crowclaw\/core'/);
    // Shim must NOT redeclare the implementation.
    expect(source).not.toMatch(/class PluginManager/);
    expect(source).not.toMatch(/class MemoryCapturePlugin/);
  });
});

describe('v0.6.1 #158 — public contract still works', () => {
  it('PluginManager from @crowclaw/core and @crowclaw/plugins are the same class', () => {
    expect(CorePluginManager).toBe(ShimPluginManager);
    expect(CoreMemoryCapturePlugin).toBe(ShimMemoryCapturePlugin);
  });

  it('register + list + emit observer hooks fire in order', async () => {
    const manager = new CorePluginManager();
    const observer = new CoreMemoryCapturePlugin();
    manager.register(observer);

    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]).toBe(observer);

    const ctx: CorePluginContext = {
      runtime: 'test',
      sessionId: 'sess-1',
      agentId: 'agent-1',
    };
    await manager.emit(
      'agent:beforeRun',
      { input: { agentId: 'agent-1', sessionId: 'sess-1' } },
      ctx,
    );
    await manager.emit(
      'tool:beforeExecute',
      { toolName: 'echo', input: {}, sessionId: 'sess-1', agentId: 'agent-1' },
      ctx,
    );
    expect(observer.seen.map((s) => s.hook)).toEqual<PluginHookName[]>([
      'agent:beforeRun',
      'tool:beforeExecute',
    ]);
  });

  it('preToolCall OR-aggregates: any veto blocks; first wins', async () => {
    const manager = new CorePluginManager();
    const allowPlugin: CorePlugin = {
      name: 'allow',
      preToolCall: (): PreToolCallVeto => ({ veto: false }),
    };
    const denyPlugin: CorePlugin = {
      name: 'deny',
      preToolCall: (): PreToolCallVeto => ({ veto: true, reason: 'nope' }),
    };
    manager.register(allowPlugin);
    manager.register(denyPlugin);

    const ctx: CorePluginContext = {
      runtime: 'test',
      sessionId: 's',
      agentId: 'a',
    };
    const verdict = await manager.preToolCall(
      { toolName: 'web.fetch', input: {}, sessionId: 's', agentId: 'a' },
      ctx,
    );
    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toMatch(/^deny: nope$/);
  });

  it('preToolCall: throwing plugin does not block the tool', async () => {
    const manager = new CorePluginManager();
    const throwingPlugin: CorePlugin = {
      name: 'broken',
      preToolCall: () => {
        throw new Error('plugin crashed');
      },
    };
    manager.register(throwingPlugin);

    const verdict = await manager.preToolCall(
      { toolName: 'echo', input: {}, sessionId: 's', agentId: 'a' },
      { runtime: 'test', sessionId: 's', agentId: 'a' },
    );
    expect(verdict.veto).toBe(false);
  });

  it('transformToolResult chains overrides in registration order', async () => {
    const manager = new CorePluginManager();
    const upper: CorePlugin = {
      name: 'upper',
      transformToolResult: ({ result }): ToolResultTransform => ({
        output: result.output.toUpperCase(),
      }),
    };
    const tagger: CorePlugin = {
      name: 'tagger',
      transformToolResult: (): ToolResultTransform => ({
        metadata: { tagged: true },
      }),
    };
    manager.register(upper);
    manager.register(tagger);

    const payload: PluginInvocationPayloads['tool:transformResult']['payload'] = {
      toolName: 'echo',
      input: {},
      result: { toolName: 'echo', ok: true, output: 'hello', metadata: { src: 'core' } },
      sessionId: 's',
      agentId: 'a',
    };
    const final = await manager.transformToolResult(payload, {
      runtime: 'test',
      sessionId: 's',
      agentId: 'a',
    });
    expect(final.output).toBe('HELLO');
    expect(final.ok).toBe(true);
    expect(final.metadata).toEqual({ src: 'core', tagged: true });
  });

  it('shim Plugin type is structurally compatible with core Plugin type', () => {
    // Compile-time assertion: a shim Plugin can be assigned to a core Plugin slot
    // and vice-versa. If the shim diverged, this would fail typecheck.
    const fromShim: ShimPlugin = { name: 'x' };
    const fromCore: CorePlugin = fromShim;
    const back: ShimPlugin = fromCore;
    expect(back.name).toBe('x');
  });
});
