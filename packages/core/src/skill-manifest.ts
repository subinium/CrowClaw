/**
 * SKILL.md Manifest Format
 *
 * Skills are Markdown files with YAML frontmatter that the agent reads
 * and follows. No compilation, no SDK — just a text file.
 *
 * Example SKILL.md:
 * ```
 * ---
 * name: deploy-vercel
 * description: Deploy a web app to Vercel
 * triggers:
 *   - deploy to vercel
 *   - vercel deploy
 *   - ship to production
 * tools:
 *   - terminal.exec
 *   - web.fetch
 * ---
 *
 * # Deploy to Vercel
 *
 * ## Steps
 * 1. Verify build passes locally with `npm run build`
 * 2. Check environment variables
 * 3. Run `vercel deploy --prod`
 * 4. Verify the deployment URL
 * ```
 */

export interface SkillManifest {
  name: string;
  description: string;
  triggers: string[];
  tools?: string[];
  category?: string;
  version?: string;
  author?: string;
}

export interface ParsedSkillFile {
  manifest: SkillManifest;
  instructions: string; // The markdown body (after frontmatter)
  raw: string; // Original file content
  filePath?: string;
}

/**
 * Parse a SKILL.md file content into manifest + instructions.
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
  const manifest = parseSimpleYaml(yamlBlock);
  if (!manifest.name) return null;

  return {
    manifest: {
      name: manifest.name as string,
      description: (manifest.description as string) ?? '',
      triggers: Array.isArray(manifest.triggers)
        ? (manifest.triggers as string[])
        : [],
      tools: Array.isArray(manifest.tools)
        ? (manifest.tools as string[])
        : undefined,
      category: manifest.category as string | undefined,
      version: manifest.version as string | undefined,
      author: manifest.author as string | undefined,
    },
    instructions,
    raw: content,
    filePath,
  };
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
  if (manifest.triggers.length > 0) {
    lines.push('triggers:');
    for (const t of manifest.triggers) lines.push(`  - ${t}`);
  }
  if (manifest.tools?.length) {
    lines.push('tools:');
    for (const t of manifest.tools) lines.push(`  - ${t}`);
  }
  if (manifest.category) lines.push(`category: ${manifest.category}`);
  if (manifest.version) lines.push(`version: ${manifest.version}`);
  if (manifest.author) lines.push(`author: ${manifest.author}`);
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

// Simple YAML parser for frontmatter (no external dependency)
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item
    if (trimmed.startsWith('- ') && currentKey) {
      if (!currentArray) currentArray = [];
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush previous array
    if (currentArray && currentKey) {
      result[currentKey] = currentArray;
      currentArray = null;
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      currentKey = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();
      if (value) {
        result[currentKey] = value;
        currentKey = null;
      }
      // else: next lines are array items or block
    }
  }

  // Flush final array
  if (currentArray && currentKey) {
    result[currentKey] = currentArray;
  }

  return result;
}
