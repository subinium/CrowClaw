import { describe, expect, it } from 'vitest';
import { parseIdentity, buildPersonaPrompt, loadPersonaFiles, getDefaultPersonaPrompt, buildSystemPrompt } from '@crowclaw/core';

describe('persona', () => {
  describe('parseIdentity', () => {
    it('extracts all fields from IDENTITY.md content', () => {
      const content = [
        '# IDENTITY.md — Who Am I?',
        '',
        '- **Name:** CrowClaw',
        '- **Type:** AI agent framework',
        '- **Vibe:** Sharp, efficient, resourceful — like a crow',
        '- **Emoji:** 🐦‍⬛',
        '- **Version:** 0.1.0',
      ].join('\n');

      const config = parseIdentity(content);
      expect(config.name).toBe('CrowClaw');
      expect(config.type).toBe('AI agent framework');
      expect(config.vibe).toBe('Sharp, efficient, resourceful — like a crow');
      expect(config.emoji).toBe('🐦‍⬛');
      expect(config.version).toBe('0.1.0');
    });

    it('returns empty config for content with no matching fields', () => {
      const config = parseIdentity('# Just a heading\nSome text.');
      expect(config).toEqual({});
    });

    it('handles partial fields', () => {
      const content = '- **Name:** TestBot\n- **Version:** 2.0';
      const config = parseIdentity(content);
      expect(config.name).toBe('TestBot');
      expect(config.version).toBe('2.0');
      expect(config.type).toBeUndefined();
      expect(config.vibe).toBeUndefined();
      expect(config.emoji).toBeUndefined();
    });
  });

  describe('buildPersonaPrompt', () => {
    it('creates correct XML sections from persona files', () => {
      const prompt = buildPersonaPrompt({
        identity: '- **Name:** CrowClaw',
        soul: '## Core Values\n- Be helpful',
        agents: '## Tool Usage\n- Use tools',
        user: '- **Name:** Alice',
      });

      expect(prompt).toContain('<persona-identity>');
      expect(prompt).toContain('- **Name:** CrowClaw');
      expect(prompt).toContain('</persona-identity>');

      expect(prompt).toContain('<persona-soul>');
      expect(prompt).toContain('## Core Values');
      expect(prompt).toContain('</persona-soul>');

      expect(prompt).toContain('<persona-procedures>');
      expect(prompt).toContain('## Tool Usage');
      expect(prompt).toContain('</persona-procedures>');

      expect(prompt).toContain('<persona-user>');
      expect(prompt).toContain('- **Name:** Alice');
      expect(prompt).toContain('</persona-user>');
    });

    it('orders sections as identity, soul, procedures, user', () => {
      const prompt = buildPersonaPrompt({
        identity: 'ID',
        soul: 'SOUL',
        agents: 'AGENTS',
        user: 'USER',
      });

      const identityIdx = prompt.indexOf('<persona-identity>');
      const soulIdx = prompt.indexOf('<persona-soul>');
      const proceduresIdx = prompt.indexOf('<persona-procedures>');
      const userIdx = prompt.indexOf('<persona-user>');

      expect(identityIdx).toBeLessThan(soulIdx);
      expect(soulIdx).toBeLessThan(proceduresIdx);
      expect(proceduresIdx).toBeLessThan(userIdx);
    });

    it('skips missing files', () => {
      const prompt = buildPersonaPrompt({ soul: '## Values' });
      expect(prompt).toContain('<persona-soul>');
      expect(prompt).not.toContain('<persona-identity>');
      expect(prompt).not.toContain('<persona-procedures>');
      expect(prompt).not.toContain('<persona-user>');
    });

    it('returns empty string when no files provided', () => {
      const prompt = buildPersonaPrompt({});
      expect(prompt).toBe('');
    });
  });

  describe('loadPersonaFiles', () => {
    it('loads existing files and skips missing ones', async () => {
      const mockFs = {
        readFile: async (path: string) => {
          if (path === '/persona/SOUL.md') return '## Core Values';
          if (path === '/persona/IDENTITY.md') return '- **Name:** CrowClaw';
          throw new Error('File not found');
        },
        joinPath: (...parts: string[]) => parts.join('/'),
      };

      const files = await loadPersonaFiles('/persona', mockFs);
      expect(files.soul).toBe('## Core Values');
      expect(files.identity).toBe('- **Name:** CrowClaw');
      expect(files.agents).toBeUndefined();
      expect(files.user).toBeUndefined();
    });

    it('returns empty object when all files are missing', async () => {
      const mockFs = {
        readFile: async () => { throw new Error('Not found'); },
        joinPath: (...parts: string[]) => parts.join('/'),
      };

      const files = await loadPersonaFiles('/persona', mockFs);
      expect(files).toEqual({});
    });

    it('loads all four files when they exist', async () => {
      const mockFs = {
        readFile: async (path: string) => {
          if (path.endsWith('SOUL.md')) return 'soul content';
          if (path.endsWith('IDENTITY.md')) return 'identity content';
          if (path.endsWith('AGENTS.md')) return 'agents content';
          if (path.endsWith('USER.md')) return 'user content';
          throw new Error('Not found');
        },
        joinPath: (...parts: string[]) => parts.join('/'),
      };

      const files = await loadPersonaFiles('/persona', mockFs);
      expect(files.soul).toBe('soul content');
      expect(files.identity).toBe('identity content');
      expect(files.agents).toBe('agents content');
      expect(files.user).toBe('user content');
    });
  });

  describe('getDefaultPersonaPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = getDefaultPersonaPrompt();
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('contains identity and soul sections', () => {
      const prompt = getDefaultPersonaPrompt();
      expect(prompt).toContain('<persona-identity>');
      expect(prompt).toContain('<persona-soul>');
      expect(prompt).toContain('CrowClaw');
    });
  });

  describe('persona prompt injection into system prompt', () => {
    it('persona prompt appears before base prompt', () => {
      const prompt = buildSystemPrompt({
        personaPrompt: '<persona-identity>\n- **Name:** CrowClaw\n</persona-identity>',
        basePrompt: 'You are a helpful assistant.',
        runtimeName: 'node',
      });

      expect(prompt).toBeDefined();
      const personaIdx = prompt!.indexOf('<persona-identity>');
      const baseIdx = prompt!.indexOf('You are a helpful assistant.');
      expect(personaIdx).toBeLessThan(baseIdx);
    });

    it('system prompt works without persona prompt', () => {
      const prompt = buildSystemPrompt({
        basePrompt: 'You are a helpful assistant.',
        runtimeName: 'node',
      });

      expect(prompt).toBeDefined();
      expect(prompt).toContain('You are a helpful assistant.');
      expect(prompt).not.toContain('<persona-');
    });
  });
});
