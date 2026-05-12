import { setTelegramWebhook } from '@crowclaw/gateway';
import { pruneOrphanCheckpoints, formatPruneSummary, runFts5TrigramMigration, type OrphanPruneResult } from '@crowclaw/storage';
import type { D1DatabaseLike } from '@crowclaw/shared';
import { join } from 'node:path';
import type { RuntimeConfigStore } from './config-store.js';
import type { Logger } from './logger.js';
import type { NodeRuntimeOptions } from './runtime-support.js';

export function warnWhenDashboardTokenMissing(ctx: {
  dashboardTokenReady: Promise<void>;
  getDashboardToken: () => string | undefined;
  options: NodeRuntimeOptions;
  isLocalhostAddress: (hostname: string) => boolean;
  log: Logger;
}): void {
  void ctx.dashboardTokenReady.then(() => {
    if (ctx.getDashboardToken()) return;
    const bindHost = ctx.options.hostname ?? '127.0.0.1';
    if (!ctx.isLocalhostAddress(bindHost)) {
      ctx.log.error('CROWCLAW_DASHBOARD_TOKEN is not set on non-localhost — admin API routes are unauthenticated', { component: 'security', bindHost });
    } else {
      ctx.log.warn('CROWCLAW_DASHBOARD_TOKEN is not set — dangerous routes disabled', { component: 'security' });
    }
  });
}

export function configureTelegramWebhookStartup(ctx: {
  options: NodeRuntimeOptions;
  runtimeEnv: Record<string, string | undefined>;
  configStore: RuntimeConfigStore;
  log: Logger;
}): string | null | undefined {
  let publicUrl: string | null | undefined = ctx.options.publicUrl ?? ctx.runtimeEnv.CROWCLAW_PUBLIC_URL;
  if (ctx.configStore.getPublicUrl()) publicUrl = ctx.configStore.getPublicUrl();
  else if (publicUrl) ctx.configStore.setRemoteAccess(publicUrl, ctx.configStore.getTrustProxy());
  if (ctx.options.trustProxy && !ctx.configStore.getTrustProxy()) {
    ctx.configStore.setRemoteAccess(ctx.configStore.getPublicUrl(), true);
  }
  if (!publicUrl) return publicUrl;

  const telegramConfig = ctx.configStore.getGatewayConfig('telegram');
  const telegramToken = telegramConfig?.token ?? ctx.runtimeEnv.CROWCLAW_TELEGRAM_TOKEN;
  if (!telegramToken || telegramConfig?.enabled === false) return publicUrl;

  const webhookUrl = `${publicUrl.replace(/\/$/, '')}/webhooks/telegram`;
  if (!webhookUrl.startsWith('https://')) {
    ctx.log.warn('Telegram webhook auto-registration skipped: publicUrl must use HTTPS', { component: 'gateway', publicUrl });
    return publicUrl;
  }

  const webhookSecret = ctx.options.telegramWebhookSecret ?? telegramConfig?.webhookSecret;
  setTelegramWebhook(telegramToken, webhookUrl, { secretToken: webhookSecret }).then((result) => {
    if (result.ok) {
      ctx.log.info('Telegram webhook registered', { component: 'gateway', webhookUrl });
    } else {
      ctx.log.error('Telegram webhook registration failed', { component: 'gateway', description: result.description ?? 'unknown error' });
    }
  }).catch((error: unknown) => {
    ctx.log.error('Telegram webhook registration error', { component: 'gateway', error: error instanceof Error ? error.message : String(error) });
  });
  return publicUrl;
}

/**
 * #338 (v0.9.0 Hermes parity): walk the checkpoint root at startup, move
 * orphan + stale shadow directories to `.trash/`, and permanently delete
 * `.trash/` entries from a previous cycle. No-ops cleanly when the
 * checkpoint root doesn't exist yet (first-run, in-memory deployments).
 *
 * Best-effort — pruner errors are logged but never abort the runtime.
 * Stale-detection threshold and trash retention are configurable via
 * `options.checkpointStaleAfterDays` / `options.checkpointTrashRetentionDays`
 * with sensible defaults (60 / 7).
 */
export async function pruneCheckpointStartup(ctx: {
  options: NodeRuntimeOptions & {
    checkpointStaleAfterDays?: number;
    checkpointTrashRetentionDays?: number;
  };
  knownSessionIds: () => Promise<Set<string>>;
  log: Logger;
}): Promise<OrphanPruneResult | null> {
  const baseDir = checkpointBaseDir(ctx.options);
  if (!baseDir) return null;

  try {
    const result = await pruneOrphanCheckpoints({
      baseDir,
      knownSessionIds: ctx.knownSessionIds,
      staleAfterDays: ctx.options.checkpointStaleAfterDays,
      trashRetentionDays: ctx.options.checkpointTrashRetentionDays,
    });
    ctx.log.info(`Checkpoint pruner: ${formatPruneSummary(result)}`, {
      component: 'checkpoint',
      orphans: result.orphansTrashed,
      stale: result.staleTrashed,
      evicted: result.trashEvicted,
    });
    return result;
  } catch (error: unknown) {
    ctx.log.warn('Checkpoint pruner failed', {
      component: 'checkpoint',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * #338: derive the checkpoint base directory from runtime options. Mirrors
 * the path resolution in `FileCheckpointStore` so the pruner sweeps the
 * same tree the store writes into. Returns null when persistence is
 * explicitly disabled (no `dataDir`, no env var, no HOME) so callers can
 * skip the pruner cleanly.
 */
function checkpointBaseDir(options: NodeRuntimeOptions): string | null {
  const env = (typeof process !== 'undefined' && process.env) ? process.env : {} as Record<string, string | undefined>;
  const dataRoot = options.dataDir ?? env.CROWCLAW_DATA_DIR ?? (env.HOME ? join(env.HOME, '.crowclaw') : null);
  if (!dataRoot) return null;
  return join(dataRoot, 'checkpoints');
}

/**
 * #337 (v0.9.0 Hermes parity): run the FTS5 trigram migration on the
 * SQLite-backed memory + transcript tables so CJK substring search hits
 * the FTS index instead of falling back to LIKE. No-op when no SQLite-like
 * DB is wired into the runtime (the default in-memory store has its own
 * search path that doesn't go through FTS5).
 */
export async function runFts5MigrationStartup(ctx: {
  db?: D1DatabaseLike;
  log: Logger;
}): Promise<void> {
  if (!ctx.db) return;
  try {
    const results = await runFts5TrigramMigration(ctx.db);
    const summary = results
      .filter((r) => r.status !== 'absent')
      .map((r) => `${r.table}=${r.status}${r.rowsIndexed !== undefined ? `(${r.rowsIndexed})` : ''}`)
      .join(', ');
    if (summary) {
      ctx.log.info(`FTS5 trigram migration: ${summary}`, { component: 'storage' });
    }
  } catch (error: unknown) {
    ctx.log.warn('FTS5 trigram migration failed', {
      component: 'storage',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
