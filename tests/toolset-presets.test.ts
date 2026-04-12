import { describe, it, expect } from 'vitest';
import { TOOLSET_PRESETS, getToolsetPreset, listToolsetPresets, listToolsetPresetNames } from '../packages/tools/src/index.js';

describe('Toolset Presets', () => {
  it('should have at least 8 presets', () => {
    expect(listToolsetPresets().length).toBeGreaterThanOrEqual(8);
  });

  it('should return preset by name', () => {
    const preset = getToolsetPreset('web');
    expect(preset).toBeDefined();
    expect(preset.name).toBe('web');
    expect(preset.description).toBeTruthy();
    expect(preset.toolNames.length).toBeGreaterThan(0);
  });

  it('minimal preset should have only core tools', () => {
    const minimal = getToolsetPreset('minimal');
    expect(minimal.toolNames).toContain('echo');
    expect(minimal.toolNames).toContain('time');
    expect(minimal.toolNames.length).toBeLessThanOrEqual(5);
  });

  it('full preset should have empty toolNames (meaning all)', () => {
    const full = getToolsetPreset('full');
    expect(full.toolNames).toHaveLength(0);
  });

  it('web preset should include web tools', () => {
    const web = getToolsetPreset('web');
    expect(web.toolNames).toContain('web.fetch');
    expect(web.toolNames).toContain('web.search');
  });

  it('every preset should have a description', () => {
    for (const preset of listToolsetPresets()) {
      expect(preset.description).toBeTruthy();
    }
  });

  it('should list all preset names', () => {
    const names = listToolsetPresetNames();
    expect(names).toContain('minimal');
    expect(names).toContain('full');
    expect(names).toContain('web');
    expect(names).toContain('research');
  });
});
