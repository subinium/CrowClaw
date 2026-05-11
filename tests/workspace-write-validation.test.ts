// v0.9.0 (#310) — post-write linting for workspace.write. Hermes v0.13 #20191
// runs a syntax check after write_file so the agent self-corrects on the next
// turn instead of finding out at the next test run. We mirror the same
// dispatch (JSON / YAML / TOML / Python) and ship the SYNTAX_ERROR envelope
// shape called out in the issue.
//
// Acceptance criteria:
//   - Invalid JSON returns SYNTAX_ERROR with line/col
//   - Valid Python returns no error
//   - Invalid YAML returns SYNTAX_ERROR
//   - Python validator gracefully degrades when python3 is not on PATH
//   - postWriteValidation: 'off' disables all validators

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolRegistry, createWorkspaceWriteTool } from '@crowclaw/tools';
import {
  validateJson,
  validateYaml,
  validateToml,
  validatePython,
  validateSyntax,
  pickValidator,
} from '@crowclaw/tools';
import { InMemoryWorkspaceStore } from '../packages/workspace/src/index.js';

describe('post-write syntax validation (#310)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('pickValidator', () => {
    it('maps extensions to languages', () => {
      expect(pickValidator('a.json')).toBe('json');
      expect(pickValidator('a.JSON')).toBe('json');
      expect(pickValidator('config.jsonc')).toBe('json');
      expect(pickValidator('infra.yaml')).toBe('yaml');
      expect(pickValidator('infra.yml')).toBe('yaml');
      expect(pickValidator('Cargo.toml')).toBe('toml');
      expect(pickValidator('script.py')).toBe('python');
      expect(pickValidator('types.pyi')).toBe('python');
      expect(pickValidator('README.md')).toBeNull();
      expect(pickValidator('Dockerfile')).toBeNull();
      expect(pickValidator('weird.path/no-ext')).toBeNull();
    });

    it('handles paths with dots and separators', () => {
      // The last segment after / wins; `config.json/x.txt` is a `.txt` file
      // by extension, not a `.json` file.
      expect(pickValidator('config.json/notes.txt')).toBeNull();
      // tar.gz: only the last extension picks the validator.
      expect(pickValidator('archive.tar.gz')).toBeNull();
    });
  });

  describe('validateJson', () => {
    it('passes valid JSON', () => {
      expect(validateJson('{"a":1,"b":[1,2,3]}').ok).toBe(true);
    });
    it('flags invalid JSON with a position', () => {
      const result = validateJson('{"a": ,}');
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('SYNTAX_ERROR');
      expect(result.error?.validator).toBe('json');
      expect(result.error?.message).toContain('Invalid JSON');
      // Line/col extraction depends on Node version; the test asserts shape
      // not exact numbers.
      if (result.error?.line !== undefined) {
        expect(result.error.line).toBeGreaterThan(0);
      }
    });
    it('flags unterminated string', () => {
      expect(validateJson('{"key": "value\n}').ok).toBe(false);
    });
  });

  describe('validateYaml', () => {
    it('passes valid YAML', () => {
      expect(validateYaml('name: crow\nclaws: 4\nflags: [a, b]').ok).toBe(true);
    });
    it('passes empty YAML', () => {
      expect(validateYaml('').ok).toBe(true);
      expect(validateYaml('   \n').ok).toBe(true);
    });
    it('flags tab indentation', () => {
      const result = validateYaml('parent:\n\tchild: 1');
      expect(result.ok).toBe(false);
      expect(result.error?.validator).toBe('yaml');
      expect(result.error?.message).toContain('tab characters');
      expect(result.error?.line).toBe(2);
    });
    it('flags unclosed flow sequence', () => {
      const result = validateYaml('items: [1, 2');
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('flow sequence');
    });
    it('flags unterminated quoted string', () => {
      const result = validateYaml('name: "unclosed');
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('unterminated');
    });
    it('flags missing colon in mapping line', () => {
      const result = validateYaml('parent:\n  child\n  other: 1');
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('expected mapping or list entry');
    });
  });

  describe('validateToml', () => {
    it('passes valid TOML', () => {
      const toml = `
[package]
name = "crow"
version = "0.1.0"

[deps]
serde = "1.0"
`;
      expect(validateToml(toml).ok).toBe(true);
    });
    it('flags unmatched bracket in table header', () => {
      const result = validateToml('[unclosed\nname = "x"');
      expect(result.ok).toBe(false);
      expect(result.error?.validator).toBe('toml');
    });
    it('flags unterminated double-quoted string', () => {
      const result = validateToml('name = "unclosed');
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('unterminated');
    });
  });

  describe('validatePython', () => {
    it('passes valid Python or degrades gracefully', async () => {
      const result = await validatePython('def add(a, b):\n    return a + b\n');
      // If python3 is on PATH this is ok+not-skipped; otherwise skipped=true.
      expect(result.ok).toBe(true);
      if (result.skipped) {
        expect(result.skipReason).toMatch(/python3|child_process/);
      }
    });

    it('flags invalid Python (when python3 is available)', async () => {
      const result = await validatePython('def broken(:\n    pass\n');
      if (result.skipped) {
        // Environment without python3 — AC says degrade silently.
        expect(result.ok).toBe(true);
        return;
      }
      expect(result.ok).toBe(false);
      expect(result.error?.validator).toBe('python');
      expect(result.error?.message).toContain('Invalid Python');
      // Line numbers vary by Python version; assert presence not exact value.
      if (result.error?.line !== undefined) {
        expect(result.error.line).toBeGreaterThan(0);
      }
    });
  });

  describe('validateSyntax dispatcher', () => {
    it('returns language=null when no validator matches', async () => {
      const result = await validateSyntax('README.md', '# Hi');
      expect(result.ok).toBe(true);
      expect(result.language).toBeNull();
    });
    it('dispatches by extension', async () => {
      const result = await validateSyntax('a.json', '{bad}');
      expect(result.ok).toBe(false);
      expect(result.language).toBe('json');
    });
    it('honors explicit language override', async () => {
      const result = await validateSyntax('script.notyaml', 'items: [1, 2', 'yaml');
      expect(result.ok).toBe(false);
      expect(result.language).toBe('yaml');
    });
  });

  describe('workspace.write integration', () => {
    it('mode=block: invalid JSON returns SYNTAX_ERROR envelope', async () => {
      const store = new InMemoryWorkspaceStore();
      const registry = new ToolRegistry().register(
        createWorkspaceWriteTool(store, { postWriteValidation: 'block' }),
      );
      const result = await registry.execute(
        'workspace.write',
        { path: 'config.json', content: '{"a": ,}' },
        { agentId: 'crowclaw', sessionId: 'write-validate-1' },
      );
      expect(result.ok).toBe(false);
      expect(result.output).toContain('Invalid JSON');
      // Envelope-shape check: dashboards parse error.code + retry_instruction.
      const meta = result.metadata as Record<string, unknown>;
      expect((meta.error as { code: string })?.code).toBe('SYNTAX_ERROR');
      expect((meta.error as { validator: string })?.validator).toBe('json');
      expect(meta.retry_instruction).toContain('fix the syntax error');
    });

    it('mode=block: file is still persisted (not rolled back)', async () => {
      // Per the issue spec: "File is not rolled back — the broken content
      // remains so the agent can see the diff and fix it." Verify with a
      // subsequent workspace.read on the same store.
      const store = new InMemoryWorkspaceStore();
      const registry = new ToolRegistry().register(
        createWorkspaceWriteTool(store, { postWriteValidation: 'block' }),
      );
      await registry.execute(
        'workspace.write',
        { path: 'config.json', content: '{bad' },
        { agentId: 'crowclaw', sessionId: 'write-validate-2' },
      );
      const persisted = await store.read('config.json');
      expect(persisted?.content).toBe('{bad');
    });

    it('mode=warn (default): SYNTAX_ERROR is surfaced under metadata, ok stays true', async () => {
      const store = new InMemoryWorkspaceStore();
      const registry = new ToolRegistry().register(createWorkspaceWriteTool(store));
      const result = await registry.execute(
        'workspace.write',
        { path: 'config.json', content: '{bad' },
        { agentId: 'crowclaw', sessionId: 'write-validate-3' },
      );
      expect(result.ok).toBe(true);
      const meta = result.metadata as Record<string, unknown>;
      expect((meta.syntaxWarning as { code: string })?.code).toBe('SYNTAX_ERROR');
    });

    it('mode=off: validators are skipped entirely', async () => {
      const store = new InMemoryWorkspaceStore();
      const registry = new ToolRegistry().register(
        createWorkspaceWriteTool(store, { postWriteValidation: 'off' }),
      );
      const result = await registry.execute(
        'workspace.write',
        { path: 'config.json', content: '{bad' },
        { agentId: 'crowclaw', sessionId: 'write-validate-4' },
      );
      expect(result.ok).toBe(true);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta.syntaxWarning).toBeUndefined();
      expect(meta.validatedAs).toBeUndefined();
      expect(meta.postWriteValidation).toBeUndefined();
    });

    it('valid JSON: no warning metadata', async () => {
      const store = new InMemoryWorkspaceStore();
      const registry = new ToolRegistry().register(
        createWorkspaceWriteTool(store, { postWriteValidation: 'block' }),
      );
      const result = await registry.execute(
        'workspace.write',
        { path: 'config.json', content: '{"a":1}' },
        { agentId: 'crowclaw', sessionId: 'write-validate-5' },
      );
      expect(result.ok).toBe(true);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta.error).toBeUndefined();
      expect(meta.syntaxWarning).toBeUndefined();
      expect(meta.validatedAs).toBe('json');
    });

    it('non-validated extension: no validation metadata', async () => {
      const store = new InMemoryWorkspaceStore();
      const registry = new ToolRegistry().register(
        createWorkspaceWriteTool(store, { postWriteValidation: 'block' }),
      );
      const result = await registry.execute(
        'workspace.write',
        { path: 'README.md', content: '# Hi' },
        { agentId: 'crowclaw', sessionId: 'write-validate-6' },
      );
      expect(result.ok).toBe(true);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta.validatedAs).toBeUndefined();
    });

    it('python write integrates with validator (passes when python3 installed)', async () => {
      // We don't try to stub child_process here — the ESM cp module is
      // frozen and monkey-patching `spawn` throws. The `validatePython`
      // unit test above already covers the graceful-degrade branch by
      // calling the validator directly. Here we just confirm the
      // workspace.write surface plays nicely with it: valid Python should
      // not raise, and skipping (when python3 is absent) should not flip
      // the envelope to ok:false.
      const store = new InMemoryWorkspaceStore();
      const registry = new ToolRegistry().register(
        createWorkspaceWriteTool(store, { postWriteValidation: 'block' }),
      );
      const result = await registry.execute(
        'workspace.write',
        { path: 'script.py', content: 'def add(a, b):\n    return a + b\n' },
        { agentId: 'crowclaw', sessionId: 'write-validate-7' },
      );
      expect(result.ok).toBe(true);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta.validatedAs).toBe('python');
    });
  });
});
