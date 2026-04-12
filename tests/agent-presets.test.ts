import { describe, it, expect } from 'vitest';
import { agentPresets, getAgentPreset, listAgentPresets, listAgentPresetNames } from '../packages/core/src/agent-presets.js';

describe('Agent Presets', () => {
  it('should have at least 10 presets', () => {
    expect(listAgentPresets().length).toBeGreaterThanOrEqual(10);
  });

  it('should return preset by name', () => {
    const preset = getAgentPreset('coding-assistant');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Coding Assistant');
    expect(preset!.role).toBeTruthy();
    expect(preset!.goal).toBeTruthy();
  });

  it('should return undefined for unknown preset', () => {
    expect(getAgentPreset('nonexistent')).toBeUndefined();
  });

  it('should list all preset names', () => {
    const names = listAgentPresetNames();
    expect(names).toContain('coding-assistant');
    expect(names).toContain('research-agent');
    expect(names).toContain('devops-engineer');
    expect(names).toContain('fullstack-developer');
  });

  it('every preset should have required fields', () => {
    for (const preset of listAgentPresets()) {
      expect(preset.name).toBeTruthy();
      expect(preset.role).toBeTruthy();
      expect(preset.goal).toBeTruthy();
    }
  });

  it('presets with tools should reference valid tool name patterns', () => {
    for (const preset of listAgentPresets()) {
      if (preset.tools) {
        for (const tool of preset.tools) {
          expect(tool).toMatch(/^[a-zA-Z][a-zA-Z0-9.]*$/);
        }
      }
    }
  });
});
