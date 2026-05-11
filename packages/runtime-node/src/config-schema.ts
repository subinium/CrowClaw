/**
 * Config Schema Module — JSON Schema generator for CrowClaw runtime configuration.
 *
 * Provides:
 * - Schema generation from config types (for dashboard form rendering)
 * - Validation of config updates against schema constraints
 * - Config snapshot diffing for audit trails
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigFieldSchema {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  label: string;
  description: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
  min?: number;
  max?: number;
  sensitive?: boolean;
  section: string;
}

export interface ConfigSectionSchema {
  id: string;
  label: string;
  description: string;
  fields: ConfigFieldSchema[];
}

export interface FullConfigSchema {
  version: string;
  sections: ConfigSectionSchema[];
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string; value?: unknown }>;
}

export interface ConfigDiff {
  changes: Array<{
    section: string;
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = '0.3.0';

function agentSection(): ConfigSectionSchema {
  return {
    id: 'agent',
    label: 'Agent Configuration',
    description: 'Controls for the agent loop behavior including tool iteration limits and approval gates.',
    fields: [
      {
        key: 'maxToolIterations',
        type: 'number',
        label: 'Max Tool Iterations',
        description: 'Maximum number of tool call iterations per agent turn.',
        required: true,
        default: 12,
        min: 1,
        max: 50,
        section: 'agent',
      },
      {
        key: 'concurrentToolCalls',
        type: 'boolean',
        label: 'Concurrent Tool Calls',
        description: 'Allow multiple tool calls to execute in parallel.',
        required: true,
        default: false,
        section: 'agent',
      },
      {
        key: 'synthesizeOnExhaustion',
        type: 'boolean',
        label: 'Synthesize on Exhaustion',
        description: 'Generate a summary response when tool iterations are exhausted.',
        required: true,
        default: true,
        section: 'agent',
      },
      {
        key: 'maxToolResultLength',
        type: 'number',
        label: 'Max Tool Result Length',
        description: 'Maximum character length for tool result output before truncation.',
        required: true,
        default: 2000,
        min: 100,
        max: 100000,
        section: 'agent',
      },
      {
        key: 'requireApprovalForDangerousTools',
        type: 'boolean',
        label: 'Require Approval for Dangerous Tools',
        description: 'Pause and require user approval before executing tools flagged as dangerous.',
        required: true,
        default: true,
        section: 'agent',
      },
    ],
  };
}

function securitySection(): ConfigSectionSchema {
  return {
    id: 'security',
    label: 'Security Policy',
    description: 'Security and privacy controls for tool execution and data handling.',
    fields: [
      {
        key: 'redactToolOutput',
        type: 'boolean',
        label: 'Redact Tool Output',
        description: 'Redact sensitive patterns from tool output before displaying.',
        required: true,
        default: true,
        section: 'security',
      },
      {
        key: 'scanUserInput',
        type: 'boolean',
        label: 'Scan User Input',
        description: 'Scan user messages for prompt injection or malicious content.',
        required: true,
        default: false,
        section: 'security',
      },
      {
        key: 'scanCommands',
        type: 'boolean',
        label: 'Scan Commands',
        description: 'Scan shell commands before execution for dangerous patterns.',
        required: true,
        default: true,
        section: 'security',
      },
      {
        key: 'blockDangerousCommands',
        type: 'boolean',
        label: 'Block Dangerous Commands',
        description: 'Automatically block commands matching dangerous patterns instead of just warning.',
        required: true,
        default: false,
        section: 'security',
      },
      {
        key: 'piiRedaction',
        type: 'boolean',
        label: 'PII Redaction',
        description: 'Automatically redact personally identifiable information from outputs.',
        required: true,
        default: true,
        section: 'security',
      },
    ],
  };
}

function providerSection(): ConfigSectionSchema {
  const providerEnum = ['openai', 'anthropic', 'openrouter', 'custom'];

  const slotFields = (slotKey: string, slotLabel: string, required: boolean): ConfigFieldSchema[] => [
    {
      key: `${slotKey}.name`,
      type: 'string',
      label: `${slotLabel} Name`,
      description: `Display name for the ${slotLabel.toLowerCase()} provider slot.`,
      required,
      section: 'provider',
    },
    {
      key: `${slotKey}.provider`,
      type: 'enum',
      label: `${slotLabel} Provider`,
      description: `LLM provider for the ${slotLabel.toLowerCase()} slot.`,
      required,
      enum: providerEnum,
      section: 'provider',
    },
    {
      key: `${slotKey}.model`,
      type: 'string',
      label: `${slotLabel} Model`,
      description: `Model identifier for the ${slotLabel.toLowerCase()} slot (e.g., gpt-4o, claude-sonnet-4).`,
      required,
      section: 'provider',
    },
    {
      key: `${slotKey}.apiKey`,
      type: 'string',
      label: `${slotLabel} API Key`,
      description: `API key override for the ${slotLabel.toLowerCase()} slot. Leave empty to use the primary key.`,
      required: false,
      sensitive: true,
      section: 'provider',
    },
    {
      key: `${slotKey}.baseUrl`,
      type: 'string',
      label: `${slotLabel} Base URL`,
      description: `Custom base URL for the ${slotLabel.toLowerCase()} slot. Required for custom providers.`,
      required: false,
      section: 'provider',
    },
  ];

  return {
    id: 'provider',
    label: 'Provider Configuration',
    description: 'LLM provider fallback chain with primary, fallback, vision, compression, and embedding slots.',
    fields: [
      ...slotFields('primary', 'Primary', true),
      ...slotFields('fallback', 'Fallback', false),
      ...slotFields('vision', 'Vision', false),
      ...slotFields('compression', 'Compression', false),
      ...slotFields('embedding', 'Embedding', false),
    ],
  };
}

function gatewaySection(): ConfigSectionSchema {
  return {
    id: 'gateway',
    label: 'Gateway Platform',
    description: 'Configuration for messaging platform gateways (Discord, Telegram, Slack).',
    fields: [
      {
        key: 'enabled',
        type: 'boolean',
        label: 'Enabled',
        description: 'Enable or disable this gateway platform.',
        required: true,
        default: false,
        section: 'gateway',
      },
      {
        key: 'token',
        type: 'string',
        label: 'Bot Token',
        description: 'Authentication token for the messaging platform bot.',
        required: false,
        sensitive: true,
        section: 'gateway',
      },
      {
        key: 'webhookSecret',
        type: 'string',
        label: 'Webhook Secret',
        description: 'Secret for verifying incoming webhook payloads.',
        required: false,
        sensitive: true,
        section: 'gateway',
      },
      {
        key: 'policyTier',
        type: 'enum',
        label: 'Policy Tier',
        description: 'Endpoint policy tier for outbound gateway HTTP calls.',
        required: false,
        enum: ['restricted', 'balanced', 'open'],
        default: 'balanced',
        section: 'gateway',
      },
      {
        key: 'allowedEndpoints',
        type: 'array',
        label: 'Allowed Endpoints',
        description: 'Optional allowlist of outbound endpoint paths or full URL prefixes.',
        required: false,
        default: [],
        section: 'gateway',
      },
      {
        key: 'dmPolicy',
        type: 'enum',
        label: 'DM Policy',
        description: 'Access policy for direct messages: pairing requires code, allowlist limits to approved users.',
        required: false,
        enum: ['pairing', 'allowlist', 'open', 'disabled'],
        section: 'gateway',
      },
      {
        key: 'groupPolicy',
        type: 'enum',
        label: 'Group Policy',
        description: 'Access policy for group/channel messages.',
        required: false,
        enum: ['open', 'disabled', 'allowlist'],
        section: 'gateway',
      },
      {
        key: 'allowlist',
        type: 'array',
        label: 'DM Allowlist',
        description: 'List of user IDs allowed to send direct messages.',
        required: false,
        default: [],
        section: 'gateway',
      },
      {
        key: 'groupAllowlist',
        type: 'array',
        label: 'Group Allowlist',
        description: 'List of group/channel IDs where the bot will respond.',
        required: false,
        default: [],
        section: 'gateway',
      },
      {
        key: 'requireMention',
        type: 'boolean',
        label: 'Require Mention',
        description: 'Require the bot to be @mentioned before responding in groups.',
        required: false,
        default: false,
        section: 'gateway',
      },
    ],
  };
}

/**
 * `channels` section — per-platform ACLs introduced in v0.9.0 to close the
 * Hermes v0.13 parity gap. Initially scopes the cross-platform destination
 * allowlist (#318); subsequent commits add Discord (#294) and WhatsApp
 * (#295) entries.
 *
 * Field keys use dot-notation (`slack.allowedDestinations`, …) to stay
 * consistent with the existing `provider.<slot>.<field>` style.
 */
function channelsSection(): ConfigSectionSchema {
  return {
    id: 'channels',
    label: 'Channel ACLs',
    description: 'Per-platform allowlists for inbound messages (Discord guild roles, Slack/Telegram/Matrix/Mattermost/DingTalk/Email/Signal destinations).',
    fields: [
      // --- Discord (#294, CVSS 8.1) -----------------------------------------
      {
        key: 'discord.allowedRoles',
        type: 'array',
        label: 'Discord Allowed Roles',
        description: 'Array of `{ guildId, roleIds }` tuples. Role IDs are matched ONLY within the originating guild — the legacy `string[]` (role name) shape is detected and forced to deny-all.',
        required: false,
        default: [],
        section: 'channels',
      },
      {
        key: 'discord.allowDirectMessages',
        type: 'boolean',
        label: 'Discord Allow Direct Messages',
        description: 'Allow DMs (messages with no guild_id). Defaults to false — required to mitigate the CVSS 8.1 cross-guild bypass.',
        required: false,
        default: false,
        section: 'channels',
      },
      {
        key: 'discord.dmAllowlist',
        type: 'array',
        label: 'Discord DM Allowlist',
        description: 'Discord user IDs allowed to DM the bot when `allowDirectMessages` is true.',
        required: false,
        default: [],
        section: 'channels',
      },
      // --- Cross-platform destination ACL (#318) ---------------------------
      {
        key: 'slack.allowedDestinations',
        type: 'array',
        label: 'Slack Allowed Channels',
        description: 'Slack channel IDs allowed to dispatch messages to the agent. Empty = allow all (backward compat).',
        required: false,
        default: [],
        section: 'channels',
      },
      {
        key: 'telegram.allowedDestinations',
        type: 'array',
        label: 'Telegram Allowed Chats',
        description: 'Telegram chat IDs allowed to dispatch messages to the agent. Empty = allow all.',
        required: false,
        default: [],
        section: 'channels',
      },
      {
        key: 'matrix.allowedDestinations',
        type: 'array',
        label: 'Matrix Allowed Rooms',
        description: 'Matrix room IDs allowed to dispatch messages to the agent. Empty = allow all.',
        required: false,
        default: [],
        section: 'channels',
      },
      {
        key: 'mattermost.allowedDestinations',
        type: 'array',
        label: 'Mattermost Allowed Channels',
        description: 'Mattermost channel IDs allowed to dispatch messages to the agent. Empty = allow all.',
        required: false,
        default: [],
        section: 'channels',
      },
      {
        key: 'dingtalk.allowedDestinations',
        type: 'array',
        label: 'DingTalk Allowed Conversations',
        description: 'DingTalk conversation IDs allowed to dispatch messages to the agent. Empty = allow all.',
        required: false,
        default: [],
        section: 'channels',
      },
      {
        key: 'email.allowedDestinations',
        type: 'array',
        label: 'Email Allowed Mailboxes',
        description: 'Email mailbox/inbox identifiers allowed to dispatch messages to the agent. Empty = allow all.',
        required: false,
        default: [],
        section: 'channels',
      },
      {
        key: 'signal.allowedDestinations',
        type: 'array',
        label: 'Signal Allowed Senders',
        description: 'Signal phone numbers / UUIDs allowed to dispatch messages to the agent. Empty = allow all.',
        required: false,
        default: [],
        section: 'channels',
      },
    ],
  };
}

function presetsSection(): ConfigSectionSchema {
  return {
    id: 'presets',
    label: 'Config Presets',
    description: 'Reusable configuration bundles combining MCP servers, skills, and toolsets.',
    fields: [
      {
        key: 'name',
        type: 'string',
        label: 'Preset Name',
        description: 'Unique identifier for this config preset.',
        required: true,
        section: 'presets',
      },
      {
        key: 'description',
        type: 'string',
        label: 'Description',
        description: 'Human-readable description of what this preset configures.',
        required: false,
        section: 'presets',
      },
      {
        key: 'model',
        type: 'string',
        label: 'Model Override',
        description: 'Override the default model when this preset is active.',
        required: false,
        section: 'presets',
      },
      {
        key: 'mcpServers',
        type: 'array',
        label: 'MCP Servers',
        description: 'List of MCP server names to activate with this preset.',
        required: false,
        default: [],
        section: 'presets',
      },
      {
        key: 'skills',
        type: 'array',
        label: 'Skills',
        description: 'List of skill slugs to activate with this preset.',
        required: false,
        default: [],
        section: 'presets',
      },
      {
        key: 'toolset',
        type: 'string',
        label: 'Toolset',
        description: 'Toolset bundle name to use with this preset.',
        required: false,
        section: 'presets',
      },
      {
        key: 'tools',
        type: 'array',
        label: 'Individual Tools',
        description: 'List of individual tool names to include.',
        required: false,
        default: [],
        section: 'presets',
      },
      {
        key: 'systemPromptAppend',
        type: 'string',
        label: 'System Prompt Append',
        description: 'Additional text appended to the system prompt when this preset is active.',
        required: false,
        section: 'presets',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the full config schema describing all editable configuration sections.
 */
export function generateConfigSchema(): FullConfigSchema {
  return {
    version: SCHEMA_VERSION,
    sections: [
      agentSection(),
      securitySection(),
      providerSection(),
      gatewaySection(),
      channelsSection(),
      presetsSection(),
    ],
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a partial config update against the schema for a given section.
 *
 * Supports partial updates — only provided fields are validated.
 * Returns all errors at once rather than failing on the first.
 */
export function validateConfigUpdate(
  section: string,
  data: Record<string, unknown>,
  schema?: FullConfigSchema,
): ValidationResult {
  const fullSchema = schema ?? generateConfigSchema();
  const sectionSchema = fullSchema.sections.find((s) => s.id === section);

  if (!sectionSchema) {
    return {
      valid: false,
      errors: [{ field: '_section', message: `Unknown config section: ${section}` }],
    };
  }

  const errors: ValidationResult['errors'] = [];

  for (const [key, value] of Object.entries(data)) {
    // For nested keys like "primary.name", resolve the field by exact key match
    const field = sectionSchema.fields.find((f) => f.key === key);

    if (!field) {
      // Unknown field — skip silently (forward compatibility)
      continue;
    }

    validateField(field, value, errors);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateField(
  field: ConfigFieldSchema,
  value: unknown,
  errors: ValidationResult['errors'],
): void {
  // Type validation
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push({ field: field.key, message: `Expected string, got ${typeof value}`, value });
      }
      break;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push({ field: field.key, message: `Expected number, got ${typeof value}`, value });
        break;
      }
      if (field.min !== undefined && value < field.min) {
        errors.push({
          field: field.key,
          message: `Value ${value} is below minimum ${field.min}`,
          value,
        });
      }
      if (field.max !== undefined && value > field.max) {
        errors.push({
          field: field.key,
          message: `Value ${value} exceeds maximum ${field.max}`,
          value,
        });
      }
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push({ field: field.key, message: `Expected boolean, got ${typeof value}`, value });
      }
      break;
    }
    case 'enum': {
      if (typeof value !== 'string') {
        errors.push({ field: field.key, message: `Expected string enum value, got ${typeof value}`, value });
      } else if (field.enum && !field.enum.includes(value)) {
        errors.push({
          field: field.key,
          message: `Invalid value "${value}". Allowed: ${field.enum.join(', ')}`,
          value,
        });
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ field: field.key, message: `Expected array, got ${typeof value}`, value });
      }
      break;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({ field: field.key, message: `Expected object, got ${typeof value}`, value });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/**
 * Diff two config snapshots and return a list of changed fields.
 *
 * Handles flat and nested (dot-notation) keys. For objects, performs a
 * recursive comparison and reports each changed leaf as a separate entry.
 */
const SENSITIVE_KEY_PATTERNS = /apikey|api_key|token|secret|password/i;

export function diffConfigs(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ConfigDiff {
  const changes: ConfigDiff['changes'] = [];

  collectChanges('', before, after, changes);

  // Redact sensitive values
  for (const change of changes) {
    if (SENSITIVE_KEY_PATTERNS.test(change.field)) {
      change.oldValue = change.oldValue != null ? '***' : change.oldValue;
      change.newValue = change.newValue != null ? '***' : change.newValue;
    }
  }

  return {
    changes,
    timestamp: new Date().toISOString(),
  };
}

function collectChanges(
  prefix: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changes: ConfigDiff['changes'],
): void {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const oldVal = before[key];
    const newVal = after[key];

    // Determine section from the top-level key
    const section = prefix ? prefix.split('.')[0] ?? key : key;

    if (oldVal === newVal) {
      continue;
    }

    // Both are plain objects — recurse
    if (
      isPlainObject(oldVal) &&
      isPlainObject(newVal)
    ) {
      collectChanges(
        fullKey,
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
        changes,
      );
      continue;
    }

    // Arrays — compare by JSON serialization
    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changes.push({ section, field: fullKey, oldValue: oldVal, newValue: newVal });
      }
      continue;
    }

    // One exists, the other doesn't, or different types/values
    if (!deepEqual(oldVal, newVal)) {
      changes.push({ section, field: fullKey, oldValue: oldVal, newValue: newVal });
    }
  }
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }

  return false;
}
