/**
 * Issue #60: Remote model manifest fetcher.
 *
 * Replaces (read: augments) the hardcoded model/context map with a remote
 * manifest fetched once per process per URL, cached for 24h with ETag
 * revalidation. Fail-open: if the fetch errors or the URL is unreachable,
 * `loadManifest` returns the bundled fallback so the runtime keeps working
 * offline.
 *
 * Provider classes consult this lazily for context-length lookups; existing
 * hardcoded values stay as the fallback so the cache key bumps cleanly on
 * Crow releases.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelManifestEntry {
  id: string;
  contextLength: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsStreaming: boolean;
}

export interface ModelManifest {
  models: ModelManifestEntry[];
  updatedAt: string;
}

export interface ManifestCacheEntry {
  manifest: ModelManifest;
  fetchedAt: number;
  etag?: string;
}

export type ManifestCache = Map<string, ManifestCacheEntry>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/subinium/CrowClaw/main/docs/model-catalog.json';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hardcoded fallback manifest. Mirrors the canonical entries shipped at
 * `docs/model-catalog.json`. Used when the remote fetch fails or the URL
 * cannot be reached (offline, CI without network, etc.).
 */
export const FALLBACK_MANIFEST: ModelManifest = {
  updatedAt: '2026-04-26',
  models: [
    {
      id: 'gpt-4o',
      contextLength: 128_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'gpt-4o-mini',
      contextLength: 128_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'gpt-4.1',
      contextLength: 1_000_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'gpt-5',
      contextLength: 400_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'gpt-5.5',
      contextLength: 400_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'o3',
      contextLength: 200_000,
      supportsTools: true,
      supportsImages: false,
      supportsStreaming: true,
    },
    {
      id: 'o4-mini',
      contextLength: 200_000,
      supportsTools: true,
      supportsImages: false,
      supportsStreaming: true,
    },
    {
      id: 'claude-sonnet-4-5',
      contextLength: 200_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'claude-opus-4',
      contextLength: 200_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'claude-haiku-3-5',
      contextLength: 200_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'gemini-2.5-pro',
      contextLength: 1_000_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
    {
      id: 'gemini-2.5-flash',
      contextLength: 1_000_000,
      supportsTools: true,
      supportsImages: true,
      supportsStreaming: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const defaultCache: ManifestCache = new Map();

/** Reset the default cache. Exposed for tests. */
export function resetManifestCache(cache: ManifestCache = defaultCache): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed value matches the ModelManifest shape. Returns the
 * value cast on success, null otherwise. Defensive — manifests served from
 * an arbitrary URL must not crash the runtime.
 */
function validateManifest(value: unknown): ModelManifest | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ModelManifest>;
  if (!Array.isArray(candidate.models)) return null;
  if (typeof candidate.updatedAt !== 'string') return null;
  for (const model of candidate.models) {
    if (!model || typeof model !== 'object') return null;
    const m = model as Partial<ModelManifestEntry>;
    if (typeof m.id !== 'string') return null;
    if (typeof m.contextLength !== 'number' || !Number.isFinite(m.contextLength)) return null;
    if (typeof m.supportsTools !== 'boolean') return null;
    if (typeof m.supportsImages !== 'boolean') return null;
    if (typeof m.supportsStreaming !== 'boolean') return null;
  }
  return candidate as ModelManifest;
}

/**
 * Load the model manifest. Cached in-memory keyed by URL with a 24h TTL and
 * ETag revalidation. Fails open: any fetch/parse error returns the bundled
 * fallback so the caller never has to handle a manifest-load failure.
 */
export async function loadManifest(
  url: string = DEFAULT_MANIFEST_URL,
  cache: ManifestCache = defaultCache,
): Promise<ModelManifest> {
  const now = Date.now();
  const cached = cache.get(url);

  // Fresh cache hit
  if (cached && now - cached.fetchedAt < ONE_DAY_MS) {
    return cached.manifest;
  }

  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (cached?.etag) {
      headers['if-none-match'] = cached.etag;
    }

    const response = await fetch(url, { headers });

    // 304 Not Modified — refresh the timestamp so we don't re-validate every call
    if (response.status === 304 && cached) {
      cache.set(url, { ...cached, fetchedAt: now });
      return cached.manifest;
    }

    if (!response.ok) {
      // Stale-while-error: serve the stale cache if we have it, otherwise fallback
      return cached?.manifest ?? FALLBACK_MANIFEST;
    }

    const parsed = (await response.json()) as unknown;
    const manifest = validateManifest(parsed);
    if (!manifest) {
      return cached?.manifest ?? FALLBACK_MANIFEST;
    }

    const etag = response.headers.get('etag') ?? undefined;
    cache.set(url, {
      manifest,
      fetchedAt: now,
      ...(etag ? { etag } : {}),
    });
    return manifest;
  } catch {
    // Fail-open on any fetch/JSON/network error
    return cached?.manifest ?? FALLBACK_MANIFEST;
  }
}

/**
 * Look up a model entry from a manifest by id. Returns null when not found.
 */
export function findModelEntry(
  manifest: ModelManifest,
  modelId: string,
): ModelManifestEntry | null {
  return manifest.models.find((m) => m.id === modelId) ?? null;
}

/**
 * Convenience: resolve context length for a given model id from a manifest,
 * falling back to a caller-provided default when the model is unknown.
 */
export function resolveContextLengthFromManifest(
  manifest: ModelManifest,
  modelId: string,
  fallback: number,
): number {
  const entry = findModelEntry(manifest, modelId);
  return entry?.contextLength ?? fallback;
}

// ---------------------------------------------------------------------------
// Issue #81: Plugin manifest cold-read
// ---------------------------------------------------------------------------

/**
 * Issue #81: Minimal shape of the `modelCatalog` block expected on a plugin
 * manifest. Plugins (declared in `packages/plugins/src/contracts.ts`, owned by
 * a sibling team) ship this so the runtime can hydrate context-length
 * lookups *cold* — without paying the round-trip to the remote manifest URL
 * during startup.
 *
 * The shape is intentionally a strict subset of {@link ModelManifest}: every
 * model entry must include the same flags so cached lookups (vision/tools/
 * streaming caps) work identically whether they came from cold-read or
 * remote fetch.
 */
export interface PluginManifestModelCatalog {
  /** ISO date string. Used as the manifest's updatedAt when seeded. */
  updatedAt?: string;
  models: ModelManifestEntry[];
}

/**
 * Issue #81: Type guard for a plugin manifest carrying a `modelCatalog` block.
 * Accepts unknown input so callers can pass raw JSON without pre-validation.
 */
export function hasPluginManifestModelCatalog(
  manifest: unknown,
): manifest is { modelCatalog: PluginManifestModelCatalog } {
  if (!manifest || typeof manifest !== 'object') return false;
  const candidate = (manifest as { modelCatalog?: unknown }).modelCatalog;
  if (!candidate || typeof candidate !== 'object') return false;
  const catalog = candidate as Partial<PluginManifestModelCatalog>;
  return Array.isArray(catalog.models);
}

/**
 * Issue #81: Convert a plugin manifest's `modelCatalog` block into the shared
 * {@link ModelManifest} shape. Defensive — invalid entries are filtered out so
 * a malformed plugin manifest cannot crash provider startup. Returns null when
 * the plugin has no usable catalog.
 */
export function readPluginManifestModelCatalog(
  manifest: unknown,
): ModelManifest | null {
  if (!hasPluginManifestModelCatalog(manifest)) return null;
  const catalog = manifest.modelCatalog;
  const models: ModelManifestEntry[] = [];
  for (const raw of catalog.models) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Partial<ModelManifestEntry>;
    if (typeof m.id !== 'string') continue;
    if (typeof m.contextLength !== 'number' || !Number.isFinite(m.contextLength)) continue;
    if (typeof m.supportsTools !== 'boolean') continue;
    if (typeof m.supportsImages !== 'boolean') continue;
    if (typeof m.supportsStreaming !== 'boolean') continue;
    models.push({
      id: m.id,
      contextLength: m.contextLength,
      supportsTools: m.supportsTools,
      supportsImages: m.supportsImages,
      supportsStreaming: m.supportsStreaming,
    });
  }
  if (models.length === 0) return null;
  return {
    updatedAt: typeof catalog.updatedAt === 'string' ? catalog.updatedAt : new Date().toISOString().slice(0, 10),
    models,
  };
}

/**
 * Issue #81: Seed the in-memory manifest cache from a plugin's `modelCatalog`
 * for the given URL key (defaulting to {@link DEFAULT_MANIFEST_URL}). Use this
 * during runtime startup so the *first* `loadManifest` call serves from cache
 * with no network round-trip. Subsequent calls past the 24h TTL still
 * revalidate against the remote URL.
 *
 * Returns true when a catalog was seeded, false when the manifest had no
 * usable `modelCatalog` block.
 */
export function seedManifestCacheFromPlugin(
  manifest: unknown,
  options?: { url?: string; cache?: ManifestCache; now?: () => number },
): boolean {
  const seeded = readPluginManifestModelCatalog(manifest);
  if (!seeded) return false;
  const cache = options?.cache ?? defaultCache;
  const url = options?.url ?? DEFAULT_MANIFEST_URL;
  const now = options?.now ?? Date.now;
  cache.set(url, {
    manifest: seeded,
    fetchedAt: now(),
    // No etag — a remote 304 path won't trigger; next 24h-expiry refetch will
    // populate one.
  });
  return true;
}
