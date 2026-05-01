import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  agentPresets,
  getAgentPreset,
  listAgentPresets,
  listAgentPresetNames,
  type AgentPreset,
} from '../packages/core/src/agent-presets.js';

describe('Agent Presets', () => {
  it('default registry is empty', () => {
    expect(agentPresets).toEqual({});
    expect(listAgentPresets()).toEqual([]);
    expect(listAgentPresetNames()).toEqual([]);
  });

  it('getAgentPreset returns undefined for any name when registry is empty', () => {
    expect(getAgentPreset('coding-assistant')).toBeUndefined();
    expect(getAgentPreset('nonexistent')).toBeUndefined();
  });

  it('listAgentPresets returns an array', () => {
    const presets = listAgentPresets();
    expect(Array.isArray(presets)).toBe(true);
    expect(presets).toHaveLength(0);
  });

  it('listAgentPresetNames returns an array', () => {
    const names = listAgentPresetNames();
    expect(Array.isArray(names)).toBe(true);
    expect(names).toHaveLength(0);
  });

  it('AgentPreset interface accepts the documented fields', () => {
    const preset: AgentPreset = {
      name: 'Test Persona',
      role: 'tester',
      goal: 'verify the type surface',
      backstory: 'optional backstory',
      tools: ['terminal.exec'],
      model: 'claude-opus',
    };
    expect(preset.name).toBe('Test Persona');
    expect(preset.role).toBe('tester');
    expect(preset.goal).toBe('verify the type surface');
    expect(preset.backstory).toBe('optional backstory');
    expect(preset.tools).toEqual(['terminal.exec']);
    expect(preset.model).toBe('claude-opus');
  });

  it('AgentPreset interface no longer exposes systemPromptExtra', () => {
    // systemPromptExtra was removed (had no readers). Confirm it is not part
    // of the public type surface.
    expectTypeOf<AgentPreset>().not.toHaveProperty('systemPromptExtra');
  });

  it('public API surface still works for runtime registration', () => {
    // Consumers may add entries at runtime; verify the API behaves correctly
    // when entries exist, then clean up so the registry stays empty.
    const key = '__test-runtime-preset__';
    agentPresets[key] = {
      name: 'Runtime Preset',
      role: 'runtime tester',
      goal: 'confirm the registry is mutable',
    };
    try {
      const found = getAgentPreset(key);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Runtime Preset');
      expect(listAgentPresetNames()).toContain(key);
      expect(listAgentPresets().map((p) => p.name)).toContain('Runtime Preset');
    } finally {
      delete agentPresets[key];
    }
    expect(getAgentPreset(key)).toBeUndefined();
    expect(listAgentPresets()).toHaveLength(0);
  });
});
