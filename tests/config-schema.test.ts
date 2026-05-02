import { describe, it, expect } from 'vitest';
import {
  generateConfigSchema,
  validateConfigUpdate,
  diffConfigs,
} from '../packages/runtime-node/src/config-schema.js';
import type {
  FullConfigSchema,
  ConfigSectionSchema,
  ConfigFieldSchema,
} from '../packages/runtime-node/src/config-schema.js';

describe('Config Schema', () => {
  // -------------------------------------------------------------------
  // generateConfigSchema
  // -------------------------------------------------------------------

  describe('generateConfigSchema', () => {
    const schema = generateConfigSchema();

    it('returns all 5 sections', () => {
      expect(schema.sections).toHaveLength(5);
      const ids = schema.sections.map((s) => s.id);
      expect(ids).toContain('agent');
      expect(ids).toContain('security');
      expect(ids).toContain('provider');
      expect(ids).toContain('gateway');
      expect(ids).toContain('presets');
    });

    it('schema version is a semver string', () => {
      expect(schema.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('all sections have label and description', () => {
      for (const section of schema.sections) {
        expect(section.label).toBeTruthy();
        expect(section.description).toBeTruthy();
      }
    });

    it('field labels are human-readable (not camelCase)', () => {
      // Common lowercase words in title case
      const titleCaseExceptions = new Set(['for', 'on', 'of', 'the', 'a', 'an', 'in', 'to', 'or']);

      for (const section of schema.sections) {
        for (const field of section.fields) {
          // Labels should contain spaces (human-readable), not be raw camelCase
          // Exception: single-word labels like "Enabled" or "Description" are fine
          const words = field.label.split(' ');
          for (let i = 0; i < words.length; i++) {
            const word = words[i];
            // First word must be capitalized; rest can be lowercase prepositions
            if (i === 0 || !titleCaseExceptions.has(word.toLowerCase())) {
              expect(word[0]).toBe(word[0].toUpperCase());
            }
          }
          // Should not contain dots (that would be a key, not a label)
          expect(field.label).not.toContain('.');
        }
      }
    });

    // --- Agent section ---

    describe('agent section', () => {
      const section = schema.sections.find((s) => s.id === 'agent') as ConfigSectionSchema;

      it('has correct number of fields', () => {
        expect(section.fields).toHaveLength(5);
      });

      it('maxToolIterations has correct defaults and range', () => {
        const field = section.fields.find((f) => f.key === 'maxToolIterations') as ConfigFieldSchema;
        expect(field.type).toBe('number');
        expect(field.default).toBe(12);
        expect(field.min).toBe(1);
        expect(field.max).toBe(50);
        expect(field.required).toBe(true);
      });

      it('maxToolResultLength has correct range', () => {
        const field = section.fields.find((f) => f.key === 'maxToolResultLength') as ConfigFieldSchema;
        expect(field.type).toBe('number');
        expect(field.min).toBe(100);
        expect(field.max).toBe(100000);
      });

      it('boolean fields have correct types', () => {
        const boolFields = ['concurrentToolCalls', 'synthesizeOnExhaustion', 'requireApprovalForDangerousTools'];
        for (const key of boolFields) {
          const field = section.fields.find((f) => f.key === key) as ConfigFieldSchema;
          expect(field.type).toBe('boolean');
        }
      });
    });

    // --- Security section ---

    describe('security section', () => {
      const section = schema.sections.find((s) => s.id === 'security') as ConfigSectionSchema;

      it('has all boolean fields', () => {
        expect(section.fields.length).toBeGreaterThan(0);
        for (const field of section.fields) {
          expect(field.type).toBe('boolean');
        }
      });

      it('contains all SecurityPolicyConfig fields', () => {
        const keys = section.fields.map((f) => f.key);
        expect(keys).toContain('redactToolOutput');
        expect(keys).toContain('scanUserInput');
        expect(keys).toContain('scanCommands');
        expect(keys).toContain('blockDangerousCommands');
        expect(keys).toContain('piiRedaction');
      });
    });

    // --- Provider section ---

    describe('provider section', () => {
      const section = schema.sections.find((s) => s.id === 'provider') as ConfigSectionSchema;

      it('marks apiKey fields as sensitive', () => {
        const apiKeyFields = section.fields.filter((f) => f.key.endsWith('.apiKey'));
        expect(apiKeyFields.length).toBeGreaterThanOrEqual(1);
        for (const field of apiKeyFields) {
          expect(field.sensitive).toBe(true);
        }
      });

      it('has enum for provider type', () => {
        const providerFields = section.fields.filter((f) => f.key.endsWith('.provider'));
        expect(providerFields.length).toBeGreaterThanOrEqual(1);
        for (const field of providerFields) {
          expect(field.type).toBe('enum');
          expect(field.enum).toContain('openai');
          expect(field.enum).toContain('anthropic');
          expect(field.enum).toContain('openrouter');
          expect(field.enum).toContain('custom');
        }
      });

      it('has slots for primary, fallback, vision, compression, embedding', () => {
        const slotPrefixes = ['primary', 'fallback', 'vision', 'compression', 'embedding'];
        for (const prefix of slotPrefixes) {
          const slotFields = section.fields.filter((f) => f.key.startsWith(`${prefix}.`));
          expect(slotFields.length).toBeGreaterThanOrEqual(3); // at least name, provider, model
        }
      });

      it('primary slot fields are required', () => {
        const primaryName = section.fields.find((f) => f.key === 'primary.name') as ConfigFieldSchema;
        const primaryProvider = section.fields.find((f) => f.key === 'primary.provider') as ConfigFieldSchema;
        const primaryModel = section.fields.find((f) => f.key === 'primary.model') as ConfigFieldSchema;
        expect(primaryName.required).toBe(true);
        expect(primaryProvider.required).toBe(true);
        expect(primaryModel.required).toBe(true);
      });

      it('fallback slot fields are not required', () => {
        const fallbackName = section.fields.find((f) => f.key === 'fallback.name') as ConfigFieldSchema;
        expect(fallbackName.required).toBe(false);
      });
    });

    // --- Gateway section ---

    describe('gateway section', () => {
      const section = schema.sections.find((s) => s.id === 'gateway') as ConfigSectionSchema;

      it('has enum for dmPolicy', () => {
        const field = section.fields.find((f) => f.key === 'dmPolicy') as ConfigFieldSchema;
        expect(field.type).toBe('enum');
        expect(field.enum).toEqual(['pairing', 'allowlist', 'open', 'disabled']);
      });

      it('has enum for groupPolicy', () => {
        const field = section.fields.find((f) => f.key === 'groupPolicy') as ConfigFieldSchema;
        expect(field.type).toBe('enum');
        expect(field.enum).toEqual(['open', 'disabled', 'allowlist']);
      });

      it('has endpoint policy fields', () => {
        const policyTier = section.fields.find((f) => f.key === 'policyTier') as ConfigFieldSchema;
        const allowedEndpoints = section.fields.find((f) => f.key === 'allowedEndpoints') as ConfigFieldSchema;
        expect(policyTier.type).toBe('enum');
        expect(policyTier.enum).toEqual(['restricted', 'balanced', 'open']);
        expect(allowedEndpoints.type).toBe('array');
      });

      it('marks token and webhookSecret as sensitive', () => {
        const token = section.fields.find((f) => f.key === 'token') as ConfigFieldSchema;
        const secret = section.fields.find((f) => f.key === 'webhookSecret') as ConfigFieldSchema;
        expect(token.sensitive).toBe(true);
        expect(secret.sensitive).toBe(true);
      });

      it('has array fields for allowlists', () => {
        const allowlist = section.fields.find((f) => f.key === 'allowlist') as ConfigFieldSchema;
        const groupAllowlist = section.fields.find((f) => f.key === 'groupAllowlist') as ConfigFieldSchema;
        expect(allowlist.type).toBe('array');
        expect(groupAllowlist.type).toBe('array');
      });
    });

    // --- Presets section ---

    describe('presets section', () => {
      const section = schema.sections.find((s) => s.id === 'presets') as ConfigSectionSchema;

      it('has name as required', () => {
        const name = section.fields.find((f) => f.key === 'name') as ConfigFieldSchema;
        expect(name.required).toBe(true);
      });

      it('has array fields for mcpServers and skills', () => {
        const mcpServers = section.fields.find((f) => f.key === 'mcpServers') as ConfigFieldSchema;
        const skills = section.fields.find((f) => f.key === 'skills') as ConfigFieldSchema;
        expect(mcpServers.type).toBe('array');
        expect(skills.type).toBe('array');
      });

      it('has toolset as string', () => {
        const toolset = section.fields.find((f) => f.key === 'toolset') as ConfigFieldSchema;
        expect(toolset.type).toBe('string');
      });
    });
  });

  // -------------------------------------------------------------------
  // validateConfigUpdate
  // -------------------------------------------------------------------

  describe('validateConfigUpdate', () => {
    it('passes valid agent config', () => {
      const result = validateConfigUpdate('agent', {
        maxToolIterations: 20,
        concurrentToolCalls: true,
        synthesizeOnExhaustion: false,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes with partial updates (not all fields required)', () => {
      const result = validateConfigUpdate('agent', {
        concurrentToolCalls: true,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects maxToolIterations below minimum (0)', () => {
      const result = validateConfigUpdate('agent', {
        maxToolIterations: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('maxToolIterations');
      expect(result.errors[0].message).toContain('below minimum');
    });

    it('rejects maxToolIterations above maximum (100)', () => {
      const result = validateConfigUpdate('agent', {
        maxToolIterations: 100,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('maxToolIterations');
      expect(result.errors[0].message).toContain('exceeds maximum');
    });

    it('rejects wrong type (string for boolean field)', () => {
      const result = validateConfigUpdate('agent', {
        concurrentToolCalls: 'yes' as unknown as boolean,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('concurrentToolCalls');
      expect(result.errors[0].message).toContain('Expected boolean');
    });

    it('returns multiple errors at once', () => {
      const result = validateConfigUpdate('agent', {
        maxToolIterations: 0,
        concurrentToolCalls: 'yes' as unknown as boolean,
        synthesizeOnExhaustion: 42 as unknown as boolean,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('rejects invalid enum value for provider', () => {
      const result = validateConfigUpdate('provider', {
        'primary.provider': 'google',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('primary.provider');
      expect(result.errors[0].message).toContain('Invalid value');
    });

    it('passes valid security config', () => {
      const result = validateConfigUpdate('security', {
        redactToolOutput: false,
        scanUserInput: true,
      });
      expect(result.valid).toBe(true);
    });

    it('passes valid gateway config with enum', () => {
      const result = validateConfigUpdate('gateway', {
        enabled: true,
        dmPolicy: 'pairing',
        groupPolicy: 'allowlist',
        policyTier: 'restricted',
        allowedEndpoints: ['/api/webhooks/*'],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects invalid dmPolicy enum value', () => {
      const result = validateConfigUpdate('gateway', {
        dmPolicy: 'everyone',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('dmPolicy');
    });

    it('rejects unknown section', () => {
      const result = validateConfigUpdate('nonexistent', { foo: 'bar' });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('_section');
    });

    it('ignores unknown fields for forward compatibility', () => {
      const result = validateConfigUpdate('agent', {
        maxToolIterations: 10,
        futureField: 'something',
      });
      expect(result.valid).toBe(true);
    });

    it('validates array fields correctly', () => {
      const result = validateConfigUpdate('gateway', {
        allowlist: ['user1', 'user2'],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects non-array for array field', () => {
      const result = validateConfigUpdate('gateway', {
        allowlist: 'not-an-array',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Expected array');
    });

    it('accepts custom schema parameter', () => {
      const customSchema = generateConfigSchema();
      const result = validateConfigUpdate('agent', { maxToolIterations: 5 }, customSchema);
      expect(result.valid).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // diffConfigs
  // -------------------------------------------------------------------

  describe('diffConfigs', () => {
    it('detects changed fields', () => {
      const before = { maxToolIterations: 12, concurrentToolCalls: false };
      const after = { maxToolIterations: 20, concurrentToolCalls: false };

      const diff = diffConfigs(before, after);
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0].field).toBe('maxToolIterations');
      expect(diff.changes[0].oldValue).toBe(12);
      expect(diff.changes[0].newValue).toBe(20);
    });

    it('handles nested objects (provider slots)', () => {
      const before = {
        provider: {
          primary: { name: 'Main', provider: 'openai', model: 'gpt-4o' },
        },
      };
      const after = {
        provider: {
          primary: { name: 'Main', provider: 'anthropic', model: 'claude-sonnet-4' },
        },
      };

      const diff = diffConfigs(before, after);
      expect(diff.changes.length).toBeGreaterThanOrEqual(2);

      const providerChange = diff.changes.find((c) => c.field === 'provider.primary.provider');
      expect(providerChange).toBeDefined();
      expect(providerChange!.oldValue).toBe('openai');
      expect(providerChange!.newValue).toBe('anthropic');

      const modelChange = diff.changes.find((c) => c.field === 'provider.primary.model');
      expect(modelChange).toBeDefined();
      expect(modelChange!.oldValue).toBe('gpt-4o');
      expect(modelChange!.newValue).toBe('claude-sonnet-4');
    });

    it('returns empty changes for identical configs', () => {
      const config = {
        maxToolIterations: 12,
        concurrentToolCalls: false,
        nested: { a: 1, b: 'two' },
      };

      const diff = diffConfigs(config, { ...config, nested: { a: 1, b: 'two' } });
      expect(diff.changes).toHaveLength(0);
    });

    it('detects added fields', () => {
      const before = { a: 1 };
      const after = { a: 1, b: 2 };

      const diff = diffConfigs(before, after);
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0].field).toBe('b');
      expect(diff.changes[0].oldValue).toBeUndefined();
      expect(diff.changes[0].newValue).toBe(2);
    });

    it('detects removed fields', () => {
      const before = { a: 1, b: 2 };
      const after = { a: 1 };

      const diff = diffConfigs(before, after);
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0].field).toBe('b');
      expect(diff.changes[0].oldValue).toBe(2);
      expect(diff.changes[0].newValue).toBeUndefined();
    });

    it('detects array changes', () => {
      const before = { skills: ['a', 'b'] };
      const after = { skills: ['a', 'b', 'c'] };

      const diff = diffConfigs(before, after);
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0].field).toBe('skills');
    });

    it('has a valid ISO timestamp', () => {
      const diff = diffConfigs({ a: 1 }, { a: 2 });
      expect(diff.timestamp).toBeTruthy();
      // Should be a valid ISO date string
      const parsed = new Date(diff.timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('sets section from top-level key', () => {
      const before = { agent: { maxToolIterations: 12 } };
      const after = { agent: { maxToolIterations: 20 } };

      const diff = diffConfigs(before, after);
      expect(diff.changes[0].section).toBe('agent');
    });
  });
});
