/**
 * Issue #91: Gateway-level credential pool with 401-rotation and least-used picker.
 *
 * Distinct from the provider-level `CredentialPool` in `@crowclaw/providers`,
 * which couples a key set to a single provider adapter. This module operates
 * at the gateway layer, holding a `Map<provider, ProviderKeySet>` so the
 * dispatch layer can pick a key per-provider, rotate on 401, and cool down
 * the offending key for N minutes.
 *
 * Design choices:
 *   - Atomic counter increment per key (single-threaded JS event loop makes
 *     `count += 1` atomic for our purposes; no external lock needed).
 *   - 401 → `rotated=true` + cooldown for `cooldownMs` (default 5 min).
 *   - `least_used` picker = active key with the smallest `usageCount` (ties
 *     broken by `lastUsedAt` ascending).
 *   - `round_robin` picker = next active key in insertion order.
 *
 * The pool is intentionally dependency-free so it can be wired into any
 * gateway dispatch path without dragging provider implementations along.
 */

export type CredentialPoolCursor = 'least_used' | 'round_robin';

export interface ProviderKeyPoolOptions {
  /** Ordered list of API keys. Order matters for `round_robin`. */
  keys: string[];
  /** Selection strategy. Default: 'least_used'. */
  cursor?: CredentialPoolCursor;
  /** Cooldown after a 401-driven rotation (ms). Default: 5 min. */
  cooldownMs?: number;
}

interface KeyState {
  key: string;
  /** Insertion index — round-robin uses this to pick the next active key. */
  index: number;
  /** Total successful + failed picks. Drives `least_used`. */
  usageCount: number;
  /** Last pick timestamp (epoch ms). Tie-breaker for `least_used`. */
  lastUsedAt: number;
  /** True once a 401 has flagged this key. Cleared by `clearRotation`. */
  rotated: boolean;
  /** Epoch ms; key is unavailable until `Date.now() >= cooldownUntil`. */
  cooldownUntil: number;
}

export interface ProviderKeyPoolStatus {
  /** Masked key (last 4 chars). Never expose the full secret. */
  key: string;
  active: boolean;
  rotated: boolean;
  usageCount: number;
  cooldownRemainingMs: number;
}

function maskKey(key: string): string {
  if (key.length <= 4) return '****';
  return `****${key.slice(-4)}`;
}

/**
 * Single-provider credential pool. The multi-provider container is
 * `GatewayCredentialPool` below.
 */
export class ProviderKeyPool {
  private readonly states: KeyState[];
  private readonly cursor: CredentialPoolCursor;
  private readonly cooldownMs: number;
  private rrIndex = 0;

  constructor(options: ProviderKeyPoolOptions) {
    if (!options.keys || options.keys.length === 0) {
      throw new Error('ProviderKeyPool requires at least one key');
    }
    this.states = options.keys.map((key, index) => ({
      key,
      index,
      usageCount: 0,
      lastUsedAt: 0,
      rotated: false,
      cooldownUntil: 0,
    }));
    this.cursor = options.cursor ?? 'least_used';
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
  }

  /** Pick the next available key. Throws if all keys are rotated/cooling down. */
  pick(): string {
    const now = Date.now();
    const available = this.states.filter(
      (s) => !s.rotated && s.cooldownUntil <= now,
    );

    if (available.length === 0) {
      const total = this.states.length;
      const rotated = this.states.filter((s) => s.rotated).length;
      const cooling = this.states.filter((s) => !s.rotated && s.cooldownUntil > now).length;
      throw new Error(
        `ProviderKeyPool exhausted (${total} total, ${rotated} rotated, ${cooling} cooling down)`,
      );
    }

    let chosen: KeyState;
    if (this.cursor === 'round_robin') {
      // Walk insertion order from rrIndex, skip unavailable states.
      let picked: KeyState | null = null;
      for (let i = 0; i < this.states.length; i += 1) {
        const idx = (this.rrIndex + i) % this.states.length;
        const candidate = this.states[idx]!;
        if (available.includes(candidate)) {
          picked = candidate;
          this.rrIndex = (idx + 1) % this.states.length;
          break;
        }
      }
      chosen = picked!;
    } else {
      // least_used: smallest usageCount, tie-break by lastUsedAt asc, then index.
      chosen = available.reduce((best, current) => {
        if (current.usageCount < best.usageCount) return current;
        if (current.usageCount > best.usageCount) return best;
        if (current.lastUsedAt < best.lastUsedAt) return current;
        if (current.lastUsedAt > best.lastUsedAt) return best;
        return current.index < best.index ? current : best;
      });
    }

    chosen.usageCount += 1;
    chosen.lastUsedAt = now;
    return chosen.key;
  }

  /**
   * Mark `key` as rotated (after a 401 from the upstream provider) and put it
   * on cooldown. Subsequent `pick()` calls will skip it until cooldown expires.
   * The `rotated` flag is *sticky* — call `clearRotation` to bring it back.
   */
  markRotated(key: string, statusCode = 401): void {
    const state = this.states.find((s) => s.key === key);
    if (!state) return;
    if (statusCode === 401 || statusCode === 403) {
      state.rotated = true;
      state.cooldownUntil = Date.now() + this.cooldownMs;
    }
  }

  /** Clear the rotated flag (e.g. after an operator rotates the upstream key). */
  clearRotation(key: string): void {
    const state = this.states.find((s) => s.key === key);
    if (!state) return;
    state.rotated = false;
    state.cooldownUntil = 0;
  }

  /** Number of keys currently usable. */
  activeCount(): number {
    const now = Date.now();
    return this.states.filter((s) => !s.rotated && s.cooldownUntil <= now).length;
  }

  /** Number of keys ever flagged as rotated (sticky). */
  rotatedCount(): number {
    return this.states.filter((s) => s.rotated).length;
  }

  /** Snapshot of pool status with masked keys. Safe to log. */
  status(): ProviderKeyPoolStatus[] {
    const now = Date.now();
    return this.states.map((s) => ({
      key: maskKey(s.key),
      active: !s.rotated && s.cooldownUntil <= now,
      rotated: s.rotated,
      usageCount: s.usageCount,
      cooldownRemainingMs: Math.max(0, s.cooldownUntil - now),
    }));
  }
}

/**
 * Multi-provider container. Convenience wrapper that holds a
 * `ProviderKeyPool` per provider name. Empty pools are not allowed; configure
 * each provider explicitly.
 */
export class GatewayCredentialPool {
  private readonly pools = new Map<string, ProviderKeyPool>();

  /** Register or replace the pool for a given provider name. */
  configure(provider: string, options: ProviderKeyPoolOptions): void {
    this.pools.set(provider, new ProviderKeyPool(options));
  }

  /** Fetch the pool for a provider, or undefined when unconfigured. */
  get(provider: string): ProviderKeyPool | undefined {
    return this.pools.get(provider);
  }

  /** Pick a key for the named provider. Throws if no pool is configured. */
  pick(provider: string): string {
    const pool = this.pools.get(provider);
    if (!pool) throw new Error(`No credential pool configured for provider '${provider}'`);
    return pool.pick();
  }

  /** Mark the offending key as rotated for the named provider. */
  markRotated(provider: string, key: string, statusCode = 401): void {
    this.pools.get(provider)?.markRotated(key, statusCode);
  }

  /** List configured provider names. */
  providers(): string[] {
    return [...this.pools.keys()];
  }

  /** Aggregate snapshot, useful for `/status` dashboards. */
  status(): Record<string, ProviderKeyPoolStatus[]> {
    const out: Record<string, ProviderKeyPoolStatus[]> = {};
    for (const [name, pool] of this.pools) {
      out[name] = pool.status();
    }
    return out;
  }
}
