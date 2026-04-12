import type { ConversationMessage } from '@crowclaw/core';
import type { StoredSkillDraft } from './index.js';

export interface SkillExtractionProvider {
  /** Ask LLM to extract a structured skill from conversation */
  extractSkill(messages: ConversationMessage[]): Promise<StoredSkillDraft | null>;
  /** Ask LLM to refine/merge an existing skill with new insights */
  refineSkill(existing: StoredSkillDraft, newMessages: ConversationMessage[]): Promise<StoredSkillDraft>;
}

/** Build extraction prompt for LLM */
export function buildExtractionPrompt(messages: ConversationMessage[]): string {
  const conversationText = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n');

  return `You are a skill extraction assistant. Analyze the following conversation and extract a reusable skill.

Output a single JSON object with these fields:
- slug: a kebab-case identifier (e.g. "deploy-to-vercel")
- title: a short human-readable title
- summary: a 1-2 sentence description of what the skill does
- triggerPhrases: an array of phrases a user might say to invoke this skill
- steps: an array of step-by-step instructions to complete the task
- pitfalls: an array of common mistakes or things to watch out for
- verificationSteps: an array of steps to verify the task was completed correctly

If the conversation does not contain a clear, reusable skill, output exactly: null

Conversation:
${conversationText}

Respond with ONLY the JSON (no markdown fences, no explanation).`;
}

/** Build refinement prompt for LLM */
export function buildRefinementPrompt(
  existing: StoredSkillDraft,
  newMessages: ConversationMessage[],
): string {
  const conversationText = newMessages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n');

  const existingJson = JSON.stringify(
    {
      slug: existing.slug,
      title: existing.title,
      summary: existing.summary,
      triggerPhrases: existing.triggerPhrases,
      steps: existing.steps,
      pitfalls: existing.pitfalls ?? [],
      verificationSteps: existing.verificationSteps ?? [],
    },
    null,
    2,
  );

  return `You are a skill refinement assistant. You have an existing skill and a new conversation that may contain improvements or additional insights.

Merge the new information into the existing skill. Preserve all valid existing content while adding new trigger phrases, steps, pitfalls, or verification steps from the conversation. Deduplicate entries. Improve the summary if the new conversation provides better context.

Existing skill:
${existingJson}

New conversation:
${conversationText}

Output the updated skill as a single JSON object with the same fields (slug, title, summary, triggerPhrases, steps, pitfalls, verificationSteps). Respond with ONLY the JSON (no markdown fences, no explanation).`;
}

interface SkillResponsePayload {
  slug: string;
  title: string;
  summary: string;
  triggerPhrases: string[];
  steps: string[];
  pitfalls?: string[];
  verificationSteps?: string[];
}

function isValidPayload(value: unknown): value is SkillResponsePayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.slug === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.summary === 'string' &&
    Array.isArray(obj.triggerPhrases) &&
    Array.isArray(obj.steps)
  );
}

/** Parse LLM response into StoredSkillDraft */
export function parseSkillResponse(response: string): StoredSkillDraft | null {
  const trimmed = response.trim();

  // Handle explicit null
  if (trimmed === 'null') return null;

  // Try to extract JSON — could be raw or wrapped in markdown code fences
  let jsonStr = trimmed;

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(jsonStr);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }

  // Handle null inside fences
  if (jsonStr === 'null') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!isValidPayload(parsed)) return null;

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    slug: parsed.slug,
    title: parsed.title,
    summary: parsed.summary,
    triggerPhrases: parsed.triggerPhrases.filter((p): p is string => typeof p === 'string'),
    steps: parsed.steps.filter((s): s is string => typeof s === 'string'),
    pitfalls: Array.isArray(parsed.pitfalls)
      ? parsed.pitfalls.filter((p): p is string => typeof p === 'string')
      : [],
    verificationSteps: Array.isArray(parsed.verificationSteps)
      ? parsed.verificationSteps.filter((v): v is string => typeof v === 'string')
      : [],
    sourceMessages: 0,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    markdown: '',
    version: 1,
    ratings: { helpful: 0, unhelpful: 0 },
  };
}

/** Simple LLM-backed extraction provider */
export function createLlmSkillExtractor(
  callLlm: (prompt: string) => Promise<string>,
): SkillExtractionProvider {
  return {
    async extractSkill(messages: ConversationMessage[]): Promise<StoredSkillDraft | null> {
      const prompt = buildExtractionPrompt(messages);
      const response = await callLlm(prompt);
      const draft = parseSkillResponse(response);
      if (draft) {
        draft.sourceMessages = messages.length;
        draft.markdown = buildSkillMarkdown(draft);
      }
      return draft;
    },

    async refineSkill(
      existing: StoredSkillDraft,
      newMessages: ConversationMessage[],
    ): Promise<StoredSkillDraft> {
      const prompt = buildRefinementPrompt(existing, newMessages);
      const response = await callLlm(prompt);
      const refined = parseSkillResponse(response);
      if (!refined) {
        // If parsing failed, return existing unchanged
        return existing;
      }

      return {
        ...existing,
        slug: refined.slug,
        title: refined.title,
        summary: refined.summary,
        triggerPhrases: refined.triggerPhrases,
        steps: refined.steps,
        pitfalls: refined.pitfalls,
        verificationSteps: refined.verificationSteps,
        sourceMessages: existing.sourceMessages + newMessages.length,
        version: (existing.version ?? 1) + 1,
        updatedAt: new Date().toISOString(),
        markdown: buildSkillMarkdown(refined),
      };
    },
  };
}

function buildSkillMarkdown(draft: StoredSkillDraft): string {
  const sections: string[] = [
    `# ${draft.title}`,
    '',
    `Slug: ${draft.slug}`,
    '',
    '## Summary',
    draft.summary,
    '',
    '## Trigger phrases',
    ...draft.triggerPhrases.map((phrase) => `- ${phrase}`),
    '',
    '## Steps',
    ...draft.steps.map((step, index) => `${index + 1}. ${step}`),
  ];

  if (draft.pitfalls && draft.pitfalls.length > 0) {
    sections.push('', '## Pitfalls', ...draft.pitfalls.map((p) => `- ${p}`));
  }

  if (draft.verificationSteps && draft.verificationSteps.length > 0) {
    sections.push(
      '',
      '## Verification',
      ...draft.verificationSteps.map((v, i) => `${i + 1}. ${v}`),
    );
  }

  sections.push('', `Source messages: ${draft.sourceMessages}`);

  return sections.join('\n');
}
