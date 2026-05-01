/**
 * SKILL.md Manifest Format
 *
 * Skills are Markdown files with YAML frontmatter that the agent reads
 * and follows. No compilation, no SDK — just a text file.
 *
 * ----------------------------------------------------------------------------
 * agentskills.io spec compatibility
 * ----------------------------------------------------------------------------
 * Pinned spec version: agentskills.io v1.0 (as of 2026-05-01).
 *
 * The canonical spec page (https://agentskills.io/spec) was not retrievable
 * with confidence at implementation time, so the shape below is derived from:
 *   - the NousResearch/hermes-agent README's references to community skills,
 *   - the SKILL.md examples published by early adopters, and
 *   - the fields the Hermes agent loop documents for activation gating
 *     (platforms, config_requirements, version, license, author, categories).
 *
 * If the official spec drifts, only the parser/defaults below need updating —
 * matchSkillManifests() and the storage layout stay untouched. Treat this
 * file as the single source of truth for what a SKILL.md may contain.
 *
 * Required fields per agentskills.io v1.0:
 *   - name (string, kebab-case slug)
 *   - description (string)
 *   - triggers (string[])
 * Optional fields per agentskills.io v1.0:
 *   - version, author, license, categories, platforms,
 *     config_requirements { env, mcpServers, tools }, updated_at
 *
 * CrowClaw legacy fields kept as a strict superset:
 *   - tools (alias for config_requirements.tools at activation time)
 *   - category (singular — folded into categories[])
 *   - requires { bins, env, tools } (CrowClaw activation gates, not in spec)
 *   - always (force-include flag, not in spec)
 *
 * Example SKILL.md (new format):
 * ```
 * ---
 * name: deploy-vercel
 * description: Deploy a web app to Vercel
 * version: 1.2.0
 * author: ada@example.com
 * license: MIT
 * categories:
 *   - deployment
 *   - web
 * platforms:
 *   - darwin
 *   - linux
 * triggers:
 *   - deploy to vercel
 *   - vercel deploy
 * config_requirements:
 *   env:
 *     - VERCEL_TOKEN
 *   tools:
 *     - terminal.exec
 *     - web.fetch
 * updated_at: 2026-04-12T09:30:00Z
 * ---
 *
 * # Deploy to Vercel
 * ...
 * ```
 */

export interface SkillConfigRequirements {
  /** Environment variables that must be present at activation. */
  env?: string[];
  /** MCP server names the skill expects to be connected. */
  mcpServers?: string[];
  /** Tool names the skill expects to be registered. */
  tools?: string[];
}

export interface SkillManifest {
  // ---- Existing CrowClaw fields (KEEP) ----
  name: string;
  description: string;
  triggers: string[];
  tools?: string[];
  category?: string;
  /** OpenClaw-style activation gates — skill excluded if requirements not met */
  requires?: {
    /** Binary commands that must be available (checked via `which`) */
    bins?: string[];
    /** Environment variables that must be set */
    env?: string[];
    /** Tool names that must be registered */
    tools?: string[];
  };
  /** If true, always include this skill regardless of matching */
  always?: boolean;

  // ---- agentskills.io v1.0 alignment ----
  /** Semantic version, e.g. "1.0.0". Defaults to "0.0.0" for legacy skills. */
  version?: string;
  /** Author name or handle. Optional. */
  author?: string;
  /** SPDX license identifier. Defaults to "UNLICENSED". */
  license?: string;
  /** Categories (multiple) — used for discoverability. */
  categories?: string[];
  /** Platforms this skill expects. Filter at activation: ["darwin","linux","win32"] */
  platforms?: string[];
  /** Configuration the skill expects: env vars, MCP servers, specific tools. */
  config_requirements?: SkillConfigRequirements;
  /** ISO 8601 timestamp of last modification. */
  updated_at?: string;
}

export interface ParsedSkillFile {
  manifest: SkillManifest;
  instructions: string; // The markdown body (after frontmatter)
  raw: string; // Original file content
  filePath?: string;
}

/**
 * Validation outcome from `validateSkillManifest`.
 */
export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a manifest object against the agentskills.io v1.0 shape.
 * Required fields: name, description, triggers (>= 1).
 * Other fields are checked for type sanity if present.
 */
export function validateSkillManifest(
  manifest: Partial<SkillManifest> | null | undefined
): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest is missing or not an object'], warnings };
  }

  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('name is required (string)');
  } else if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(manifest.name)) {
    warnings.push(`name "${manifest.name}" should be a kebab-case slug`);
  }

  if (!manifest.description || typeof manifest.description !== 'string') {
    errors.push('description is required (string)');
  }

  if (!Array.isArray(manifest.triggers) || manifest.triggers.length === 0) {
    errors.push('triggers is required (non-empty string[])');
  }

  if (manifest.version !== undefined && typeof manifest.version !== 'string') {
    errors.push('version must be a string');
  }
  if (manifest.author !== undefined && typeof manifest.author !== 'string') {
    errors.push('author must be a string');
  }
  if (manifest.license !== undefined && typeof manifest.license !== 'string') {
    errors.push('license must be a string');
  }
  if (manifest.categories !== undefined && !Array.isArray(manifest.categories)) {
    errors.push('categories must be a string[]');
  }
  if (manifest.platforms !== undefined && !Array.isArray(manifest.platforms)) {
    errors.push('platforms must be a string[]');
  }
  if (manifest.updated_at !== undefined && typeof manifest.updated_at !== 'string') {
    errors.push('updated_at must be an ISO-8601 string');
  }
  if (manifest.config_requirements !== undefined) {
    const cr = manifest.config_requirements;
    if (typeof cr !== 'object' || cr === null) {
      errors.push('config_requirements must be an object');
    } else {
      if (cr.env !== undefined && !Array.isArray(cr.env)) errors.push('config_requirements.env must be string[]');
      if (cr.mcpServers !== undefined && !Array.isArray(cr.mcpServers)) errors.push('config_requirements.mcpServers must be string[]');
      if (cr.tools !== undefined && !Array.isArray(cr.tools)) errors.push('config_requirements.tools must be string[]');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Parse a SKILL.md file content into manifest + instructions.
 *
 * Accepts BOTH legacy CrowClaw skills (no version/license/etc.) AND new
 * agentskills.io v1.0 skills. Legacy skills receive sensible defaults so
 * downstream consumers can rely on the new fields being populated.
 */
export function parseSkillFile(
  content: string,
  filePath?: string
): ParsedSkillFile | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return null;

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return null;

  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const instructions = trimmed.slice(endIndex + 3).trim();

  // Simple YAML parser (no external dep)
  const yaml = parseSimpleYaml(yamlBlock);
  if (!yaml.name) return null;

  const category = yaml.category as string | undefined;
  const explicitCategories = Array.isArray(yaml.categories)
    ? (yaml.categories as string[])
    : undefined;
  const categories = explicitCategories ?? (category ? [category] : []);

  const configReqRaw = (yaml as Record<string, unknown>).config_requirements;
  const config_requirements = parseConfigRequirements(configReqRaw);

  const requiresRaw = (yaml as Record<string, unknown>).requires;
  const requires = parseRequires(requiresRaw);

  const manifest: SkillManifest = {
    name: yaml.name as string,
    description: (yaml.description as string) ?? '',
    triggers: Array.isArray(yaml.triggers) ? (yaml.triggers as string[]) : [],
    tools: Array.isArray(yaml.tools) ? (yaml.tools as string[]) : undefined,
    category,
    requires,
    always: yaml.always === true || yaml.always === 'true',

    // agentskills.io fields with defaults
    version: (yaml.version as string | undefined) ?? '0.0.0',
    author: yaml.author as string | undefined,
    license: (yaml.license as string | undefined) ?? 'UNLICENSED',
    categories,
    platforms: Array.isArray(yaml.platforms) ? (yaml.platforms as string[]) : undefined,
    config_requirements,
    updated_at: yaml.updated_at as string | undefined,
  };

  return {
    manifest,
    instructions,
    raw: content,
    filePath,
  };
}

function parseConfigRequirements(raw: unknown): SkillConfigRequirements | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: SkillConfigRequirements = {};
  if (Array.isArray(obj.env)) out.env = obj.env as string[];
  if (Array.isArray(obj.mcpServers)) out.mcpServers = obj.mcpServers as string[];
  if (Array.isArray(obj.tools)) out.tools = obj.tools as string[];
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseRequires(raw: unknown): SkillManifest['requires'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: NonNullable<SkillManifest['requires']> = {};
  if (Array.isArray(obj.bins)) out.bins = obj.bins as string[];
  if (Array.isArray(obj.env)) out.env = obj.env as string[];
  if (Array.isArray(obj.tools)) out.tools = obj.tools as string[];
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Render a skill manifest back to SKILL.md format.
 */
export function renderSkillFile(
  manifest: SkillManifest,
  instructions: string
): string {
  const lines = ['---'];
  lines.push(`name: ${manifest.name}`);
  lines.push(`description: ${manifest.description}`);
  if (manifest.version) lines.push(`version: ${manifest.version}`);
  if (manifest.author) lines.push(`author: ${manifest.author}`);
  if (manifest.license) lines.push(`license: ${manifest.license}`);
  if (manifest.triggers.length > 0) {
    lines.push('triggers:');
    for (const t of manifest.triggers) lines.push(`  - ${t}`);
  }
  if (manifest.categories && manifest.categories.length > 0) {
    lines.push('categories:');
    for (const c of manifest.categories) lines.push(`  - ${c}`);
  } else if (manifest.category) {
    lines.push(`category: ${manifest.category}`);
  }
  if (manifest.platforms && manifest.platforms.length > 0) {
    lines.push('platforms:');
    for (const p of manifest.platforms) lines.push(`  - ${p}`);
  }
  if (manifest.tools?.length) {
    lines.push('tools:');
    for (const t of manifest.tools) lines.push(`  - ${t}`);
  }
  if (manifest.config_requirements) {
    lines.push('config_requirements:');
    if (manifest.config_requirements.env?.length) {
      lines.push('  env:');
      for (const e of manifest.config_requirements.env) lines.push(`    - ${e}`);
    }
    if (manifest.config_requirements.mcpServers?.length) {
      lines.push('  mcpServers:');
      for (const m of manifest.config_requirements.mcpServers) lines.push(`    - ${m}`);
    }
    if (manifest.config_requirements.tools?.length) {
      lines.push('  tools:');
      for (const t of manifest.config_requirements.tools) lines.push(`    - ${t}`);
    }
  }
  if (manifest.updated_at) lines.push(`updated_at: ${manifest.updated_at}`);
  lines.push('---');
  lines.push('');
  lines.push(instructions);
  return lines.join('\n');
}

export interface SkillDirectoryEntry {
  name: string;
  isDirectory: boolean;
}

export interface SkillFileSystem {
  readDir(dirPath: string): Promise<SkillDirectoryEntry[]>;
  readFile(filePath: string): Promise<string>;
  joinPath(...segments: string[]): string;
}

/**
 * Load all SKILL.md files from a directory using an injected filesystem.
 * This keeps the core package runtime-agnostic (works in Node, Workers, etc.).
 *
 * UNCHANGED for v0.8.0 — relies on parseSkillFile() which now handles both
 * legacy and agentskills.io v1.0 formats transparently.
 */
export async function loadSkillsFromDirectory(
  dirPath: string,
  fs: SkillFileSystem
): Promise<ParsedSkillFile[]> {
  const skills: ParsedSkillFile[] = [];

  try {
    const entries = await fs.readDir(dirPath);

    for (const entry of entries) {
      if (entry.isDirectory) {
        // Look for SKILL.md inside the directory
        const skillPath = fs.joinPath(dirPath, entry.name, 'SKILL.md');
        try {
          const content = await fs.readFile(skillPath);
          const parsed = parseSkillFile(content, skillPath);
          if (parsed) skills.push(parsed);
        } catch {
          /* no SKILL.md in this dir */
        }
      } else if (entry.name.endsWith('.md') && entry.name !== 'README.md') {
        // Also support flat .md files
        const skillPath = fs.joinPath(dirPath, entry.name);
        const content = await fs.readFile(skillPath);
        const parsed = parseSkillFile(content, skillPath);
        if (parsed) skills.push(parsed);
      }
    }
  } catch {
    /* directory doesn't exist */
  }

  return skills;
}

/**
 * Match a user query against loaded skill manifests.
 *
 * UNCHANGED for v0.8.0 — algorithm is intentionally stable so that adding
 * the agentskills.io fields cannot regress the matching behaviour.
 */
export function matchSkillManifests(
  query: string,
  skills: ParsedSkillFile[],
  limit = 5
): Array<{ skill: ParsedSkillFile; score: number }> {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(Boolean);

  const scored = skills.map((skill) => {
    let score = 0;

    // Trigger phrase match (highest weight)
    for (const trigger of skill.manifest.triggers) {
      if (queryLower.includes(trigger.toLowerCase())) score += 10;
      else if (trigger.toLowerCase().includes(queryLower)) score += 5;
    }

    // Name match
    if (queryLower.includes(skill.manifest.name.toLowerCase())) score += 8;

    // Description word overlap
    const descWords = skill.manifest.description.toLowerCase().split(/\s+/);
    for (const word of queryWords) {
      if (descWords.includes(word)) score += 2;
    }

    // Category match
    if (
      skill.manifest.category &&
      queryLower.includes(skill.manifest.category.toLowerCase())
    )
      score += 3;

    return { skill, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * OpenClaw-style activation gate check, extended for agentskills.io v1.0:
 *  - `requires.env` / `requires.tools` (legacy CrowClaw)
 *  - `config_requirements.env` / `.tools` / `.mcpServers` (spec)
 *  - `platforms` filter against `process.platform` (or override)
 *
 * Returns `{ eligible: false, reason }` when the skill should be skipped.
 * NOTE: missing platform is a *skip*, not an error — community skills
 * targeting only macOS must not crash a Linux runtime.
 */
export function checkSkillGates(
  skill: ParsedSkillFile,
  context: {
    availableToolNames?: string[];
    availableMcpServers?: string[];
    envVars?: Record<string, string | undefined>;
    platform?: string;
  } = {}
): { eligible: boolean; reason?: string } {
  const manifest = skill.manifest;

  // Platform filter (agentskills.io)
  if (manifest.platforms && manifest.platforms.length > 0) {
    // Workers-safe access to Node's process.platform: globalThis lookup avoids
    // a hard reference TS resolves through @types/node, which the core package
    // does not depend on (CF Workers runtime has no `process`).
    const nodeProc = (globalThis as { process?: { platform?: string } }).process;
    const currentPlatform = context.platform ?? nodeProc?.platform ?? '';
    if (currentPlatform && !manifest.platforms.includes(currentPlatform)) {
      return {
        eligible: false,
        reason: `Platform ${currentPlatform} not in skill's supported platforms (${manifest.platforms.join(', ')})`,
      };
    }
  }

  // CrowClaw legacy `requires` block
  const requires = manifest.requires;
  if (requires) {
    if (requires.env && requires.env.length > 0) {
      const env = context.envVars ?? {};
      for (const key of requires.env) {
        if (!env[key]) {
          return { eligible: false, reason: `Missing env var: ${key}` };
        }
      }
    }
    if (requires.tools && requires.tools.length > 0 && context.availableToolNames) {
      for (const tool of requires.tools) {
        if (!context.availableToolNames.includes(tool)) {
          return { eligible: false, reason: `Missing tool: ${tool}` };
        }
      }
    }
  }

  // agentskills.io `config_requirements`
  const cr = manifest.config_requirements;
  if (cr) {
    if (cr.env && cr.env.length > 0) {
      const env = context.envVars ?? {};
      for (const key of cr.env) {
        if (!env[key]) {
          return { eligible: false, reason: `Missing env var (config_requirements): ${key}` };
        }
      }
    }
    if (cr.tools && cr.tools.length > 0 && context.availableToolNames) {
      for (const tool of cr.tools) {
        if (!context.availableToolNames.includes(tool)) {
          return { eligible: false, reason: `Missing tool (config_requirements): ${tool}` };
        }
      }
    }
    if (cr.mcpServers && cr.mcpServers.length > 0 && context.availableMcpServers) {
      for (const server of cr.mcpServers) {
        if (!context.availableMcpServers.includes(server)) {
          return { eligible: false, reason: `Missing MCP server (config_requirements): ${server}` };
        }
      }
    }
  }

  return { eligible: true };
}

/**
 * Filter skills by activation gates and apply token budget.
 * OpenClaw pattern: deterministic ordering + budget guard.
 */
export function filterAndBudgetSkills(
  skills: ParsedSkillFile[],
  options: {
    availableToolNames?: string[];
    availableMcpServers?: string[];
    envVars?: Record<string, string | undefined>;
    platform?: string;
    maxTokenBudget?: number; // approximate max tokens for all skills combined
  } = {}
): ParsedSkillFile[] {
  const maxBudget = options.maxTokenBudget ?? 16000;

  // Filter by activation gates
  const eligible = skills.filter((skill) => {
    const gate = checkSkillGates(skill, options);
    return gate.eligible;
  });

  // Deterministic ordering: always-on first, then by name (prompt caching stability)
  eligible.sort((a, b) => {
    if (a.manifest.always && !b.manifest.always) return -1;
    if (!a.manifest.always && b.manifest.always) return 1;
    return a.manifest.name.localeCompare(b.manifest.name);
  });

  // Token budget guard — estimate ~4 tokens per word
  let usedTokens = 0;
  const budgeted: ParsedSkillFile[] = [];
  for (const skill of eligible) {
    const estimatedTokens = Math.ceil((skill.manifest.name.length + skill.manifest.description.length + skill.instructions.length) / 4);
    if (usedTokens + estimatedTokens > maxBudget && budgeted.length > 0) {
      break; // Stop adding skills when budget exceeded
    }
    usedTokens += estimatedTokens;
    budgeted.push(skill);
  }

  return budgeted;
}

// Simple YAML parser for frontmatter (no external dependency).
//
// Supports:
//   - top-level scalar `key: value`
//   - top-level array `key:` followed by `  - item` lines
//   - one level of nested object via 2-space indent (e.g. config_requirements)
//   - nested array under a nested key via 4-space indent
//
// Limits: no anchors, no flow style, no multi-line scalars. Adequate for
// SKILL.md frontmatter which is intentionally restricted in shape.
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { i++; continue; }

    // Top-level lines have no leading indent
    const indent = line.length - line.replace(/^\s+/, '').length;
    if (indent !== 0) { i++; continue; }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex <= 0) { i++; continue; }

    const key = trimmed.slice(0, colonIndex).trim();
    const inlineValue = trimmed.slice(colonIndex + 1).trim();

    if (inlineValue) {
      // Scalar value on the same line
      result[key] = coerceScalar(inlineValue);
      i++;
      continue;
    }

    // Block — could be array (- items) or nested object (key: value pairs)
    const block: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? '';
      if (next.trim() === '' || next.trim().startsWith('#')) { j++; continue; }
      const nextIndent = next.length - next.replace(/^\s+/, '').length;
      if (nextIndent === 0) break;
      block.push(next);
      j++;
    }

    if (block.length === 0) {
      result[key] = '';
      i = j;
      continue;
    }

    const firstBlockLine = block[0]!.trim();
    if (firstBlockLine.startsWith('- ')) {
      // Array of scalars
      const arr: string[] = [];
      for (const b of block) {
        const t = b.trim();
        if (t.startsWith('- ')) arr.push(t.slice(2).trim());
      }
      result[key] = arr;
    } else {
      // Nested object — parse one more level
      result[key] = parseNestedYaml(block);
    }
    i = j;
  }

  return result;
}

function parseNestedYaml(blockLines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Determine the base indent (smallest non-zero indent in block)
  const baseIndent = blockLines
    .map((l) => l.length - l.replace(/^\s+/, '').length)
    .filter((n) => n > 0)
    .reduce((min, n) => Math.min(min, n), Number.POSITIVE_INFINITY);

  let i = 0;
  while (i < blockLines.length) {
    const line = blockLines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { i++; continue; }
    const indent = line.length - line.replace(/^\s+/, '').length;
    if (indent !== baseIndent) { i++; continue; }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex <= 0) { i++; continue; }
    const key = trimmed.slice(0, colonIndex).trim();
    const inlineValue = trimmed.slice(colonIndex + 1).trim();

    if (inlineValue) {
      result[key] = coerceScalar(inlineValue);
      i++;
      continue;
    }

    // Collect deeper-indented child lines
    const children: string[] = [];
    let j = i + 1;
    while (j < blockLines.length) {
      const next = blockLines[j] ?? '';
      if (next.trim() === '') { j++; continue; }
      const nextIndent = next.length - next.replace(/^\s+/, '').length;
      if (nextIndent <= baseIndent) break;
      children.push(next);
      j++;
    }

    if (children.length > 0 && children[0]!.trim().startsWith('- ')) {
      const arr: string[] = [];
      for (const c of children) {
        const t = c.trim();
        if (t.startsWith('- ')) arr.push(t.slice(2).trim());
      }
      result[key] = arr;
    } else if (children.length > 0) {
      result[key] = parseNestedYaml(children);
    } else {
      result[key] = '';
    }
    i = j;
  }
  return result;
}

function coerceScalar(value: string): unknown {
  // Inline (flow-style) array: `[a, b, c]` — common in agentskills.io fixtures.
  // Parse without external dependency. Quoted items are unwrapped, otherwise
  // raw tokens (no further coercion — agentskills.io scalars are strings).
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => {
      const t = part.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    });
  }
  // Strip wrapping quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  return value;
}
