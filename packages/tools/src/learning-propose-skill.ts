/**
 * `learning.proposeSkill` tool (v0.8.0 #238).
 *
 * Lets the agent itself author a new skill draft from a recurring task pattern.
 * The result is a SKILL.md written to `<draftDir>/<slug>.md` (default
 * `~/.crowclaw/skills/draft/`) with status implicitly `draft` — the dashboard's
 * Drafts tab is responsible for promoting / editing / rejecting it.
 *
 * Emits `learning:agent_proposed { sessionId, slug, name }` if an EventBus is
 * provided.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolDefinition } from '@crowclaw/core';
import { renderSkillFile, type SkillManifest } from '@crowclaw/core';

export interface LearningProposeSkillEventBus {
  emit(type: string, data: Record<string, unknown>): void;
}

export interface LearningProposeSkillToolOptions {
  /** Where to write the draft SKILL.md. Default: ~/.crowclaw/skills/draft */
  draftDir?: string;
  /** EventBus for live dashboard updates. */
  eventBus?: LearningProposeSkillEventBus;
}

const SLUG_RE = /[^a-z0-9-]+/g;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(SLUG_RE, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function createLearningProposeSkillTool(
  options: LearningProposeSkillToolOptions = {},
): ToolDefinition {
  const draftDir = options.draftDir ?? path.join(os.homedir(), '.crowclaw', 'skills', 'draft');

  return {
    manifest: {
      name: 'learning.proposeSkill',
      description:
        "Propose a new skill from a recurring task pattern. The skill becomes a draft pending review. Call this after solving a non-trivial multi-step task you might want to repeat.",
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      safety: 'idempotent',
      inputSchema: {
        type: 'object',
        required: ['name', 'description', 'triggers', 'instructions'],
        properties: {
          name: { type: 'string', description: 'Human-readable skill name (becomes the slug).' },
          description: { type: 'string', description: 'One-sentence summary of what the skill does.' },
          triggers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Phrases the user is likely to type to invoke this skill next time.',
          },
          instructions: {
            type: 'string',
            description: 'Actionable, tool-specific instructions the agent should follow.',
          },
          requires: {
            type: 'object',
            description: 'Optional activation gates: { tools?: string[], env?: string[], bins?: string[] }.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for categorization (becomes the SKILL.md category).',
          },
        },
      },
    },
    async execute(input, ctx) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      const triggers = Array.isArray(input.triggers)
        ? input.triggers.map(String).map((s) => s.trim()).filter(Boolean)
        : [];
      const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : '';

      if (!name) {
        return { toolName: 'learning.proposeSkill', runtime: 'worker', ok: false, output: 'Missing required field: name.' };
      }
      if (!description) {
        return { toolName: 'learning.proposeSkill', runtime: 'worker', ok: false, output: 'Missing required field: description.' };
      }
      if (!instructions) {
        return { toolName: 'learning.proposeSkill', runtime: 'worker', ok: false, output: 'Missing required field: instructions.' };
      }
      if (triggers.length === 0) {
        return { toolName: 'learning.proposeSkill', runtime: 'worker', ok: false, output: 'At least one trigger phrase is required.' };
      }

      const slug = slugify(name);
      if (!slug) {
        return { toolName: 'learning.proposeSkill', runtime: 'worker', ok: false, output: `Skill name '${name}' produced an empty slug after sanitization.` };
      }

      const requires = input.requires && typeof input.requires === 'object'
        ? (input.requires as SkillManifest['requires'])
        : undefined;
      const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
      const category = tags.length > 0 ? tags[0] : 'agent-proposed';

      const manifest: SkillManifest = {
        name: slug,
        description,
        triggers,
        category,
        ...(requires ? { requires } : {}),
      };

      const skillMarkdown = renderSkillFile(manifest, instructions);
      try {
        await fs.promises.mkdir(draftDir, { recursive: true });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { toolName: 'learning.proposeSkill', runtime: 'worker', ok: false, output: `Failed to create draft directory: ${msg}` };
      }

      const filePath = path.join(draftDir, `${slug}.md`);
      try {
        await fs.promises.writeFile(filePath, skillMarkdown, 'utf-8');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { toolName: 'learning.proposeSkill', runtime: 'worker', ok: false, output: `Failed to write draft skill: ${msg}` };
      }

      options.eventBus?.emit('learning:agent_proposed', {
        sessionId: ctx.sessionId,
        slug,
        name,
        filePath,
      });

      return {
        toolName: 'learning.proposeSkill',
        runtime: 'worker',
        ok: true,
        output: `Skill draft written: ${slug}. Pending user review.`,
        metadata: { slug, name, filePath, triggers, tags },
      };
    },
  };
}
