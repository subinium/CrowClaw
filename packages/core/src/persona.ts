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
