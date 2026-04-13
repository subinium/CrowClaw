/**
 * RuntimeConfigStore — Mutable in-memory configuration for the CrowClaw runtime.
 * The dashboard reads/writes this via REST API, and the runtime watches for changes.
 */

export interface GatewayPlatformConfig {
  enabled: boolean;
  token?: string;
  webhookSecret?: string;
  extra?: Record<string, string>;
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

  // Gateway platform configs
  gatewayConfigs: Map<string, GatewayPlatformConfig>;

  // Provider
  providerType: string;
  model: string;
  apiKey: string;

  // Pending pairing challenges
  pendingPairings: Map<string, { code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }>;
}

type ConfigChangeListener = (key: string, value: unknown) => void;

export class RuntimeConfigStore {
  private config: RuntimeConfig;
  private listeners: ConfigChangeListener[] = [];

  constructor() {
    this.config = {
      activePreset: null,
      agentPreset: null,
      activeToolset: null,
      disabledSkills: new Set(),
      mcpConnections: new Map(),
      gatewayConfigs: new Map(),
      providerType: 'none',
      model: 'unknown',
      apiKey: '',
      pendingPairings: new Map(),
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
  getPendingPairingsMap(): Map<string, { code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }> {
    return this.config.pendingPairings;
  }

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

  // --- Snapshot (for API responses) ---
  snapshot(): Record<string, unknown> {
    return {
      activePreset: this.config.activePreset,
      agentPreset: this.config.agentPreset,
      activeToolset: this.config.activeToolset,
      disabledSkills: [...this.config.disabledSkills],
      mcpConnections: Object.fromEntries(this.config.mcpConnections),
      gatewayConfigs: Object.fromEntries(
        [...this.config.gatewayConfigs].map(([k, v]) => [k, { ...v, token: v.token ? '***' : undefined }])
      ),
      provider: this.getProviderInfo(),
      pendingPairings: this.getPendingPairings(),
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
  gatewayConfigs: Record<string, GatewayPlatformConfig>;
  providerType: string;
  model: string;
  apiKey: string;
  pendingPairings: Record<string, { code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }>;
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
    if (data.gatewayConfigs) {
      for (const [platform, config] of Object.entries(data.gatewayConfigs)) {
        super.setGatewayConfig(platform, config);
      }
    }
    if (data.providerType !== undefined) {
      super.setProvider(data.providerType, data.model ?? 'unknown', data.apiKey ?? '');
    }
    if (data.pendingPairings) {
      for (const [key, pairing] of Object.entries(data.pendingPairings)) {
        super.addPairing(key, pairing);
      }
    }
  }

  /** Persist current state to disk. Silently falls back to in-memory on failure. */
  private async persistToDisk(): Promise<void> {
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const snapshot = this.snapshot();
      const serialized: SerializedConfig = {
        activePreset: snapshot.activePreset as string | null,
        agentPreset: snapshot.agentPreset as SerializedConfig['agentPreset'],
        activeToolset: snapshot.activeToolset as string | null,
        disabledSkills: snapshot.disabledSkills as string[],
        mcpConnections: snapshot.mcpConnections as Record<string, McpConnectionState>,
        gatewayConfigs: snapshot.gatewayConfigs as Record<string, GatewayPlatformConfig>,
        providerType: (snapshot.provider as { type: string }).type,
        model: (snapshot.provider as { model: string }).model,
        apiKey: '', // Never persist API keys to the runtime config snapshot
        pendingPairings: Object.fromEntries(
          (snapshot.pendingPairings as Array<{ code: string; platform: string; senderId: string; channelId: string; createdAt: string; expiresAt: string }>)
            .map((p) => [`${p.platform}:${p.senderId}`, p])
        ),
      };
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
      this.writeErrors = 0;
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

  override setGatewayConfig(platform: string, config: GatewayPlatformConfig): void {
    super.setGatewayConfig(platform, config);
    void this.persistToDisk();
  }

  override setProvider(type: string, model: string, apiKey: string): void {
    super.setProvider(type, model, apiKey);
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

  /** Returns number of consecutive write failures (0 means healthy). */
  getWriteErrorCount(): number {
    return this.writeErrors;
  }
}
