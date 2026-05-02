/**
 * RuntimeConfigStore — Mutable in-memory configuration for the CrowClaw runtime.
 * The dashboard reads/writes this via REST API, and the runtime watches for changes.
 */

export interface ConfigPreset {
  name: string;
  description?: string;
  model?: string;
  mcpServers?: string[];
  skills?: string[];
  toolset?: string;
  tools?: string[];
  systemPromptAppend?: string;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_CONFIG_PRESETS: ConfigPreset[] = [
  {
    name: 'web-research',
    description: 'Browse and analyze web content',
    mcpServers: ['braveSearch', 'playwright'],
    skills: ['web-research', 'summarize-article', 'web-scraping'],
    toolset: 'research',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    name: 'code-development',
    description: 'Write, review, and debug code',
    mcpServers: ['github', 'filesystem'],
    skills: ['code-review', 'write-tests', 'debug-error', 'refactor-module'],
    toolset: 'devops',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    name: 'data-analysis',
    description: 'Query databases and analyze data',
    mcpServers: ['postgres', 'sqlite'],
    skills: ['database-migration', 'performance-optimization'],
    toolset: 'full',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    name: 'minimal',
    description: 'Basic chat with no extras',
    mcpServers: [],
    skills: [],
    toolset: 'minimal',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// Provider fallback chain configuration
// ---------------------------------------------------------------------------

export interface ProviderSlot {
  name: string;          // display name
  provider: string;      // 'openai' | 'anthropic' | 'openrouter' | 'custom'
  model: string;         // e.g., 'gpt-4o', 'claude-sonnet-4'
  apiKey?: string;       // if different from primary
  baseUrl?: string;      // if different from primary
}

export interface ProviderConfig {
  primary: ProviderSlot;
  fallback?: ProviderSlot;
  fast?: ProviderSlot;         // for simple queries (complexity router)
  vision?: ProviderSlot;       // for image analysis
  compression?: ProviderSlot;  // for context compression (cheap model)
  embedding?: ProviderSlot;    // for memory embeddings
}

export interface GatewayPlatformConfig {
  enabled: boolean;
  token?: string;
  webhookSecret?: string;
  extra?: Record<string, string>;
  policyTier?: 'restricted' | 'balanced' | 'open';
  allowedEndpoints?: string[];
  // Access policy (OpenClaw-inspired)
  dmPolicy?: 'pairing' | 'allowlist' | 'open' | 'disabled';
  groupPolicy?: 'open' | 'disabled' | 'allowlist';
  allowlist?: string[];
  groupAllowlist?: string[];
  requireMention?: boolean;
}

export interface McpConnectionState {
  presetName: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  error?: string;
  connectedAt?: string;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
  custom: boolean;
  catalogSlug?: string;
  repo?: string;
}

export interface SecurityPolicyConfig {
  redactToolOutput: boolean;
  scanUserInput: boolean;
  scanCommands: boolean;
  blockDangerousCommands: boolean;
  piiRedaction: boolean;
}

export interface AgentConfig {
  maxToolIterations: number;
  concurrentToolCalls: boolean;
  synthesizeOnExhaustion: boolean;
  maxToolResultLength: number;
  requireApprovalForDangerousTools: boolean;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxToolIterations: 12,
  concurrentToolCalls: false,
  synthesizeOnExhaustion: true,
  maxToolResultLength: 2000,
  requireApprovalForDangerousTools: true,
};

export const DEFAULT_SECURITY_POLICY: SecurityPolicyConfig = {
  redactToolOutput: true,
  scanUserInput: false,
  scanCommands: true,
  blockDangerousCommands: false,
  piiRedaction: true,
};

export interface RuntimeConfig {
  // Agent identity
  activePreset: string | null;
  agentPreset: { role: string; goal: string; backstory?: string } | null;

  // Toolset
  activeToolset: string | null;

  // Skills
  disabledSkills: Set<string>;

  // MCP connections
  mcpConnections: Map<string, McpConnectionState>;

  // Custom MCP servers (persisted)
  customMcpServers: Map<string, McpServerConfig>;

  // Gateway platform configs
  gatewayConfigs: Map<string, GatewayPlatformConfig>;

  // Provider
  providerType: string;
  model: string;
  apiKey: string;

  // Provider fallback chain config
  providerConfig: ProviderConfig | null;

  // Pending pairing challenges
  pendingPairings: Map<string, { code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }>;

  // Config presets (MCP+Skill+Tool bundles)
  configPresets: Map<string, ConfigPreset>;
  activeConfigPreset: string | null;

  // Security policy
  securityPolicy: SecurityPolicyConfig;

  // Agent loop configuration
  agentConfig: AgentConfig;

  // Remote access
  publicUrl: string | null;
  trustProxy: boolean;
}

type ConfigChangeListener = (key: string, value: unknown) => void;

export class RuntimeConfigStore {
  protected config: RuntimeConfig;
  private listeners: ConfigChangeListener[] = [];
  private disabledToolNames: Set<string> = new Set();

  constructor() {
    const defaultPresets = new Map<string, ConfigPreset>();
    for (const preset of DEFAULT_CONFIG_PRESETS) {
      defaultPresets.set(preset.name, preset);
    }
    this.config = {
      activePreset: null,
      agentPreset: null,
      activeToolset: null,
      disabledSkills: new Set(),
      mcpConnections: new Map(),
      customMcpServers: new Map(),
      gatewayConfigs: new Map(),
      providerType: 'none',
      model: 'unknown',
      apiKey: '',
      providerConfig: null,
      pendingPairings: new Map(),
      configPresets: defaultPresets,
      activeConfigPreset: null,
      securityPolicy: { ...DEFAULT_SECURITY_POLICY },
      agentConfig: { ...DEFAULT_AGENT_CONFIG },
      publicUrl: null,
      trustProxy: false,
    };
  }

  // --- Getters ---
  getActivePreset(): string | null { return this.config.activePreset; }
  getAgentPreset(): RuntimeConfig['agentPreset'] { return this.config.agentPreset; }
  getActiveToolset(): string | null { return this.config.activeToolset; }
  getDisabledSkills(): string[] { return [...this.config.disabledSkills]; }
  isSkillEnabled(slug: string): boolean { return !this.config.disabledSkills.has(slug); }
  getMcpConnection(name: string): McpConnectionState | undefined { return this.config.mcpConnections.get(name); }
  getMcpConnections(): Record<string, McpConnectionState> { return Object.fromEntries(this.config.mcpConnections); }
  getGatewayConfig(platform: string): GatewayPlatformConfig | undefined { return this.config.gatewayConfigs.get(platform); }
  getGatewayConfigs(): Record<string, GatewayPlatformConfig> { return Object.fromEntries(this.config.gatewayConfigs); }
  getProviderInfo(): { type: string; model: string; configured: boolean } {
    return { type: this.config.providerType, model: this.config.model, configured: !!this.config.apiKey };
  }
  getSecurityPolicy(): SecurityPolicyConfig { return { ...this.config.securityPolicy }; }
  getAgentConfig(): AgentConfig { return { ...this.config.agentConfig }; }
  getPublicUrl(): string | null { return this.config.publicUrl; }
  getTrustProxy(): boolean { return this.config.trustProxy; }
  setRemoteAccess(publicUrl: string | null, trustProxy: boolean): void {
    this.config.publicUrl = publicUrl;
    this.config.trustProxy = trustProxy;
    this.emit('remoteAccess', { publicUrl, trustProxy });
  }
  // --- Provider Config ---
  getProviderConfig(): ProviderConfig | null { return this.config.providerConfig; }

  setProviderConfig(config: ProviderConfig | null): void {
    // Deep clone to avoid external mutation of the stored config
    this.config.providerConfig = config ? JSON.parse(JSON.stringify(config)) as ProviderConfig : null;
    this.emit('providerConfig', config);
  }

  setProviderSlot(slot: keyof ProviderConfig, slotConfig: ProviderSlot | undefined): void {
    if (!this.config.providerConfig && slotConfig && slot === 'primary') {
      this.config.providerConfig = { primary: { ...slotConfig } };
    } else if (this.config.providerConfig) {
      if (slotConfig) {
        (this.config.providerConfig as unknown as Record<string, ProviderSlot | undefined>)[slot] = { ...slotConfig };
      } else {
        delete (this.config.providerConfig as unknown as Record<string, ProviderSlot | undefined>)[slot];
      }
    }
    this.emit('providerSlot', { slot, config: slotConfig });
  }

  getPendingPairingsMap(): Map<string, { code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }> {
    // Prune expired entries on every read — otherwise the inbound gateway
    // message path accumulates stale challenges forever (1h expiry × high
    // inbound traffic → thousands of dead rows persisted to disk).
    const now = Date.now();
    for (const [key, p] of this.config.pendingPairings) {
      if (new Date(p.expiresAt).getTime() < now) this.config.pendingPairings.delete(key);
    }
    return this.config.pendingPairings;
  }

  // --- Custom MCP Servers ---
  getMcpServers(): McpServerConfig[] { return [...this.config.customMcpServers.values()]; }
  getMcpServer(name: string): McpServerConfig | undefined { return this.config.customMcpServers.get(name); }

  saveMcpServer(config: McpServerConfig): void {
    this.config.customMcpServers.set(config.name, config);
    this.emit('customMcpServer', { name: config.name, config });
  }

  deleteMcpServer(name: string): boolean {
    const existed = this.config.customMcpServers.delete(name);
    if (existed) {
      this.emit('customMcpServerDeleted', name);
    }
    return existed;
  }

  // --- Config Presets ---
  getConfigPresets(): ConfigPreset[] { return [...this.config.configPresets.values()]; }
  getConfigPreset(name: string): ConfigPreset | undefined { return this.config.configPresets.get(name); }
  getActiveConfigPreset(): ConfigPreset | null {
    if (!this.config.activeConfigPreset) return null;
    return this.config.configPresets.get(this.config.activeConfigPreset) ?? null;
  }
  getActiveConfigPresetName(): string | null { return this.config.activeConfigPreset; }

  // --- Pairings ---
  getPendingPairings(): Array<{ code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }> {
    // Prune expired
    const now = Date.now();
    for (const [key, p] of this.config.pendingPairings) {
      if (new Date(p.expiresAt).getTime() < now) this.config.pendingPairings.delete(key);
    }
    return [...this.config.pendingPairings.values()];
  }

  addPairing(key: string, pairing: { code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }): void {
    this.config.pendingPairings.set(key, pairing);
    this.emit('pairing', { key, pairing });
  }

  approvePairing(code: string): { approved: boolean; platform?: string; senderId?: string } {
    for (const [key, p] of this.config.pendingPairings) {
      if (p.code === code.toUpperCase()) {
        this.config.pendingPairings.delete(key);
        // Add to allowlist
        const gwConfig = this.config.gatewayConfigs.get(p.platform);
        if (gwConfig) {
          if (!gwConfig.allowlist) gwConfig.allowlist = [];
          if (!gwConfig.allowlist.includes(p.senderId)) {
            gwConfig.allowlist.push(p.senderId);
          }
        }
        this.emit('pairingApproved', { code, platform: p.platform, senderId: p.senderId });
        return { approved: true, platform: p.platform, senderId: p.senderId };
      }
    }
    return { approved: false };
  }

  // --- Setters ---
  setActivePreset(name: string | null, preset: RuntimeConfig['agentPreset'] = null): void {
    this.config.activePreset = name;
    this.config.agentPreset = preset;
    this.emit('activePreset', name);
  }

  setActiveToolset(name: string | null): void {
    this.config.activeToolset = name;
    this.emit('activeToolset', name);
  }

  // --- Disabled tools (per-tool toggle, independent of toolset filter) ---
  isToolDisabled(name: string): boolean { return this.disabledToolNames.has(name); }
  getDisabledTools(): string[] { return [...this.disabledToolNames]; }
  setToolDisabled(name: string, disabled: boolean): void {
    if (disabled) {
      this.disabledToolNames.add(name);
    } else {
      this.disabledToolNames.delete(name);
    }
    this.emit('disabledTool', { name, disabled });
  }

  toggleSkill(slug: string, enabled: boolean): void {
    if (enabled) {
      this.config.disabledSkills.delete(slug);
    } else {
      this.config.disabledSkills.add(slug);
    }
    this.emit('skill', { slug, enabled });
  }

  setMcpConnection(name: string, state: McpConnectionState): void {
    this.config.mcpConnections.set(name, state);
    this.emit('mcpConnection', { name, state });
  }

  removeMcpConnection(name: string): void {
    this.config.mcpConnections.delete(name);
    this.emit('mcpConnection', { name, state: null });
  }

  setGatewayConfig(platform: string, config: GatewayPlatformConfig): void {
    this.config.gatewayConfigs.set(platform, config);
    this.emit('gatewayConfig', { platform, config });
  }

  setProvider(type: string, model: string, apiKey: string): void {
    this.config.providerType = type;
    this.config.model = model;
    this.config.apiKey = apiKey;
    this.emit('provider', { type, model });
  }

  setActiveConfigPreset(name: string | null): void {
    if (name !== null && !this.config.configPresets.has(name)) {
      throw new Error(`Config preset '${name}' not found`);
    }
    this.config.activeConfigPreset = name;
    this.emit('activeConfigPreset', name);
  }

  saveConfigPreset(preset: ConfigPreset): void {
    this.config.configPresets.set(preset.name, preset);
    this.emit('configPreset', { name: preset.name, preset });
  }

  deleteConfigPreset(name: string): boolean {
    const existed = this.config.configPresets.delete(name);
    if (this.config.activeConfigPreset === name) {
      this.config.activeConfigPreset = null;
    }
    if (existed) {
      this.emit('configPresetDeleted', name);
    }
    return existed;
  }

  setSecurityPolicy(policy: Partial<SecurityPolicyConfig>): void {
    this.config.securityPolicy = { ...this.config.securityPolicy, ...policy };
    this.emit('securityPolicy', this.config.securityPolicy);
  }

  setAgentConfig(config: Partial<AgentConfig>): void {
    this.config.agentConfig = { ...this.config.agentConfig, ...config };
    this.emit('agentConfig', this.config.agentConfig);
  }

  // --- Snapshot (for API responses) ---
  snapshot(): Record<string, unknown> {
    return {
      activePreset: this.config.activePreset,
      agentPreset: this.config.agentPreset,
      activeToolset: this.config.activeToolset,
      disabledSkills: [...this.config.disabledSkills],
      mcpConnections: Object.fromEntries(this.config.mcpConnections),
      customMcpServers: [...this.config.customMcpServers.values()].map((s) => ({
        ...s,
        env: s.env ? Object.fromEntries(
          Object.entries(s.env).map(([k, v]) => [k, v ? '***' : undefined])
        ) : undefined,
      })),
      gatewayConfigs: Object.fromEntries(
        [...this.config.gatewayConfigs].map(([k, v]) => [k, { ...v, token: v.token ? '***' : undefined }])
      ),
      provider: this.getProviderInfo(),
      providerConfig: this.config.providerConfig ? {
        primary: { ...this.config.providerConfig.primary, apiKey: this.config.providerConfig.primary.apiKey ? '***' : undefined },
        fallback: this.config.providerConfig.fallback ? { ...this.config.providerConfig.fallback, apiKey: this.config.providerConfig.fallback.apiKey ? '***' : undefined } : undefined,
        vision: this.config.providerConfig.vision ? { ...this.config.providerConfig.vision, apiKey: this.config.providerConfig.vision.apiKey ? '***' : undefined } : undefined,
        compression: this.config.providerConfig.compression ? { ...this.config.providerConfig.compression, apiKey: this.config.providerConfig.compression.apiKey ? '***' : undefined } : undefined,
        embedding: this.config.providerConfig.embedding ? { ...this.config.providerConfig.embedding, apiKey: this.config.providerConfig.embedding.apiKey ? '***' : undefined } : undefined,
      } : null,
      pendingPairings: this.getPendingPairings(),
      configPresets: [...this.config.configPresets.values()],
      activeConfigPreset: this.config.activeConfigPreset,
      securityPolicy: this.config.securityPolicy,
      agentConfig: this.config.agentConfig,
    };
  }

  // --- Events ---
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  private emit(key: string, value: unknown): void {
    for (const listener of this.listeners) {
      try { listener(key, value); } catch { /* swallow listener errors */ }
    }
  }
}

// ---------------------------------------------------------------------------
// FileConfigStore — persists RuntimeConfigStore state to disk
// ---------------------------------------------------------------------------

/** Serializable subset of RuntimeConfig (Sets/Maps → arrays/objects). */
interface SerializedConfig {
  activePreset: string | null;
  agentPreset: { role: string; goal: string; backstory?: string } | null;
  activeToolset: string | null;
  disabledSkills: string[];
  mcpConnections: Record<string, McpConnectionState>;
  customMcpServers?: McpServerConfig[];
  gatewayConfigs: Record<string, GatewayPlatformConfig>;
  providerType: string;
  model: string;
  apiKey: string;
  providerConfig?: ProviderConfig | null;
  pendingPairings: Record<string, { code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }>;
  configPresets?: ConfigPreset[];
  activeConfigPreset?: string | null;
  securityPolicy?: SecurityPolicyConfig;
  agentConfig?: AgentConfig;
  publicUrl?: string | null;
  trustProxy?: boolean;
  disabledTools?: string[];
}

/** Build a clone of a ProviderConfig with every slot's apiKey stripped. */
function stripProviderSecrets(providerConfig: ProviderConfig): ProviderConfig {
  const stripSlot = (slot: ProviderSlot | undefined): ProviderSlot | undefined => {
    if (!slot) return undefined;
    const clone: ProviderSlot = { ...slot };
    delete clone.apiKey;
    return clone;
  };
  const stripped: ProviderConfig = {
    primary: stripSlot(providerConfig.primary) as ProviderSlot,
  };
  if (providerConfig.fallback) stripped.fallback = stripSlot(providerConfig.fallback);
  if (providerConfig.fast) stripped.fast = stripSlot(providerConfig.fast);
  if (providerConfig.vision) stripped.vision = stripSlot(providerConfig.vision);
  if (providerConfig.compression) stripped.compression = stripSlot(providerConfig.compression);
  if (providerConfig.embedding) stripped.embedding = stripSlot(providerConfig.embedding);
  return stripped;
}

/**
 * FileConfigStore — a RuntimeConfigStore that persists to a JSON file.
 *
 * - Loads from file on first access (lazy init).
 * - Saves on every mutation.
 * - Falls back to in-memory if file write fails.
 * - Implements the same public interface as RuntimeConfigStore.
 */
export class FileConfigStore extends RuntimeConfigStore {
  private filePath: string;
  private initialized = false;
  private writeErrors = 0;
  /**
   * Serialized write chain. Every `persistToDisk()` call chains after the
   * previous one so concurrent mutators don't race on the file. Writes are
   * atomic: we write to a sibling temp path and then rename, which on POSIX
   * is atomic and on Windows replaces the target in a single operation.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  /** Lazy-load config from file on first access. */
  private async ensureLoaded(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<SerializedConfig>;
      this.hydrateFrom(data);
    } catch {
      // File doesn't exist or is invalid — start with defaults (already set by super())
    }
  }

  /** Hydrate in-memory state from serialized data (no save triggered). */
  private hydrateFrom(data: Partial<SerializedConfig>): void {
    if (data.activePreset !== undefined || data.agentPreset !== undefined) {
      // Use parent setter but suppress save by calling super directly
      super.setActivePreset(data.activePreset ?? null, data.agentPreset ?? null);
    }
    if (data.activeToolset !== undefined) {
      super.setActiveToolset(data.activeToolset);
    }
    if (Array.isArray(data.disabledSkills)) {
      for (const slug of data.disabledSkills) {
        super.toggleSkill(slug, false);
      }
    }
    if (data.mcpConnections) {
      for (const [name, state] of Object.entries(data.mcpConnections)) {
        super.setMcpConnection(name, state);
      }
    }
    if (Array.isArray(data.customMcpServers)) {
      for (const server of data.customMcpServers) {
        super.saveMcpServer(server);
      }
    }
    if (data.gatewayConfigs) {
      for (const [platform, config] of Object.entries(data.gatewayConfigs)) {
        super.setGatewayConfig(platform, config);
      }
    }
    if (data.providerType !== undefined) {
      super.setProvider(data.providerType, data.model ?? 'unknown', data.apiKey ?? '');
    }
    if (data.providerConfig !== undefined) {
      super.setProviderConfig(data.providerConfig ?? null);
    }
    if (data.pendingPairings) {
      for (const [key, pairing] of Object.entries(data.pendingPairings)) {
        super.addPairing(key, pairing);
      }
    }
    if (Array.isArray(data.configPresets)) {
      for (const preset of data.configPresets) {
        super.saveConfigPreset(preset);
      }
    }
    if (data.activeConfigPreset !== undefined) {
      try {
        super.setActiveConfigPreset(data.activeConfigPreset ?? null);
      } catch {
        // Preset may not exist — ignore
      }
    }
    if (data.securityPolicy) {
      super.setSecurityPolicy(data.securityPolicy);
    }
    if (data.agentConfig) {
      super.setAgentConfig(data.agentConfig);
    }
    if (data.publicUrl !== undefined || data.trustProxy !== undefined) {
      super.setRemoteAccess(data.publicUrl ?? null, data.trustProxy ?? false);
    }
    if (Array.isArray(data.disabledTools)) {
      for (const name of data.disabledTools) {
        super.setToolDisabled(name, true);
      }
    }
  }

  /**
   * Persist current state to disk. Silently falls back to in-memory on failure.
   * Concurrent calls are serialized via `writeQueue` so writes never race.
   */
  private persistToDisk(): Promise<void> {
    const previous = this.writeQueue;
    const next = (async () => {
      // Snapshot the config synchronously before the previous write completes,
      // so the enqueued write captures "state as of now" and later mutations
      // get their own queued write.
      const serialized = this.serializeForDisk();
      await previous.catch(() => { /* previous failure is already accounted for */ });
      await this.doWrite(serialized);
    })();
    this.writeQueue = next;
    return next;
  }

  /** Build the serialized config. Runs synchronously while holding the mutation point. */
  private serializeForDisk(): SerializedConfig {
    const cfg = this.config;
    return {
      activePreset: cfg.activePreset,
      agentPreset: cfg.agentPreset,
      activeToolset: cfg.activeToolset,
      disabledSkills: [...cfg.disabledSkills],
      mcpConnections: Object.fromEntries(cfg.mcpConnections),
      customMcpServers: [...cfg.customMcpServers.values()],
      // Never persist gateway bot tokens or webhook secrets to disk. Writing
      // '***' back round-tripped as the real token on reload, corrupting
      // gateway delivery. Users must re-supply the token via env var or the
      // dashboard after a restart.
      gatewayConfigs: Object.fromEntries(
        [...cfg.gatewayConfigs].map(([platform, gatewayConfig]) => [
          platform,
          { ...gatewayConfig, token: undefined, webhookSecret: undefined },
        ]),
      ),
      providerType: cfg.providerType,
      model: cfg.model,
      apiKey: '', // Never persist LLM API keys to disk — require env var or re-entry
      providerConfig: cfg.providerConfig ? stripProviderSecrets(cfg.providerConfig) : null,
      pendingPairings: Object.fromEntries(
        [...cfg.pendingPairings].map(([k, v]) => [k, v])
      ),
      configPresets: [...cfg.configPresets.values()],
      activeConfigPreset: cfg.activeConfigPreset,
      securityPolicy: cfg.securityPolicy,
      agentConfig: cfg.agentConfig,
      publicUrl: cfg.publicUrl,
      trustProxy: cfg.trustProxy,
      disabledTools: this.getDisabledTools(),
    };
  }

  private async doWrite(serialized: SerializedConfig): Promise<void> {
    try {
      const { writeFile, rename, mkdir, unlink } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      try {
        await writeFile(tmpPath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
        await rename(tmpPath, this.filePath);
        this.writeErrors = 0;
      } catch (err) {
        // Clean up the temp file if the rename failed so we don't leak files.
        try { await unlink(tmpPath); } catch { /* temp may not exist */ }
        throw err;
      }
    } catch {
      this.writeErrors++;
      // Fall back to in-memory silently
    }
  }

  // --- Async-aware access ---

  /** Call this before reading any state to ensure the file has been loaded. */
  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  // --- Override mutators to trigger persist ---

  override setActivePreset(name: string | null, preset: RuntimeConfig['agentPreset'] = null): void {
    super.setActivePreset(name, preset);
    void this.persistToDisk();
  }

  override setActiveToolset(name: string | null): void {
    super.setActiveToolset(name);
    void this.persistToDisk();
  }

  override toggleSkill(slug: string, enabled: boolean): void {
    super.toggleSkill(slug, enabled);
    void this.persistToDisk();
  }

  override setMcpConnection(name: string, state: McpConnectionState): void {
    super.setMcpConnection(name, state);
    void this.persistToDisk();
  }

  override removeMcpConnection(name: string): void {
    super.removeMcpConnection(name);
    void this.persistToDisk();
  }

  override saveMcpServer(config: McpServerConfig): void {
    super.saveMcpServer(config);
    void this.persistToDisk();
  }

  override deleteMcpServer(name: string): boolean {
    const result = super.deleteMcpServer(name);
    if (result) {
      void this.persistToDisk();
    }
    return result;
  }

  override setGatewayConfig(platform: string, config: GatewayPlatformConfig): void {
    super.setGatewayConfig(platform, config);
    void this.persistToDisk();
  }

  override setProvider(type: string, model: string, apiKey: string): void {
    super.setProvider(type, model, apiKey);
    void this.persistToDisk();
  }

  override setProviderConfig(config: ProviderConfig | null): void {
    super.setProviderConfig(config);
    void this.persistToDisk();
  }

  override setProviderSlot(slot: keyof ProviderConfig, slotConfig: ProviderSlot | undefined): void {
    super.setProviderSlot(slot, slotConfig);
    void this.persistToDisk();
  }

  override addPairing(key: string, pairing: { code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }): void {
    super.addPairing(key, pairing);
    void this.persistToDisk();
  }

  override approvePairing(code: string): { approved: boolean; platform?: string; senderId?: string } {
    const result = super.approvePairing(code);
    if (result.approved) {
      void this.persistToDisk();
    }
    return result;
  }

  override setActiveConfigPreset(name: string | null): void {
    super.setActiveConfigPreset(name);
    void this.persistToDisk();
  }

  override saveConfigPreset(preset: ConfigPreset): void {
    super.saveConfigPreset(preset);
    void this.persistToDisk();
  }

  override deleteConfigPreset(name: string): boolean {
    const result = super.deleteConfigPreset(name);
    if (result) {
      void this.persistToDisk();
    }
    return result;
  }

  override setSecurityPolicy(policy: Partial<SecurityPolicyConfig>): void {
    super.setSecurityPolicy(policy);
    void this.persistToDisk();
  }

  override setAgentConfig(config: Partial<AgentConfig>): void {
    super.setAgentConfig(config);
    void this.persistToDisk();
  }

  override setRemoteAccess(publicUrl: string | null, trustProxy: boolean): void {
    super.setRemoteAccess(publicUrl, trustProxy);
    void this.persistToDisk();
  }

  override setToolDisabled(name: string, disabled: boolean): void {
    super.setToolDisabled(name, disabled);
    void this.persistToDisk();
  }

  /** Returns number of consecutive write failures (0 means healthy). */
  getWriteErrorCount(): number {
    return this.writeErrors;
  }
}
