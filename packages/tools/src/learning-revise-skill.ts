/**
 * `learning.reviseSkill` tool (v0.8.0 #238).
 *
 * Lets the agent refine an existing skill's instructions in place. Useful when
 * an existing skill almost matched the current task but needed a tweak —
 * appending a clarification beats rewriting from scratch.
 *
 * Looks up the SKILL.md by slug in any of the configured skill directories,
 * applies the delta (`append` or `replace`), and writes back. Emits
 * `learning:skill_revised { slug, mode }` if an EventBus is provided.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolDefinition } from '@crowclaw/core';
import { parseSkillFile, renderSkillFile } from '@crowclaw/core';

export interface LearningReviseSkillEventBus {
  emit(type: string, data: Record<string, unknown>): void;
}

export interface LearningReviseSkillToolOptions {
  /**
   * Directories to search for an existing SKILL.md. Searched in order; the
   * first match wins. Default: `~/.crowclaw/skills/auto`, `~/.crowclaw/skills/draft`,
   * and `$CROWCLAW_SKILL_DIR` if set.
   */
  skillDirs?: string[];
  /** EventBus for live dashboard updates. */
  eventBus?: LearningReviseSkillEventBus;
}

function defaultSkillDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.crowclaw', 'skills', 'auto'),
    path.join(home, '.crowclaw', 'skills', 'draft'),
  ];
  const envDir = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROWCLAW_SKILL_DIR;
  if (envDir) dirs.push(envDir);
  return dirs;
}

/**
 * Locate a SKILL.md by slug under any of `dirs`. Supports two layouts:
 *  - flat: <dir>/<slug>.md
 *  - nested: <dir>/<slug>/SKILL.md
 */
async function findSkillFile(slug: string, dirs: string[]): Promise<string | null> {
  for (const dir of dirs) {
    const flat = path.join(dir, `${slug}.md`);
    const nested = path.join(dir, slug, 'SKILL.md');
    for (const candidate of [flat, nested]) {
      try {
        await fs.promises.access(candidate);
        return candidate;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

export function createLearningReviseSkillTool(
  options: LearningReviseSkillToolOptions = {},
): ToolDefinition {
  const skillDirs = options.skillDirs ?? defaultSkillDirs();

  return {
    manifest: {
      name: 'learning.reviseSkill',
      description:
        "Revise an existing skill's instructions to incorporate a refinement learned from this turn. Use 'append' to add a clarification, 'replace' to overwrite the body.",
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'medium',
      safety: 'idempotent',
      inputSchema: {
        type: 'object',
        required: ['slug', 'instructionsDelta'],
        properties: {
          slug: { type: 'string', description: 'Slug of the existing skill (e.g. deploy-vercel).' },
          instructionsDelta: {
            type: 'string',
            description: 'New instruction to append (or replace, if mode is "replace").',
          },
          mode: {
            type: 'string',
            enum: ['append', 'replace'],
            description: 'How to apply the delta. Default: append.',
          },
        },
      },
    },
    async execute(input, ctx) {
      const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
      const delta = typeof input.instructionsDelta === 'string' ? input.instructionsDelta : '';
      const mode = input.mode === 'replace' ? 'replace' : 'append';

      if (!slug) {
        return { toolName: 'learning.reviseSkill', runtime: 'worker', ok: false, output: 'Missing required field: slug.' };
      }
      if (!delta.trim()) {
        return { toolName: 'learning.reviseSkill', runtime: 'worker', ok: false, output: 'Missing required field: instructionsDelta.' };
      }

      const filePath = await findSkillFile(slug, skillDirs);
      if (!filePath) {
        return {
          toolName: 'learning.reviseSkill',
          runtime: 'worker',
          ok: false,
          output: `Skill '${slug}' not found in any configured directory: ${skillDirs.join(', ')}`,
        };
      }

      let original: string;
      try {
        original = await fs.promises.readFile(filePath, 'utf-8');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { toolName: 'learning.reviseSkill', runtime: 'worker', ok: false, output: `Failed to read skill file: ${msg}` };
      }

      const parsed = parseSkillFile(original, filePath);
      if (!parsed) {
        return {
          toolName: 'learning.reviseSkill',
          runtime: 'worker',
          ok: false,
          output: `Skill file at ${filePath} could not be parsed (missing or malformed frontmatter).`,
        };
      }

      const nextInstructions = mode === 'replace'
        ? delta.trim()
        : `${parsed.instructions.trim()}\n\n${delta.trim()}`.trim();

      const updated = renderSkillFile(parsed.manifest, nextInstructions);
      try {
        await fs.promises.writeFile(filePath, updated, 'utf-8');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { toolName: 'learning.reviseSkill', runtime: 'worker', ok: false, output: `Failed to write skill file: ${msg}` };
      }

      options.eventBus?.emit('learning:skill_revised', {
        sessionId: ctx.sessionId,
        slug,
        mode,
        filePath,
      });

      return {
        toolName: 'learning.reviseSkill',
        runtime: 'worker',
        ok: true,
        output: `Skill '${slug}' revised (${mode}).`,
        metadata: { slug, mode, filePath },
      };
    },
  };
}
