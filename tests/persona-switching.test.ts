import { describe, it, expect } from 'vitest';
import {
  PersonaRegistry,
  scanPersonaDirectories,
  parseIdentity,
  buildPersonaPrompt,
  type PersonaFiles,
  type PersonaProfile,
} from '@crowclaw/core';
import { builtInCliSlashCommands, renderCliHelp } from '@crowclaw/cli';

// ---------------------------------------------------------------------------
// PersonaRegistry
// ---------------------------------------------------------------------------

describe('PersonaRegistry', () => {
  it('has a default persona on construction', () => {
    const registry = new PersonaRegistry();
    const active = registry.getActive();
    expect(active.name).toBe('default');
    expect(active.prompt.length).toBeGreaterThan(0);
    expect(active.files.identity).toBeDefined();
    expect(active.files.soul).toBeDefined();
  });

  it('list() returns default as active', () => {
    const registry = new PersonaRegistry();
    const list = registry.list();
    expect(list).toEqual([{ name: 'default', active: true }]);
  });

  it('register() adds a new persona with pre-built prompt', () => {
    const registry = new PersonaRegistry();
    const files: PersonaFiles = {
      identity: '- **Name:** Creative\n- **Type:** Creative Writer\n- **Vibe:** Imaginative',
      soul: '## Core Values\n- Be creative',
    };
    registry.register('creative', files);

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.name === 'creative')).toEqual({ name: 'creative', active: false });
  });

  it('registerRaw() adds a persona from raw strings', () => {
    const registry = new PersonaRegistry();
    registry.registerRaw('researcher', '## Values\n- Be thorough', '- **Name:** Researcher');

    const list = registry.list();
    const entry = list.find((p) => p.name === 'researcher');
    expect(entry).toBeDefined();
    expect(entry!.active).toBe(false);
  });

  it('registerRaw() with optional agents and user', () => {
    const registry = new PersonaRegistry();
    registry.registerRaw('full', '## Soul', '- **Name:** Full', '## Agents', '## User');

    const profile = registry.switchTo('full');
    expect(profile.files.agents).toBe('## Agents');
    expect(profile.files.user).toBe('## User');
    expect(profile.prompt).toContain('<persona-procedures>');
    expect(profile.prompt).toContain('<persona-user>');
  });

  it('switchTo() changes active persona and returns profile', () => {
    const registry = new PersonaRegistry();
    registry.register('creative', {
      identity: '- **Name:** Creative',
      soul: '## Be creative',
    });

    const profile = registry.switchTo('creative');
    expect(profile.name).toBe('creative');
    expect(registry.getActive().name).toBe('creative');

    const list = registry.list();
    expect(list.find((p) => p.name === 'creative')!.active).toBe(true);
    expect(list.find((p) => p.name === 'default')!.active).toBe(false);
  });

  it('switchTo() throws for non-existent persona', () => {
    const registry = new PersonaRegistry();
    expect(() => registry.switchTo('nonexistent')).toThrow('Persona "nonexistent" is not registered');
  });

  it('getActive() returns the current active profile', () => {
    const registry = new PersonaRegistry();
    registry.register('alt', { identity: '- **Name:** Alt' });
    registry.switchTo('alt');

    const active = registry.getActive();
    expect(active.name).toBe('alt');
    expect(active.files.identity).toBe('- **Name:** Alt');
  });

  it('remove() deletes a persona', () => {
    const registry = new PersonaRegistry();
    registry.register('temp', { soul: '## Temp' });
    expect(registry.list()).toHaveLength(2);

    registry.remove('temp');
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe('default');
  });

  it('remove() throws when trying to remove the active persona', () => {
    const registry = new PersonaRegistry();
    expect(() => registry.remove('default')).toThrow('Cannot remove the active persona');
  });

  it('remove() is a no-op for non-existent persona (Map.delete behavior)', () => {
    const registry = new PersonaRegistry();
    registry.remove('nonexistent'); // should not throw
    expect(registry.list()).toHaveLength(1);
  });

  it('persona prompt is pre-computed on register', () => {
    const registry = new PersonaRegistry();
    const files: PersonaFiles = {
      identity: '- **Name:** TestBot',
      soul: '## Core\n- Be cool',
    };
    registry.register('test', files);

    const profile = registry.switchTo('test');
    const expectedPrompt = buildPersonaPrompt(files);
    expect(profile.prompt).toBe(expectedPrompt);
  });

  it('register overwrites existing persona', () => {
    const registry = new PersonaRegistry();
    registry.register('test', { identity: '- **Name:** V1' });
    registry.register('test', { identity: '- **Name:** V2' });

    const list = registry.list();
    expect(list.filter((p) => p.name === 'test')).toHaveLength(1);

    registry.switchTo('test');
    expect(registry.getActive().files.identity).toBe('- **Name:** V2');
  });

  it('switching back to default works', () => {
    const registry = new PersonaRegistry();
    registry.register('alt', { soul: '## Alt' });
    registry.switchTo('alt');
    expect(registry.getActive().name).toBe('alt');

    registry.switchTo('default');
    expect(registry.getActive().name).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// scanPersonaDirectories
// ---------------------------------------------------------------------------

describe('scanPersonaDirectories', () => {
  it('scans subdirectories and loads persona files', async () => {
    const mockFiles: Record<string, string> = {
      '/personas/creative/SOUL.md': '## Be creative',
      '/personas/creative/IDENTITY.md': '- **Name:** Creative',
      '/personas/researcher/SOUL.md': '## Be thorough',
      '/personas/researcher/IDENTITY.md': '- **Name:** Researcher',
      '/personas/researcher/AGENTS.md': '## Research procedures',
    };

    const readFile = async (path: string) => {
      if (mockFiles[path]) return mockFiles[path];
      throw new Error('File not found: ' + path);
    };

    const listDirs = async () => ['creative', 'researcher'];

    const result = await scanPersonaDirectories('/personas', readFile, listDirs);

    expect(result.size).toBe(2);

    const creative = result.get('creative');
    expect(creative).toBeDefined();
    expect(creative!.soul).toBe('## Be creative');
    expect(creative!.identity).toBe('- **Name:** Creative');
    expect(creative!.agents).toBeUndefined();

    const researcher = result.get('researcher');
    expect(researcher).toBeDefined();
    expect(researcher!.soul).toBe('## Be thorough');
    expect(researcher!.identity).toBe('- **Name:** Researcher');
    expect(researcher!.agents).toBe('## Research procedures');
  });

  it('skips empty directories (no persona files)', async () => {
    const readFile = async () => {
      throw new Error('Not found');
    };
    const listDirs = async () => ['empty-dir'];

    const result = await scanPersonaDirectories('/personas', readFile, listDirs);
    expect(result.size).toBe(0);
  });

  it('returns empty map when no listDirs provided', async () => {
    const readFile = async () => 'content';
    const result = await scanPersonaDirectories('/personas', readFile);
    expect(result.size).toBe(0);
  });

  it('handles directories with only one file', async () => {
    const readFile = async (path: string) => {
      if (path === '/personas/minimal/SOUL.md') return '## Minimal soul';
      throw new Error('Not found');
    };
    const listDirs = async () => ['minimal'];

    const result = await scanPersonaDirectories('/personas', readFile, listDirs);
    expect(result.size).toBe(1);
    const minimal = result.get('minimal');
    expect(minimal!.soul).toBe('## Minimal soul');
    expect(minimal!.identity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLI persona commands
// ---------------------------------------------------------------------------

describe('CLI persona commands', () => {
  it('includes /persona in built-in slash commands', () => {
    expect(builtInCliSlashCommands).toContain('/persona');
  });

  it('includes /persona list in built-in slash commands', () => {
    expect(builtInCliSlashCommands).toContain('/persona list');
  });

  it('includes /persona switch in built-in slash commands', () => {
    expect(builtInCliSlashCommands).toContain('/persona switch');
  });

  it('help text mentions persona commands', () => {
    const help = renderCliHelp();
    expect(help).toContain('/persona');
    expect(help).toContain('Show active persona info');
    expect(help).toContain('/persona list');
    expect(help).toContain('/persona switch');
  });
});

// ---------------------------------------------------------------------------
// API endpoint response shapes
// ---------------------------------------------------------------------------

describe('Persona API response shapes', () => {
  it('GET /api/personas returns expected shape', () => {
    const registry = new PersonaRegistry();
    const response = { personas: registry.list() };
    expect(response.personas).toBeInstanceOf(Array);
    expect(response.personas[0]).toHaveProperty('name');
    expect(response.personas[0]).toHaveProperty('active');
  });

  it('GET /api/persona/active returns expected shape', () => {
    const registry = new PersonaRegistry();
    const active = registry.getActive();
    const identity = active.files.identity ? parseIdentity(active.files.identity) : {};
    const response = { name: active.name, identity };
    expect(response).toHaveProperty('name');
    expect(response.name).toBe('default');
    expect(response).toHaveProperty('identity');
    expect(response.identity).toHaveProperty('name');
  });

  it('POST /api/persona/switch returns expected shape on success', () => {
    const registry = new PersonaRegistry();
    registry.register('alt', { identity: '- **Name:** Alt' });
    const profile = registry.switchTo('alt');
    const response = { ok: true, active: profile.name };
    expect(response.ok).toBe(true);
    expect(response.active).toBe('alt');
  });

  it('POST /api/persona/switch returns error shape for unknown persona', () => {
    const registry = new PersonaRegistry();
    let errorMsg = '';
    try {
      registry.switchTo('unknown');
    } catch (err: unknown) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    const response = { ok: false, error: errorMsg };
    expect(response.ok).toBe(false);
    expect(response.error).toContain('not registered');
  });
});
