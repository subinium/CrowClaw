import type { ToolManifest } from './index.js';
import type { SkillManifest } from './skill-manifest.js';

export interface MatchedSkill {
  name: string;
  description: string;
  instructions: string;
  tools?: string[];
}

export interface PromptBuilderInput {
  basePrompt?: string;
  runtimeName?: string;
  sessionId?: string;
  workspaceId?: string;
  userId?: string;
  availableTools?: ToolManifest[];
  matchedSkills?: MatchedSkill[];
  agentPreset?: { role: string; goal: string; backstory?: string };
  personaPrompt?: string;
}

export function buildSystemPrompt(input: PromptBuilderInput): string | undefined {
  const sections: string[] = [];

  if (input.personaPrompt) {
    sections.push(input.personaPrompt);
  }

  if (input.basePrompt?.trim()) {
    sections.push(input.basePrompt.trim());
  }

  if (input.agentPreset) {
    const identityLines = [
      `Role: ${input.agentPreset.role}`,
      `Goal: ${input.agentPreset.goal}`,
      input.agentPreset.backstory ? `Backstory: ${input.agentPreset.backstory}` : null,
    ].filter(Boolean);
    sections.push(['Agent identity:', ...identityLines].join('\n'));
  }

  if (input.matchedSkills && input.matchedSkills.length > 0) {
    const skillBlocks = input.matchedSkills.slice(0, 3).map((skill) => {
      const toolsAttr = skill.tools?.length ? ` tools="${skill.tools.join(',')}"` : '';
      return `<skill name="${skill.name}"${toolsAttr}>${skill.description}\n${skill.instructions}\n</skill>`;
    });
    sections.push(['Relevant skills:', ...skillBlocks].join('\n'));
  }

  const runtimeLines = [
    input.runtimeName ? `Runtime: ${input.runtimeName}` : null,
    input.sessionId ? `Session: ${input.sessionId}` : null,
    input.workspaceId ? `Workspace: ${input.workspaceId}` : null,
    input.userId ? `User: ${input.userId}` : null
  ].filter(Boolean);

  if (runtimeLines.length > 0) {
    sections.push(['Runtime context:', ...runtimeLines].join('\n'));
  }

  if (input.availableTools && input.availableTools.length > 0) {
    const toolLines = input.availableTools
      .slice(0, 24)
      .map((tool) => `- ${tool.name} (${tool.runtime}, danger:${tool.dangerLevel})`);
    sections.push(['Available tools:', ...toolLines].join('\n'));
  }

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}
