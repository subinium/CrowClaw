import type { ConversationMessage } from '@crowclaw/core';
import type { MemoryRecord, MemoryStore } from '@crowclaw/storage';

export interface UserProfile {
  expertise: string[];
  preferences: string[];
  interactionCount: number;
  lastSeenAt: string;
}

const PROFILE_SCOPE = 'user' as const;
const PROFILE_TAG = '__user_profile__';

/** Minimum token length to consider as a keyword. */
const MIN_TOKEN_LENGTH = 4;
/** Maximum keywords extracted per conversation update. */
const MAX_KEYWORDS_PER_UPDATE = 20;

/**
 * Technical domain keywords used to detect expertise areas.
 * Matched against lowercased tokens from user messages.
 */
const EXPERTISE_DOMAINS: ReadonlySet<string> = new Set([
  'typescript', 'javascript', 'python', 'rust', 'golang',
  'react', 'nextjs', 'angular', 'svelte', 'vue',
  'docker', 'kubernetes', 'terraform', 'aws', 'gcp', 'azure',
  'postgres', 'mysql', 'redis', 'mongodb', 'sqlite',
  'graphql', 'rest', 'grpc', 'websocket',
  'testing', 'cicd', 'devops', 'security', 'performance',
  'machine', 'learning', 'neural', 'deep', 'nlp',
  'cloudflare', 'vercel', 'supabase', 'firebase',
  'tailwind', 'css', 'html', 'sass',
  'node', 'deno', 'bun',
  'linux', 'macos', 'windows',
  'git', 'github', 'gitlab',
  'api', 'backend', 'frontend', 'fullstack',
  'architecture', 'microservices', 'monolith', 'serverless',
]);

/**
 * Preference indicator words. When found near certain patterns,
 * the surrounding context is extracted as a preference.
 */
const PREFERENCE_INDICATORS: ReadonlySet<string> = new Set([
  'prefer', 'always', 'never', 'like', 'hate',
  'want', 'need', 'avoid', 'use', 'style',
  'convention', 'pattern', 'approach',
]);

function extractTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function extractExpertise(tokens: string[]): string[] {
  return tokens.filter((token) => EXPERTISE_DOMAINS.has(token));
}

function extractPreferences(tokens: string[]): string[] {
  const prefs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (PREFERENCE_INDICATORS.has(tokens[i]!)) {
      // Capture the indicator + up to 3 following tokens as a preference phrase
      const phrase = tokens.slice(i, i + 4).join(' ');
      prefs.push(phrase);
    }
  }
  return prefs;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Builds and maintains a simple user profile from conversation history.
 * Uses keyword extraction (no LLM required) to detect expertise domains
 * and interaction preferences.
 */
export class UserModelService {
  constructor(private readonly memoryStore: MemoryStore) {}

  /** Update user model from conversation messages. */
  async updateFromConversation(
    messages: ConversationMessage[],
    sessionId = 'default',
    scopeKey = 'default-user'
  ): Promise<void> {
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) {
      return;
    }

    const existing = await this.loadProfile(sessionId, scopeKey);

    const allTokens = userMessages
      .flatMap((m) => extractTokens(m.content))
      .slice(0, MAX_KEYWORDS_PER_UPDATE);

    const newExpertise = extractExpertise(allTokens);
    const newPreferences = extractPreferences(allTokens);

    const updated: UserProfile = {
      expertise: uniqueStrings([...existing.expertise, ...newExpertise]),
      preferences: uniqueStrings([...existing.preferences, ...newPreferences]),
      interactionCount: existing.interactionCount + userMessages.length,
      lastSeenAt: new Date().toISOString(),
    };

    const record: MemoryRecord = {
      id: `profile-${scopeKey}`,
      sessionId,
      scope: PROFILE_SCOPE,
      scopeKey,
      summary: JSON.stringify(updated),
      tags: [PROFILE_TAG],
      createdAt: updated.lastSeenAt,
      metadata: { type: 'user_profile' },
    };

    await this.memoryStore.write(record);
  }

  /** Get current user profile. */
  async getProfile(
    sessionId = 'default',
    scopeKey = 'default-user'
  ): Promise<UserProfile> {
    return this.loadProfile(sessionId, scopeKey);
  }

  private async loadProfile(
    _sessionId: string,
    scopeKey: string
  ): Promise<UserProfile> {
    // Fetch multiple records because the same profile may be written across
    // different sessions. Pick the one with the highest interactionCount
    // (i.e., the most up-to-date profile state).
    const records = await this.memoryStore.searchByScope(
      PROFILE_SCOPE,
      PROFILE_TAG,
      20,
      scopeKey
    );

    const defaultProfile: UserProfile = {
      expertise: [],
      preferences: [],
      interactionCount: 0,
      lastSeenAt: '',
    };

    let best: UserProfile = defaultProfile;

    for (const record of records) {
      if (!record.tags.includes(PROFILE_TAG)) {
        continue;
      }
      try {
        const parsed = JSON.parse(record.summary) as UserProfile;
        if (parsed.interactionCount > best.interactionCount) {
          best = parsed;
        }
      } catch {
        // Skip corrupted records
      }
    }

    return best;
  }
}
