export interface PersonaFiles {
  soul?: string;
  identity?: string;
  agents?: string;
  user?: string;
}

export interface PersonaConfig {
  name?: string;
  type?: string;
  vibe?: string;
  emoji?: string;
  version?: string;
}

/** Parse IDENTITY.md into structured config */
export function parseIdentity(content: string): PersonaConfig {
  const config: PersonaConfig = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/\*\*(\w+):\*\*\s*(.+)/);
    if (match) {
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (key === 'name') config.name = value;
      if (key === 'type') config.type = value;
      if (key === 'vibe') config.vibe = value;
      if (key === 'emoji') config.emoji = value;
      if (key === 'version') config.version = value;
    }
  }
  return config;
}

/** Build system prompt section from persona files */
export function buildPersonaPrompt(files: PersonaFiles): string {
  const sections: string[] = [];

  if (files.identity) {
    sections.push(`<persona-identity>\n${files.identity.trim()}\n</persona-identity>`);
  }

  if (files.soul) {
    sections.push(`<persona-soul>\n${files.soul.trim()}\n</persona-soul>`);
  }

  if (files.agents) {
    sections.push(`<persona-procedures>\n${files.agents.trim()}\n</persona-procedures>`);
  }

  if (files.user) {
    sections.push(`<persona-user>\n${files.user.trim()}\n</persona-user>`);
  }

  return sections.join('\n\n');
}

/** Load persona files from a directory using a filesystem interface */
export async function loadPersonaFiles(
  dirPath: string,
  fs: { readFile(path: string): Promise<string>; joinPath(...parts: string[]): string },
): Promise<PersonaFiles> {
  const files: PersonaFiles = {};
  const names: Array<[keyof PersonaFiles, string]> = [
    ['soul', 'SOUL.md'],
    ['identity', 'IDENTITY.md'],
    ['agents', 'AGENTS.md'],
    ['user', 'USER.md'],
  ];

  for (const [key, filename] of names) {
    try {
      files[key] = await fs.readFile(fs.joinPath(dirPath, filename));
    } catch {
      // File doesn't exist — skip
    }
  }

  return files;
}

/** Default persona prompt when no files are configured */
export function getDefaultPersonaPrompt(): string {
  return buildPersonaPrompt({
    identity: '- **Name:** CrowClaw\n- **Type:** AI agent\n- **Vibe:** Sharp, efficient, resourceful',
    soul: '## Core Values\n- Be genuinely helpful\n- Be concise and direct\n- Have opinions when asked\n- Be resourceful before asking',
  });
}

// ---------------------------------------------------------------------------
// Persona Registry — runtime persona switching
// ---------------------------------------------------------------------------

export interface PersonaProfile {
  name: string;
  files: PersonaFiles;
  prompt: string; // pre-built persona prompt
}

export class PersonaRegistry {
  private personas = new Map<string, PersonaProfile>();
  private active = 'default';

  constructor() {
    // Register the default persona on construction
    const defaultFiles: PersonaFiles = {
      identity: '- **Name:** CrowClaw\n- **Type:** AI agent\n- **Vibe:** Sharp, efficient, resourceful',
      soul: '## Core Values\n- Be genuinely helpful\n- Be concise and direct\n- Have opinions when asked\n- Be resourceful before asking',
    };
    this.personas.set('default', {
      name: 'default',
      files: defaultFiles,
      prompt: getDefaultPersonaPrompt(),
    });
  }

  /** Register a persona from a set of PersonaFiles (e.g. loaded from a directory) */
  register(name: string, files: PersonaFiles): void {
    this.personas.set(name, {
      name,
      files,
      prompt: buildPersonaPrompt(files),
    });
  }

  /** Register a persona from raw string fields */
  registerRaw(name: string, soul: string, identity: string, agents?: string, user?: string): void {
    const files: PersonaFiles = { soul, identity, agents, user };
    this.register(name, files);
  }

  /** Switch active persona. Throws if name is not registered. */
  switchTo(name: string): PersonaProfile {
    const profile = this.personas.get(name);
    if (!profile) {
      throw new Error(`Persona "${name}" is not registered`);
    }
    this.active = name;
    return profile;
  }

  /** Get the currently active persona profile */
  getActive(): PersonaProfile {
    return this.personas.get(this.active)!;
  }

  /** List all registered personas with active indicator */
  list(): Array<{ name: string; active: boolean }> {
    return [...this.personas.keys()].map((name) => ({
      name,
      active: name === this.active,
    }));
  }

  /** Remove a persona by name. Cannot remove the currently active persona. */
  remove(name: string): void {
    if (name === this.active) {
      throw new Error(`Cannot remove the active persona "${name}". Switch to another persona first.`);
    }
    this.personas.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Persona directory scanner
// ---------------------------------------------------------------------------

/**
 * Scan a base directory for persona subdirectories.
 * Each subdirectory name becomes the persona name, containing SOUL.md, IDENTITY.md, etc.
 *
 * @param baseDir - The base directory (e.g. ~/.crowclaw/personas/)
 * @param readFile - Async function to read a file's text content
 * @param listDirs - Async function that returns subdirectory names in baseDir
 */
export async function scanPersonaDirectories(
  baseDir: string,
  readFile: (path: string) => Promise<string>,
  listDirs?: (dir: string) => Promise<string[]>,
): Promise<Map<string, PersonaFiles>> {
  const result = new Map<string, PersonaFiles>();

  // If no listDirs provided, caller must provide one for real FS usage.
  // For mock/test usage, listDirs can be omitted if readFile covers known paths.
  if (!listDirs) {
    return result;
  }

  const dirs = await listDirs(baseDir);
  const separator = baseDir.includes('/') ? '/' : '/';

  for (const dirName of dirs) {
    const dirPath = baseDir.endsWith(separator) ? baseDir + dirName : baseDir + separator + dirName;
    const files: PersonaFiles = {};
    const fileNames: Array<[keyof PersonaFiles, string]> = [
      ['soul', 'SOUL.md'],
      ['identity', 'IDENTITY.md'],
      ['agents', 'AGENTS.md'],
      ['user', 'USER.md'],
    ];

    for (const [key, filename] of fileNames) {
      try {
        files[key] = await readFile(dirPath + separator + filename);
      } catch {
        // File doesn't exist — skip
      }
    }

    // Only add if at least one file was loaded
    if (files.soul || files.identity || files.agents || files.user) {
      result.set(dirName, files);
    }
  }

  return result;
}
