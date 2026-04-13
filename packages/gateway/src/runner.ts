/**
 * GatewayRunner — auto-starts platform listeners (long-polling, websocket, etc.)
 *
 * v0.1.3: Telegram long-polling is the first real implementation.
 * Other platforms show "webhook required" or "requires <dependency>" status.
 */

import {
  type GatewayPlatform,
  type NormalizedInboundMessage,
  type TelegramUpdate,
  buildTelegramApiBase,
  buildGatewayRetryPolicy,
  createTypingIndicator,
  normalizeTelegramWebhook,
  sendTelegramMessage,
} from './index.js';
import { executeWithRetry } from './retry.js';
import { PlatformRateLimiter } from './platform-rate-limiter.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GatewayRunnerPlatformConfig {
  name: string;
  token: string;
  enabled: boolean;
}

export interface GatewayRunnerConfig {
  platforms: GatewayRunnerPlatformConfig[];
  onMessage?: (normalized: NormalizedInboundMessage) => Promise<string>;
  /** Polling interval in ms for long-polling transports (default 1000) */
  pollIntervalMs?: number;
}

export interface GatewayStatus {
  platform: string;
  connected: boolean;
  error?: string;
  botName?: string;
}

// ---------------------------------------------------------------------------
// Internal: Telegram long-polling transport
// ---------------------------------------------------------------------------

interface TelegramPollerState {
  botToken: string;
  offset: number;
  running: boolean;
  abortController: AbortController;
  botName?: string;
  error?: string;
}

async function telegramGetMe(botToken: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const url = `${buildTelegramApiBase(botToken)}/getMe`;
    const res = await fetch(url);
    const data = await res.json() as { ok?: boolean; result?: { username?: string } };
    if (data.ok && data.result) {
      return { ok: true, username: data.result.username };
    }
    return { ok: false, error: 'Invalid bot token' };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function telegramGetUpdates(
  botToken: string,
  offset: number,
  signal: AbortSignal,
  timeoutSec = 30,
): Promise<{ ok: boolean; updates: TelegramUpdate[]; error?: string }> {
  try {
    const url = `${buildTelegramApiBase(botToken)}/getUpdates`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset, timeout: timeoutSec }),
      signal,
    });
    const data = await res.json() as { ok?: boolean; result?: TelegramUpdate[] };
    if (data.ok && Array.isArray(data.result)) {
      return { ok: true, updates: data.result };
    }
    return { ok: false, updates: [], error: 'getUpdates failed' };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, updates: [], error: 'aborted' };
    }
    return { ok: false, updates: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// GatewayRunner
// ---------------------------------------------------------------------------

export class GatewayRunner {
  private config: GatewayRunnerConfig;
  private statuses: Map<string, GatewayStatus> = new Map();
  private telegramPollers: Map<string, TelegramPollerState> = new Map();
  private running = false;
  private readonly platformRateLimiter = new PlatformRateLimiter();

  constructor(config: GatewayRunnerConfig) {
    this.config = config;
  }

  /** Start listening on all configured & enabled platforms. */
  async start(): Promise<GatewayStatus[]> {
    if (this.running) return this.getStatus();
    this.running = true;

    const results: GatewayStatus[] = [];

    for (const platform of this.config.platforms) {
      if (!platform.enabled) {
        const status: GatewayStatus = { platform: platform.name, connected: false, error: 'disabled' };
        this.statuses.set(platform.name, status);
        results.push(status);
        continue;
      }

      if (platform.name === 'telegram') {
        const status = await this.startTelegram(platform.token);
        results.push(status);
      } else if (platform.name === 'discord') {
        const status: GatewayStatus = { platform: 'discord', connected: false, error: 'requires discord.js' };
        this.statuses.set('discord', status);
        results.push(status);
      } else if (platform.name === 'slack') {
        const status: GatewayStatus = { platform: 'slack', connected: false, error: 'requires webhook or socket mode setup' };
        this.statuses.set('slack', status);
        results.push(status);
      } else {
        const status: GatewayStatus = { platform: platform.name, connected: false, error: 'coming soon' };
        this.statuses.set(platform.name, status);
        results.push(status);
      }
    }

    return results;
  }

  /** Stop all listeners. */
  async stop(): Promise<void> {
    this.running = false;

    // Abort all Telegram pollers
    for (const [name, poller] of this.telegramPollers) {
      poller.running = false;
      poller.abortController.abort();
      const status = this.statuses.get(name);
      if (status) {
        status.connected = false;
      }
    }
    this.telegramPollers.clear();
  }

  /** Get current status of all platforms. */
  getStatus(): GatewayStatus[] {
    return [...this.statuses.values()];
  }

  /** Whether the runner is actively running. */
  isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Telegram long-polling
  // -------------------------------------------------------------------------

  private async startTelegram(botToken: string): Promise<GatewayStatus> {
    const me = await telegramGetMe(botToken);

    if (!me.ok) {
      const status: GatewayStatus = { platform: 'telegram', connected: false, error: me.error };
      this.statuses.set('telegram', status);
      return status;
    }

    const botName = me.username ? `@${me.username}` : undefined;
    const status: GatewayStatus = { platform: 'telegram', connected: true, botName };
    this.statuses.set('telegram', status);

    const abortController = new AbortController();
    const pollerState: TelegramPollerState = {
      botToken,
      offset: 0,
      running: true,
      abortController,
      botName,
    };
    this.telegramPollers.set('telegram', pollerState);

    // Start polling loop in background (non-blocking)
    void this.telegramPollLoop(pollerState);

    return status;
  }

  private async telegramPollLoop(poller: TelegramPollerState): Promise<void> {
    const intervalMs = this.config.pollIntervalMs ?? 1000;

    while (poller.running && this.running) {
      const result = await telegramGetUpdates(
        poller.botToken,
        poller.offset,
        poller.abortController.signal,
      );

      if (!poller.running || !this.running) break;

      if (!result.ok) {
        // Update status with error but keep trying
        const status = this.statuses.get('telegram');
        if (status && result.error !== 'aborted') {
          status.error = result.error;
        }
        // Back off on error
        await this.sleep(intervalMs * 3, poller.abortController.signal);
        continue;
      }

      // Clear any previous error on success
      const status = this.statuses.get('telegram');
      if (status) {
        status.error = undefined;
      }

      for (const update of result.updates) {
        // Advance offset past this update
        if (update.update_id !== undefined) {
          poller.offset = update.update_id + 1;
        }

        const normalized = normalizeTelegramWebhook(update);
        if (!normalized) continue;

        if (this.config.onMessage) {
          const typing = createTypingIndicator(poller.botToken, normalized.channelId);
          try {
            const reply = await this.config.onMessage(normalized);
            typing.stop();
            if (reply) {
              // Per-platform rate limit check
              if (!this.platformRateLimiter.check('telegram')) {
                // Rate limited — skip this reply silently
                continue;
              }
              // Retry with exponential backoff on send failure
              const retryPolicy = buildGatewayRetryPolicy('telegram');
              await executeWithRetry(
                () => sendTelegramMessage(poller.botToken, normalized.channelId, reply, { parseMode: 'Markdown' }),
                retryPolicy,
                poller.abortController.signal,
              );
            }
          } catch {
            typing.stop();
            // Silently handle callback errors to keep polling alive
          }
        }
      }

      // Small interval between polls to avoid hammering
      if (result.updates.length === 0) {
        await this.sleep(intervalMs, poller.abortController.signal);
      }
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

// Re-export for convenience
export { telegramGetMe, telegramGetUpdates };
