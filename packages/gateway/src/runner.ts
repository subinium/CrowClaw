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
  scrubBotToken,
  sendTelegramMessage,
} from './index.js';
import { executeWithRetry } from './retry.js';
import { PlatformRateLimiter } from './platform-rate-limiter.js';

// ---------------------------------------------------------------------------
// Issue #109: Minimal p-limit-style concurrency gate.
//
// The Telegram polling loop used to await `onMessage` per update sequentially.
// A burst of 10 messages serialized 10 LLM calls for users in different chats.
// This gate runs up to `max` updates concurrently. Kept inline so the gateway
// stays zero-dep (matching the comment at the top of `index.ts`).
// ---------------------------------------------------------------------------
function createConcurrencyLimiter(
  max: number,
): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) run();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active += 1;
        Promise.resolve()
          .then(fn)
          .then(
            (value) => {
              active -= 1;
              resolve(value);
              next();
            },
            (err: unknown) => {
              active -= 1;
              reject(err);
              next();
            },
          );
      };
      if (active < limit) start();
      else queue.push(start);
    });
}

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
    // Issue #134: scrub bot token from any error message (URL or body) before
    // it bubbles up to status payloads or logs.
    return { ok: false, error: scrubBotToken(error instanceof Error ? error.message : String(error)) };
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
    // Issue #134: scrub bot token from any error message before it surfaces.
    return { ok: false, updates: [], error: scrubBotToken(error instanceof Error ? error.message : String(error)) };
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
  // Issue #109: bound concurrent update handling so a 10-message burst does
  // not serialize 10 LLM calls. 3 keeps Telegram from running out of typing
  // indicators or hitting per-chat rate caps while still parallelising.
  private readonly updateLimiter = createConcurrencyLimiter(3);

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
      // Issue #134: scrub bot token from getMe error before storing in status —
      // this string is returned by /api/gateway/status (a localhost-bypass route).
      const status: GatewayStatus = {
        platform: 'telegram',
        connected: false,
        error: me.error ? scrubBotToken(me.error) : me.error,
      };
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
        // Update status with error but keep trying.
        // Issue #134: scrub any leaked bot token from `result.error` before
        // storing — this string is exposed by /api/gateway/status.
        const status = this.statuses.get('telegram');
        if (status && result.error !== 'aborted') {
          status.error = result.error ? scrubBotToken(result.error) : result.error;
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

      // Advance offset for every update synchronously so we don't re-fetch
      // the same updates if a concurrent handler is still in flight when the
      // next poll fires.
      for (const update of result.updates) {
        if (update.update_id !== undefined) {
          poller.offset = update.update_id + 1;
        }
      }

      // Issue #109: handle the batch concurrently with bounded p-limit so a
      // burst of 10 messages does not serialize 10 LLM calls. We still
      // `await` the whole batch before returning to the polling cycle to
      // preserve back-pressure against runaway provider failures.
      await Promise.all(
        result.updates.map((update) =>
          this.updateLimiter(() => this.handleTelegramUpdate(poller, update)),
        ),
      );

      // Small interval between polls to avoid hammering
      if (result.updates.length === 0) {
        await this.sleep(intervalMs, poller.abortController.signal);
      }
    }
  }

  /**
   * Issue #109: per-update handler extracted so the polling loop can dispatch
   * with `p-limit(3)`. Mirrors the previous inline body byte-for-byte (typing
   * indicator semantics from #102 preserved).
   */
  private async handleTelegramUpdate(
    poller: TelegramPollerState,
    update: TelegramUpdate,
  ): Promise<void> {
    const normalized = normalizeTelegramWebhook(update);
    if (!normalized) return;
    if (!this.config.onMessage) return;

    // Issue #102: Wrap the typing indicator in try/finally that spans
    // BOTH onMessage AND the send path. Previously, `typing.stop()` was
    // called immediately after onMessage resolved, leaving the indicator
    // stopped while the send was still in flight (so the user saw
    // "online, not typing" during a possibly-long retry). On the error
    // path, the catch handler stopped it but did not protect the send
    // call itself. The `finally` block guarantees the indicator is
    // always stopped exactly once, regardless of where we exit.
    const typing = createTypingIndicator(poller.botToken, normalized.channelId);
    try {
      const reply = await this.config.onMessage(normalized);
      if (reply) {
        // Per-platform rate limit check — delay instead of dropping
        if (!this.platformRateLimiter.check('telegram')) {
          const limit = this.platformRateLimiter.getLimit('telegram');
          const delayMs = Math.ceil(60_000 / limit.maxPerMinute);
          await this.sleep(delayMs, poller.abortController.signal);
        }
        // Retry with exponential backoff on send failure
        const retryPolicy = buildGatewayRetryPolicy('telegram');
        const sendResult = await executeWithRetry(
          () => sendTelegramMessage(poller.botToken, normalized.channelId, reply, { parseMode: 'Markdown' }),
          retryPolicy,
          poller.abortController.signal,
        );
        if (!sendResult.ok) {
          // Log retry exhaustion — reply is lost after all attempts failed.
          // Issue #134: scrub any bot token that leaked into lastError.
          const errMsg = scrubBotToken(sendResult.lastError ?? 'unknown');
          try { await sendTelegramMessage(poller.botToken, normalized.channelId, 'Sorry, I encountered an error sending my response.', {}); } catch { /* best-effort fallback */ }
          void errMsg; // Consumed by future structured logging integration
        }
      }
    } catch {
      // Silently handle callback or send errors to keep polling alive.
      // The `finally` clause below stops the typing indicator either way.
    } finally {
      typing.stop();
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let onAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

// Re-export for convenience
export { telegramGetMe, telegramGetUpdates };
