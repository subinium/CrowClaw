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

const SCHEMA_VERSION = '0.4.0';

// -- v0.9.1 Sentinel config defaults BEGIN --
// These constants are the single source of truth for the v0.9.1 wave's new
// config defaults. Consuming code in other packages (promptware filter,
// exec-approval gate, goal tracker, checkpoint pruner, MCP SSE transport,
// i18n, host/origin guards) reads its resolved config via the runtime config
// store; when a field is unset it MUST fall back to the matching default here.
// Exposed as named exports so callers don't re-declare magic numbers.

/** Default prompt-injection ('promptware') policy. 'warn' logs but does not drop. */
export const DEFAULT_PROMPTWARE_POLICY: 'block' | 'warn' | 'off' = 'warn';

/** Default dangerous-tool approval window before the gate auto-resolves. */
export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 120_000;

/** What to do when the approval window elapses with no answer. */
export const DEFAULT_EXEC_APPROVAL_ON_TIMEOUT: 'deny' | 'allow' = 'deny';

/** Default ceiling on agent turns per session-goal before it expires. */
export const DEFAULT_GOAL_MAX_TURNS = 50;

/** Default checkpoint retention bounds (age / count / on-disk size). */
export const DEFAULT_CHECKPOINT_RETENTION = {
  maxAgeDays: 30,
  maxCount: 1000,
  maxDiskMB: 500,
} as const;

/** Default keepalive ping interval for MCP SSE transports. */
export const DEFAULT_MCP_SSE_KEEPALIVE_MS = 30_000;

/** Default UI / message locale when no per-request locale is resolved. */
export const DEFAULT_I18N_LOCALE = 'en';

/**
 * Host-header allowlist applied at HTTP ingress (CVE-2026-48710 class /
 * DNS-rebinding defense). These base hosts are always permitted; the runtime
 * additionally appends the configured bind hostname at resolve time. Entries
 * support a leading `*.` wildcard for subdomain matching (e.g. `*.example.com`).
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/**
 * WebSocket Origin allowlist. An EMPTY list is the safe default — it permits
 * only same-origin / no-Origin upgrades (browsers omit Origin for same-origin
 * WS, native clients omit it entirely). Any populated list switches to strict
 * matching; `*.example.com` wildcard subdomains are supported.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [];
// -- v0.9.1 Sentinel config defaults END --

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
    description:
      'Security and privacy controls for tool execution and data handling. ' +
      'Defaults are tuned for safety; opt out per field only if your workflow needs raw output.',
    fields: [
      {
        key: 'redactToolOutput',
        type: 'boolean',
        label: 'Redact Tool Output',
        description:
          'Redact API keys, OAuth tokens, JWTs, AWS keys, and other credential-shaped strings ' +
          'from tool output before it reaches the LLM, dashboard, or transcript. ' +
          // v0.9.0 (#293, Hermes v0.13 parity) — surface the corruption risk so an
          // operator who flips this off knows the tradeoff. Hermes #16794 made the
          // default off in v0.12 specifically because key-shaped substrings inside
          // patch tool outputs were being corrupted by the redactor.
          'WARNING: may corrupt patch-tool outputs that legitimately contain ' +
          'key-shaped substrings (e.g. base64 blobs in diff bodies). Turn off only ' +
          'when the downstream consumer needs byte-exact tool output.',
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
      // -- v0.9.1 Sentinel security fields BEGIN --
      // #339 prompt-injection ('promptware') policy. The detection + emission of
      // `security:promptware_blocked` lives in the security/core package and is
      // wired at integration; this schema entry only exposes the operator toggle.
      {
        key: 'promptware.policy',
        type: 'enum',
        label: 'Promptware Policy',
        description:
          'How to handle detected prompt-injection ("promptware") in inbound messages and tool output. ' +
          'block = drop the content and emit security:promptware_blocked; warn = log only; off = disabled.',
        required: false,
        enum: ['block', 'warn', 'off'],
        default: DEFAULT_PROMPTWARE_POLICY,
        section: 'security',
      },
      // #340 exec-approval timeout. When a dangerous tool waits on operator
      // approval, the gate auto-resolves after this many ms.
      {
        key: 'execApprovalTimeoutMs',
        type: 'number',
        label: 'Exec Approval Timeout (ms)',
        description: 'How long a dangerous-tool approval prompt waits before it auto-resolves per the on-timeout policy.',
        required: false,
        default: DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
        min: 1000,
        max: 3_600_000,
        section: 'security',
      },
      {
        key: 'execApprovalOnTimeout',
        type: 'enum',
        label: 'Exec Approval On Timeout',
        description:
          'Resolution applied when an approval prompt times out. deny is fail-closed (recommended); ' +
          'allow is fail-open and emits security:exec_approval_denied with resolution=allow for the audit trail.',
        required: false,
        enum: ['deny', 'allow'],
        default: DEFAULT_EXEC_APPROVAL_ON_TIMEOUT,
        section: 'security',
      },
      // -- v0.9.1 Sentinel security fields END --
    ],
  };
}

// -- v0.9.1 Sentinel config sections BEGIN --

/**
 * `server` section — HTTP/WS ingress hardening (v0.9.1).
 *
 * `allowedHosts` defends the Host header (CVE-2026-48710 class / DNS-rebinding)
 * and `allowedOrigins` defends the WebSocket upgrade Origin. Both support a
 * leading `*.` wildcard for subdomain matching. The consuming guards live in
 * `route-handlers.ts` (Host) and `websocket.ts` (Origin); see
 * `resolveAllowedHosts` / `isHostAllowed` and `isOriginAllowed`.
 */
function serverSection(): ConfigSectionSchema {
  return {
    id: 'server',
    label: 'Server Ingress',
    description: 'HTTP and WebSocket ingress controls — Host-header allowlist and WebSocket Origin allowlist.',
    fields: [
      {
        key: 'allowedHosts',
        type: 'array',
        label: 'Allowed Hosts',
        description:
          'Host headers permitted at HTTP ingress. localhost/127.0.0.1/::1 plus the configured bind host are ' +
          'always allowed; entries here extend that set. Supports "*.example.com" wildcard subdomains. ' +
          'A mismatched Host is rejected with 400 BAD_HOST (DNS-rebinding / Host-spoofing defense).',
        required: false,
        default: [],
        section: 'server',
      },
      {
        key: 'allowedOrigins',
        type: 'array',
        label: 'Allowed WebSocket Origins',
        description:
          'Origins permitted on the WebSocket upgrade. Empty (default) allows only same-origin / no-Origin ' +
          'upgrades — the safe default. Populating it switches to strict matching; supports "*.example.com".',
        required: false,
        default: [],
        section: 'server',
      },
    ],
  };
}

/**
 * `goal` section — per-session goal tracking budget (#341).
 * The goal lifecycle (`session:goal_*` events) is wired at integration; this
 * exposes only the turn ceiling before an unmet goal expires.
 */
function goalSection(): ConfigSectionSchema {
  return {
    id: 'goal',
    label: 'Goal Tracking',
    description: 'Per-session goal tracking — bounds how many agent turns a goal may consume before it expires.',
    fields: [
      {
        key: 'maxTurns',
        type: 'number',
        label: 'Max Turns',
        description: 'Maximum agent turns a session goal may run before emitting session:goal_expired.',
        required: false,
        default: DEFAULT_GOAL_MAX_TURNS,
        min: 1,
        max: 1000,
        section: 'goal',
      },
    ],
  };
}

/**
 * `checkpoints` section — retention bounds for the checkpoint store (#338).
 * The pruner (emitting `checkpoint:pruned`) is wired at integration.
 */
function checkpointsSection(): ConfigSectionSchema {
  return {
    id: 'checkpoints',
    label: 'Checkpoint Retention',
    description: 'Retention bounds for saved checkpoints. A prune pass removes the oldest checkpoints past any bound.',
    fields: [
      {
        key: 'retention.maxAgeDays',
        type: 'number',
        label: 'Max Age (days)',
        description: 'Checkpoints older than this are pruned.',
        required: false,
        default: DEFAULT_CHECKPOINT_RETENTION.maxAgeDays,
        min: 1,
        max: 3650,
        section: 'checkpoints',
      },
      {
        key: 'retention.maxCount',
        type: 'number',
        label: 'Max Count',
        description: 'Maximum number of checkpoints retained; oldest beyond this are pruned.',
        required: false,
        default: DEFAULT_CHECKPOINT_RETENTION.maxCount,
        min: 1,
        max: 1_000_000,
        section: 'checkpoints',
      },
      {
        key: 'retention.maxDiskMB',
        type: 'number',
        label: 'Max Disk (MB)',
        description: 'Maximum total on-disk size of checkpoints in megabytes; oldest beyond this are pruned.',
        required: false,
        default: DEFAULT_CHECKPOINT_RETENTION.maxDiskMB,
        min: 1,
        max: 1_000_000,
        section: 'checkpoints',
      },
    ],
  };
}

/**
 * `mcp` section — MCP transport options (#337). Currently exposes the SSE
 * transport toggle + keepalive. The SSE client lives in @crowclaw/mcp and is
 * wired at integration; it emits `mcp:sse_connected` / `mcp:sse_disconnected`.
 */
function mcpSection(): ConfigSectionSchema {
  return {
    id: 'mcp',
    label: 'MCP Transport',
    description: 'Model Context Protocol transport options, including the Server-Sent Events (SSE) transport.',
    fields: [
      {
        key: 'sse.enabled',
        type: 'boolean',
        label: 'Enable SSE Transport',
        description: 'Allow connecting to MCP servers over the SSE transport (in addition to stdio).',
        required: false,
        default: false,
        section: 'mcp',
      },
      {
        key: 'sse.keepaliveMs',
        type: 'number',
        label: 'SSE Keepalive (ms)',
        description: 'Interval between keepalive pings on an SSE MCP connection.',
        required: false,
        default: DEFAULT_MCP_SSE_KEEPALIVE_MS,
        min: 1000,
        max: 600_000,
        section: 'mcp',
      },
    ],
  };
}

/** `i18n` section — localization defaults (#336). */
function i18nSection(): ConfigSectionSchema {
  return {
    id: 'i18n',
    label: 'Localization',
    description: 'Localization defaults for dashboard strings and outbound messages.',
    fields: [
      {
        key: 'defaultLocale',
        type: 'string',
        label: 'Default Locale',
        description: 'BCP-47 locale used when no per-request locale is resolved (e.g. en, ko, ja).',
        required: false,
        default: DEFAULT_I18N_LOCALE,
        section: 'i18n',
      },
    ],
  };
}
// -- v0.9.1 Sentinel config sections END --

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
      // --- WhatsApp (#295) --------------------------------------------------
      {
        key: 'whatsapp.allowedContacts',
        type: 'array',
        label: 'WhatsApp Allowed Contacts',
        description: 'wa_ids permitted to message the bot. Empty + allowStrangers=false → all inbound rejected.',
        required: false,
        default: [],
        section: 'channels',
      },
      {
        key: 'whatsapp.allowStrangers',
        type: 'boolean',
        label: 'WhatsApp Allow Strangers',
        description: 'Pre-v0.9.0 behavior — bot responds to any sender. Default false; flipping to true logs an audit warning.',
        required: false,
        default: false,
        section: 'channels',
      },
      {
        key: 'whatsapp.botWaId',
        type: 'string',
        label: 'WhatsApp Bot Phone Number ID',
        description: 'Bot phone-number-id used to silently drop self-chat (echo loop). Required to enforce self-chat ban.',
        required: false,
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
      // -- v0.9.1 Sentinel sections --
      serverSection(),
      goalSection(),
      checkpointsSection(),
      mcpSection(),
      i18nSection(),
    ],
  };
}

// -- v0.9.1 Host / Origin matching helpers BEGIN --
// Shared by `route-handlers.ts` (Host-header guard) and `websocket.ts` (WS
// Origin guard). Kept here so there is exactly one wildcard-matching
// implementation and one place that knows the secure defaults.

/**
 * Normalize a host candidate for comparison: lowercased, surrounding
 * whitespace stripped, an optional `:port` removed, and IPv6 brackets dropped.
 * Returns an empty string for nullish/empty input.
 */
export function normalizeHostCandidate(value: string | null | undefined): string {
  if (!value) return '';
  let host = value.trim().toLowerCase();
  if (host.length === 0) return '';
  // Strip a trailing port. For bracketed IPv6 ([::1]:8080) only the part after
  // the closing bracket is a port; for hostnames the last colon is the port.
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close !== -1) {
      host = host.slice(1, close); // unwrap [::1] -> ::1
    }
  } else {
    // Only treat a single trailing :port as a port. A bare IPv6 literal has
    // multiple colons and no brackets — leave it intact.
    const colonCount = (host.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      host = host.slice(0, host.lastIndexOf(':'));
    }
  }
  return host;
}

/**
 * Match a normalized host against one allowlist pattern. Supports an exact
 * match and a single leading `*.` wildcard (matches one-or-more leading
 * labels, never the bare apex). Patterns are normalized the same way as the
 * candidate so `*.Example.com:443` works.
 */
function hostMatchesPattern(host: string, pattern: string): boolean {
  const normPattern = pattern.trim().toLowerCase();
  if (normPattern.length === 0) return false;
  if (normPattern === '*') return true;
  if (normPattern.startsWith('*.')) {
    const suffix = normPattern.slice(1); // ".example.com"
    // Require at least one label before the suffix; never match the apex.
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === normalizeHostCandidate(normPattern);
}

/**
 * Resolve the effective Host allowlist: the always-on base hosts, plus the
 * configured bind host, plus any operator-supplied `server.allowedHosts`.
 * Deduplicated and normalized; wildcard patterns are preserved verbatim.
 */
export function resolveAllowedHosts(
  bindHostname?: string | null,
  configured?: readonly string[] | null,
): string[] {
  const hosts = new Set<string>();
  for (const h of DEFAULT_ALLOWED_HOSTS) hosts.add(h);
  const bind = normalizeHostCandidate(bindHostname);
  if (bind.length > 0) {
    hosts.add(bind);
    // A wildcard bind (0.0.0.0 / ::) is an interface, not a Host the client
    // sends — do not let it widen the allowlist beyond the base hosts.
    if (bind === '0.0.0.0' || bind === '::') {
      hosts.delete('0.0.0.0');
      hosts.delete('::');
    }
  }
  if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim().toLowerCase();
        if (trimmed.length > 0) hosts.add(trimmed);
      }
    }
  }
  return [...hosts];
}

/**
 * Decide whether an incoming Host header is permitted. The DNS-rebinding /
 * BadHost attack this defends against requires a browser, which ALWAYS sends a
 * Host header — so a missing/empty Host (in-process `fetch(new Request(...))`,
 * native HTTP clients, embedded usage) carries no rebinding vector and is
 * allowed. A PRESENT-but-disallowed Host is the abuse case we reject.
 * Comparison is wildcard-aware via `hostMatchesPattern`.
 */
export function isHostAllowed(
  hostHeader: string | null | undefined,
  allowed: readonly string[],
): boolean {
  const host = normalizeHostCandidate(hostHeader);
  if (host.length === 0) return true; // no Host header → not a browser → no rebinding vector
  return allowed.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * Decide whether a WebSocket upgrade Origin is permitted.
 *
 * - No Origin header (native clients, same-origin browser WS) → allowed. This
 *   is the documented safe default: browsers attach Origin on cross-origin WS,
 *   so a present-but-disallowed Origin is the abuse case we block.
 * - Origin present + allowlist empty → allowed ONLY when it matches the
 *   request host (same-origin). Cross-origin with an empty allowlist is denied.
 * - Origin present + allowlist non-empty → strict wildcard-aware match.
 */
export function isOriginAllowed(
  originHeader: string | null | undefined,
  allowed: readonly string[],
  requestHost?: string | null,
): boolean {
  if (originHeader === null || originHeader === undefined || originHeader.trim().length === 0) {
    return true; // same-origin / non-browser client
  }
  // Parse the Origin into its host. Origin is `scheme://host[:port]`.
  let originHost = '';
  try {
    originHost = normalizeHostCandidate(new URL(originHeader).host);
  } catch {
    // Some clients send a bare host as Origin; fall back to direct normalize.
    originHost = normalizeHostCandidate(originHeader);
  }
  if (originHost.length === 0) return false;

  if (allowed.length === 0) {
    // Empty allowlist → permit only same-origin (Origin host == request host).
    const host = normalizeHostCandidate(requestHost);
    return host.length > 0 && originHost === host;
  }
  return allowed.some((pattern) => hostMatchesPattern(originHost, pattern));
}
// -- v0.9.1 Host / Origin matching helpers END --

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
