/**
 * Agent Presets — Identity configurations for different agent personas.
 *
 * This registry is intentionally empty. CrowClaw does not ship hardcoded
 * personas; user-defined personas are managed through `PersonaRegistry`
 * (file-backed) instead. The exports below remain part of the public API
 * surface so consumers can register or look up presets at runtime, but the
 * default registry contains no entries.
 */

export interface AgentPreset {
  name: string;
  role: string;
  goal: string;
  backstory?: string;
  tools?: string[];       // Recommended tool names
  model?: string;         // Suggested model
}

export const agentPresets: Record<string, AgentPreset> = {};

export function getAgentPreset(name: string): AgentPreset | undefined {
  return agentPresets[name];
}

export function listAgentPresets(): AgentPreset[] {
  return Object.values(agentPresets);
}

export function listAgentPresetNames(): string[] {
  return Object.keys(agentPresets);
}
