// v0.9.1 (Sentinel) — control-plane / credential file protection.
//
// `assertSafeWorkspacePath` is the single choke point every file-touching tool
// calls before the fs op. It must:
//   (a) reject control-plane + credential paths by name (auth.json, config.json,
//       .env / .env.*, ~/.ssh, ~/.aws, ~/.config/gcloud, ~/.crowclaw, *.pem/*.key,
//       id_rsa, ...);
//   (b) block `..` traversal escaping workspaceRoot;
//   (c) reject symlinks that escape the workspace (realpath check);
//   (d) carry the forensic code CONTROL_PLANE_DENIED;
//   (e) allow legitimate in-workspace paths.
//
// Each block maps to one of those, plus abuse cases (home-relative, absolute,
// nested credential dirs, operator deny globs) and the workspace.read/.write/
// .list tool wiring.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeWorkspacePath,
  controlPlaneAuditDetail,
  ControlPlaneDeniedError,
  CONTROL_PLANE_DENIED,
  ToolRegistry,
  createWorkspaceReadTool,
  createWorkspaceWriteTool,
  createWorkspaceListTool,
} from '@crowclaw/tools';
import { FileWorkspaceStore } from '../packages/workspace/src/index.js';

async function expectDenied(
  promise: Promise<unknown>,
): Promise<ControlPlaneDeniedError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ControlPlaneDeniedError);
  expect(caught).toBeInstanceOf(Error);
  return caught as ControlPlaneDeniedError;
}

describe('assertSafeWorkspacePath — control-plane guard (#Sentinel)', () => {
  // (a) credential deny-list — runs even without a workspaceRoot, because
  // these names are never legitimate agent targets.
  describe('credential / control-plane deny-list', () => {
    const denied = [
      '.env',
      '.env.local',
      '.env.production',
      '.ssh/id_rsa',
      '.ssh/id_ed25519',
      '~/.ssh/id_rsa',
      '.aws/credentials',
      '~/.aws/credentials',
      '.config/gcloud/application_default_credentials.json',
      '~/.config/gcloud/credentials.db',
      '.crowclaw/auth.json',
      '~/.crowclaw/runtime.json',
      'certs/server.pem',
      'keys/private.key',
      'tls/cert.p12',
      'id_rsa',
      'nested/dir/id_dsa',
      '.npmrc',
      '.netrc',
      '.docker/config.json',
    ];

    for (const path of denied) {
      it(`rejects ${path}`, async () => {
        const err = await expectDenied(assertSafeWorkspacePath(path, { kind: 'read' }));
        expect(err.rule).toBe('credential-deny-list');
        expect(err.code).toBe(CONTROL_PLANE_DENIED);
        expect(err.kind).toBe('read');
        expect(err.attemptedPath).toBe(path);
      });
    }

    it('rejects a deep .env even when buried under allowed dirs', async () => {
      const err = await expectDenied(
        assertSafeWorkspacePath('src/app/config/.env', { kind: 'write' }),
      );
      expect(err.rule).toBe('credential-deny-list');
      expect(err.kind).toBe('write');
    });

    it('honors operator extraDenyGlobs (suffix glob)', async () => {
      const err = await expectDenied(
        assertSafeWorkspacePath('data/customers.secret', {
          kind: 'read',
          extraDenyGlobs: ['*.secret'],
        }),
      );
      expect(err.rule).toBe('credential-deny-list');
      expect(err.message).toContain('*.secret');
    });

    it('honors operator extraDenyGlobs (exact basename)', async () => {
      await expectDenied(
        assertSafeWorkspacePath('vault-token', {
          kind: 'read',
          extraDenyGlobs: ['vault-token'],
        }),
      );
    });

    it('allows common basenames (config.json / auth.json / credentials) OUTSIDE a credential dir', async () => {
      // These are protected by LOCATION (the credential dir they live in), not
      // by basename — a workspace file literally named config.json is legitimate.
      // The runtime's own copies under ~/.crowclaw / ~/.aws / ~/.docker stay
      // denied via their dir segments (asserted in the `denied` list above).
      await expect(assertSafeWorkspacePath('config.json', { kind: 'write' })).resolves.toBeUndefined();
      await expect(assertSafeWorkspacePath('auth.json', { kind: 'write' })).resolves.toBeUndefined();
      await expect(assertSafeWorkspacePath('src/credentials.ts', { kind: 'read' })).resolves.toBeUndefined();
      await expect(assertSafeWorkspacePath('project/config.json', { kind: 'write' })).resolves.toBeUndefined();
    });

    it('does NOT reject a file that merely contains "env" or "key" as a substring', async () => {
      // `environment.ts` / `keyboard.ts` must not be caught by the dotenv /
      // key globs — those are suffix/prefix anchored.
      await expect(
        assertSafeWorkspacePath('src/environment.ts', { kind: 'read' }),
      ).resolves.toBeUndefined();
      await expect(
        assertSafeWorkspacePath('src/keyboard.ts', { kind: 'read' }),
      ).resolves.toBeUndefined();
      // `.envrc` is direnv config, not a dotenv secret — the `.env.` prefix
      // glob and the exact `.env` segment must both miss it.
      await expect(
        assertSafeWorkspacePath('.envrc', { kind: 'read' }),
      ).resolves.toBeUndefined();
    });
  });

  // (b) path traversal — needs a workspaceRoot to test escape against.
  describe('path traversal', () => {
    const root = '/srv/workspace';

    it('rejects ../ escaping the root', async () => {
      const err = await expectDenied(
        assertSafeWorkspacePath('../../etc/hostname', {
          kind: 'read',
          workspaceRoot: root,
          realpath: null,
        }),
      );
      expect(err.rule).toBe('path-traversal');
      expect(err.code).toBe(CONTROL_PLANE_DENIED);
      expect(err.resolvedPath).toBe('/etc/hostname');
    });

    it('rejects an absolute path outside the root', async () => {
      const err = await expectDenied(
        assertSafeWorkspacePath('/etc/hostname', {
          kind: 'read',
          workspaceRoot: root,
          realpath: null,
        }),
      );
      expect(err.rule).toBe('path-traversal');
    });

    it('allows ../ that stays inside the root', async () => {
      // workspace-relative `sub/../note.txt` normalizes to `<root>/note.txt`.
      await expect(
        assertSafeWorkspacePath('sub/../note.txt', {
          kind: 'read',
          workspaceRoot: root,
          realpath: null,
        }),
      ).resolves.toBeUndefined();
    });

    it('allows a plain in-root relative path', async () => {
      await expect(
        assertSafeWorkspacePath('docs/readme.md', {
          kind: 'read',
          workspaceRoot: root,
          realpath: null,
        }),
      ).resolves.toBeUndefined();
    });

    it('skips traversal/symlink checks when no workspaceRoot is supplied', async () => {
      // Without a root there is nothing to escape; the deny-list is clear, so
      // this benign relative path is allowed.
      await expect(
        assertSafeWorkspacePath('../sibling/file.txt', { kind: 'read' }),
      ).resolves.toBeUndefined();
    });
  });

  // (c) symlink escape — real fs with a planted symlink pointing outside.
  describe('symlink escape (realpath)', () => {
    let tempDir: string;
    let outsideDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'cp-guard-'));
      outsideDir = await mkdtemp(join(tmpdir(), 'cp-guard-outside-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    });

    it('rejects a symlink inside the workspace pointing to a host file', async () => {
      const outsideFile = join(outsideDir, 'secret.txt');
      await writeFile(outsideFile, 'host secret', 'utf-8');
      symlinkSync(outsideFile, join(tempDir, 'leak.txt'));

      const err = await expectDenied(
        assertSafeWorkspacePath('leak.txt', { kind: 'read', workspaceRoot: tempDir }),
      );
      expect(err.rule).toBe('symlink-escape');
      expect(err.resolvedPath).toContain(outsideDir);
    });

    it('rejects writing through a symlinked parent dir that escapes the root', async () => {
      symlinkSync(outsideDir, join(tempDir, 'sneak'));
      const err = await expectDenied(
        assertSafeWorkspacePath('sneak/payload.txt', { kind: 'write', workspaceRoot: tempDir }),
      );
      expect(err.rule).toBe('symlink-escape');
    });

    it('allows an in-root → in-root symlink', async () => {
      await writeFile(join(tempDir, 'real.txt'), 'real', 'utf-8');
      symlinkSync(join(tempDir, 'real.txt'), join(tempDir, 'alias.txt'));
      await expect(
        assertSafeWorkspacePath('alias.txt', { kind: 'read', workspaceRoot: tempDir }),
      ).resolves.toBeUndefined();
    });

    it('allows a brand-new (non-existent) file inside the root', async () => {
      // realpath walks up to the existing ancestor (tempDir) — the file does
      // not exist yet, which is the normal write case.
      await expect(
        assertSafeWorkspacePath('new/nested/output.txt', {
          kind: 'write',
          workspaceRoot: tempDir,
        }),
      ).resolves.toBeUndefined();
    });
  });

  // (d) forensic envelope shape.
  describe('forensic / audit envelope', () => {
    it('controlPlaneAuditDetail emits code/rule/kind/attemptedPath', async () => {
      const err = await expectDenied(
        assertSafeWorkspacePath('.aws/credentials', { kind: 'read' }),
      );
      const detail = controlPlaneAuditDetail(err);
      expect(detail).toContain(`code=${CONTROL_PLANE_DENIED}`);
      expect(detail).toContain('rule=credential-deny-list');
      expect(detail).toContain('kind=read');
      expect(detail).toContain('attemptedPath=.aws/credentials');
    });

    it('rejects an empty path as a traversal denial', async () => {
      const err = await expectDenied(assertSafeWorkspacePath('', { kind: 'read' }));
      expect(err.rule).toBe('path-traversal');
    });
  });
});

// -- wiring: workspace.read / .write / .list tools enforce the guard ----------
describe('workspace tools enforce the control-plane guard', () => {
  let tempDir: string;
  let store: FileWorkspaceStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cp-guard-ws-'));
    store = new FileWorkspaceStore(tempDir);
    await writeFile(join(tempDir, 'note.txt'), 'hello', 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const ctx = { agentId: 'crowclaw', sessionId: 'cp-guard-ws' };

  it('workspace.read returns ok:false + forensic metadata for a credential path', async () => {
    const tool = createWorkspaceReadTool(store, { workspaceRoot: tempDir });
    const result = await tool.execute({ path: '.env' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Access denied');
    expect(result.metadata?.controlPlaneDenied).toBe(true);
    expect(result.metadata?.forensicCode).toBe(CONTROL_PLANE_DENIED);
    expect(result.metadata?.denialRule).toBe('credential-deny-list');
  });

  it('workspace.read still serves a legitimate file', async () => {
    const tool = createWorkspaceReadTool(store, { workspaceRoot: tempDir });
    const result = await tool.execute({ path: 'note.txt' }, { ...ctx, sessionId: 'cp-guard-ok' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('hello');
  });

  it("workspace.write blocks writing the runtime's own .crowclaw/auth.json", async () => {
    // A bare `auth.json` in the workspace is legitimate (allowed); the runtime's
    // control-plane copy under the `.crowclaw` data dir stays blocked by location.
    const tool = createWorkspaceWriteTool(store, {
      controlPlaneGuard: { workspaceRoot: tempDir },
    });
    const result = await tool.execute({ path: '.crowclaw/auth.json', content: '{"token":"x"}' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.metadata?.controlPlaneDenied).toBe(true);
    expect(result.metadata?.denialRule).toBe('credential-deny-list');
  });

  it('workspace.write allows a normal workspace config.json', async () => {
    const tool = createWorkspaceWriteTool(store, {
      controlPlaneGuard: { workspaceRoot: tempDir },
    });
    const result = await tool.execute({ path: 'config.json', content: '{"k":"v"}' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('workspace.write blocks a traversal escape', async () => {
    const tool = createWorkspaceWriteTool(store, {
      controlPlaneGuard: { workspaceRoot: tempDir },
    });
    const result = await tool.execute(
      { path: '../escape.txt', content: 'bad' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.metadata?.denialRule).toBe('path-traversal');
  });

  it('workspace.write persists a legitimate file', async () => {
    const tool = createWorkspaceWriteTool(store, {
      controlPlaneGuard: { workspaceRoot: tempDir },
    });
    const result = await tool.execute({ path: 'out.txt', content: 'data' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('workspace.list blocks a credential-dir prefix', async () => {
    const tool = createWorkspaceListTool(store, { workspaceRoot: tempDir });
    const result = await tool.execute({ prefix: '.ssh' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.metadata?.controlPlaneDenied).toBe(true);
  });

  it('workspace.list with no prefix lists the root', async () => {
    const tool = createWorkspaceListTool(store, { workspaceRoot: tempDir });
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(true);
  });
});
