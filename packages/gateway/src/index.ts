export type GatewayPlatform = 'webhook' | 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'signal' | 'email' | 'matrix' | 'sms';

// Inline URL safety check (gateway is zero-dep, cannot import from @crowclaw/core).
// Patterns kept in sync with `packages/core/src/security.ts` PRIVATE_IP_PATTERNS —
// update both when changing. IPv4-mapped IPv6, CGNAT, and multicast ranges included
// to close v0.3.6 audit gaps.
function validateFetchUrl(url: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
    const h = parsed.hostname.replace(/^\[|\]$/g, '');
    if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|23\d\.|localhost$|.*\.local$|.*\.internal$)/i.test(h)) return { safe: false, reason: 'Private network' };
    if (/^(fc00:|fd[0-9a-f]{2}:|fe80:|ff[0-9a-f]{2}:|::ffff:|0:0:0:0:0:ffff:|0:0:0:0:0:0:|::1$|::$)/i.test(h)) return { safe: false, reason: 'Private network' };
    return { safe: true };
  } catch { return { safe: false, reason: 'Invalid URL' }; }
}

// ---------------------------------------------------------------------------
// Issue #134: Bot-token scrubbing for error messages and URLs.
//
// Telegram puts the bot token directly in the URL path (`/bot<TOKEN>/...`),
// so any stack trace, fetch error, or proxy-debug log can leak it. Scrub
// before storing in `status.error` (returned by /api/gateway/status) or
// emitting to logs. The pattern matches Telegram bot tokens specifically:
// digits, colon, then base64url-ish body. Other platforms with tokens-in-URL
// (none today, but future-proof) can be added here.
// ---------------------------------------------------------------------------

const BOT_TOKEN_PATTERN = /bot\d+:[A-Za-z0-9_-]+/g;

/**
 * Replace any Telegram-style bot token (`bot<digits>:<base64url>`) with
 * `bot[REDACTED]` so secrets never escape into status payloads or logs.
 * Returns the input unchanged when it contains no token.
 */
export function scrubBotToken(text: string): string {
  if (!text) return text;
  return text.replace(BOT_TOKEN_PATTERN, 'bot[REDACTED]');
}

// ---------------------------------------------------------------------------
// Issue #69: WebSocket auth rate limiter with exponential backoff bans.
//
// The runtime-node `/ws` upgrade path used to be unprotected: an attacker
// could brute-force the dashboard token at HTTP-handshake speed. This
// limiter is shared between gateway and runtime-node so the same per-IP
// budget governs every WS auth attempt.
//
// Counts only *failed* auth attempts (the caller decides what counts as
// failure). After `maxAttempts` failures inside `windowMs`, the IP is
// banned for `baseBanMs * 2^N` (capped at `maxBanMs`), where N is the
// number of consecutive ban escalations. A successful auth resets both
// the failure window AND the ban escalation counter for that IP.
// ---------------------------------------------------------------------------

export interface WsAuthRateLimiterOptions {
  /** Failed-attempt cap inside `windowMs` before the IP is banned. Default 5. */
  maxAttempts?: number;
  /** Sliding window for counting failures. Default 60_000 ms (1 minute). */
  windowMs?: number;
  /** Initial ban duration. Default 5 * 60_000 ms (5 minutes). */
  baseBanMs?: number;
  /** Hard cap on exponential ban duration. Default 60 * 60_000 ms (1 hour). */
  maxBanMs?: number;
  /** Soft cap on tracked IPs to bound memory. Default 10_000. */
  maxKeys?: number;
}

export interface WsAuthRateLimiterDecision {
  /** True if the upgrade should proceed to auth, false if it must be rejected. */
  allowed: boolean;
  /** Seconds until the ban lifts. Always present when `allowed` is false. */
  retryAfterSec?: number;
  /** Reason code for logging. */
  reason?: 'rate-limited' | 'banned';
}

/**
 * Per-IP WebSocket auth rate limiter with exponential backoff bans (issue #69).
 *
 * Usage:
 *   const limiter = new WsAuthRateLimiter();
 *   const decision = limiter.beforeAuth(clientIp);
 *   if (!decision.allowed) return new Response('Too many attempts', { status: 429, headers: { 'Retry-After': String(decision.retryAfterSec) } });
 *   const ok = await checkAuth(...);
 *   if (ok) limiter.recordSuccess(clientIp); else limiter.recordFailure(clientIp);
 */
export class WsAuthRateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly baseBanMs: number;
  private readonly maxBanMs: number;
  private readonly maxKeys: number;

  // Per-IP failure timestamps inside the sliding window.
  private readonly failures = new Map<string, number[]>();
  // Per-IP ban entry: { until: epoch ms when the ban lifts, level: # of escalations so far }.
  private readonly bans = new Map<string, { until: number; level: number }>();

  constructor(opts?: WsAuthRateLimiterOptions) {
    this.maxAttempts = Math.max(1, opts?.maxAttempts ?? 5);
    this.windowMs = Math.max(1_000, opts?.windowMs ?? 60_000);
    this.baseBanMs = Math.max(1_000, opts?.baseBanMs ?? 5 * 60_000);
    this.maxBanMs = Math.max(this.baseBanMs, opts?.maxBanMs ?? 60 * 60_000);
    this.maxKeys = Math.max(100, opts?.maxKeys ?? 10_000);
  }

  /**
   * Check whether `ip` may proceed to auth. Call this before reading or
   * comparing the auth credential. Returns a decision; on `allowed: false`
   * the caller must short-circuit with 429 and respect `retryAfterSec`.
   */
  beforeAuth(ip: string): WsAuthRateLimiterDecision {
    const now = Date.now();
    const ban = this.bans.get(ip);
    if (ban && ban.until > now) {
      return { allowed: false, retryAfterSec: Math.ceil((ban.until - now) / 1000), reason: 'banned' };
    }
    if (ban && ban.until <= now) {
      // Ban window passed but escalation level is preserved so the next
      // burst lands a longer ban. We only forget the ban entirely after a
      // verified success (recordSuccess) — see resetEscalation below.
      this.bans.delete(ip);
      // Re-insert with `until = 0` so the level survives the prune scan.
      this.bans.set(ip, { until: 0, level: ban.level });
    }
    // Even outside an active ban, if we already have N failures in the
    // window we deny pre-emptively to avoid a thundering herd while the
    // ban transition is being computed by recordFailure.
    const recent = this.failures.get(ip);
    if (recent) {
      const cutoff = now - this.windowMs;
      while (recent.length > 0 && recent[0]! <= cutoff) recent.shift();
      if (recent.length >= this.maxAttempts) {
        // Emit a fresh ban so the caller can include Retry-After.
        const ban2 = this.bans.get(ip);
        const level = (ban2?.level ?? 0) + 1;
        const banMs = Math.min(this.maxBanMs, this.baseBanMs * Math.pow(2, Math.max(0, level - 1)));
        const until = now + banMs;
        this.bans.set(ip, { until, level });
        // Clear failure window — replay protection now lives in the ban.
        this.failures.delete(ip);
        this.evictIfNeeded();
        return { allowed: false, retryAfterSec: Math.ceil(banMs / 1000), reason: 'rate-limited' };
      }
    }
    return { allowed: true };
  }

  /** Record a failed auth attempt. Triggers a ban once threshold is reached. */
  recordFailure(ip: string): void {
    const now = Date.now();
    let arr = this.failures.get(ip);
    if (!arr) {
      arr = [];
      this.failures.set(ip, arr);
    }
    const cutoff = now - this.windowMs;
    while (arr.length > 0 && arr[0]! <= cutoff) arr.shift();
    arr.push(now);
    if (arr.length >= this.maxAttempts) {
      const existing = this.bans.get(ip);
      const level = (existing?.level ?? 0) + 1;
      const banMs = Math.min(this.maxBanMs, this.baseBanMs * Math.pow(2, Math.max(0, level - 1)));
      this.bans.set(ip, { until: now + banMs, level });
      this.failures.delete(ip);
    }
    this.evictIfNeeded();
  }

  /** Record a successful auth. Clears failures and ban-escalation level. */
  recordSuccess(ip: string): void {
    this.failures.delete(ip);
    this.bans.delete(ip);
  }

  /** Test hook — clear all state. */
  reset(): void {
    this.failures.clear();
    this.bans.clear();
  }

  /** Test hook — peek at current ban for `ip`, or `null` if none. */
  getBan(ip: string): { until: number; level: number } | null {
    return this.bans.get(ip) ?? null;
  }

  /** Test hook — current failure count inside the active window. */
  getFailureCount(ip: string): number {
    const arr = this.failures.get(ip);
    if (!arr) return 0;
    const cutoff = Date.now() - this.windowMs;
    let live = 0;
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      if (arr[i]! > cutoff) live += 1;
      else break;
    }
    return live;
  }

  /** Bound memory: drop oldest tracked IPs once we exceed maxKeys. */
  private evictIfNeeded(): void {
    if (this.failures.size > this.maxKeys) {
      const overflow = this.failures.size - this.maxKeys;
      let removed = 0;
      for (const k of this.failures.keys()) {
        if (removed >= overflow) break;
        this.failures.delete(k);
        removed += 1;
      }
    }
    if (this.bans.size > this.maxKeys) {
      const overflow = this.bans.size - this.maxKeys;
      let removed = 0;
      for (const k of this.bans.keys()) {
        if (removed >= overflow) break;
        this.bans.delete(k);
        removed += 1;
      }
    }
  }
}

export interface NormalizedInboundMessage {
  platform: GatewayPlatform;
  channelId: string;
  userId?: string;
  text: string;
  raw: unknown;
  receivedAt: string;
  externalChatId: string;
  externalUserId?: string;
  deliveryId?: string;
}

// --- Access Policy System (inspired by OpenClaw) ---

export type DmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';
export type GroupPolicy = 'open' | 'disabled' | 'allowlist';

export interface ChannelAccessPolicy {
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  allowlist: string[];       // Allowed sender IDs
  groupAllowlist: string[];  // Allowed group IDs
  requireMention: boolean;   // For groups: only respond when @mentioned
}

export interface PairingChallenge {
  code: string;
  platform: GatewayPlatform;
  senderId: string;
  senderName?: string;
  channelId: string;
  createdAt: string;
  expiresAt: string;
}

export interface AccessDecision {
  allowed: boolean;
  reason: 'allowed' | 'allowlisted' | 'open-policy' | 'pairing-required' | 'denied' | 'disabled' | 'not-in-allowlist' | 'group-disabled' | 'mention-required';
  pairingCode?: string;
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O/0/I/1

export function generatePairingCode(length = 8): string {
  let code = '';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (const byte of array) {
    code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  }
  return code;
}

export function createDefaultAccessPolicy(): ChannelAccessPolicy {
  return {
    dmPolicy: 'pairing',
    groupPolicy: 'open',
    allowlist: [],
    groupAllowlist: [],
    requireMention: true,
  };
}

export function evaluateAccess(
  message: NormalizedInboundMessage,
  policy: ChannelAccessPolicy,
  isGroup: boolean,
  pendingPairings: Map<string, PairingChallenge>,
  isMentioned = true
): AccessDecision {
  // Group messages
  if (isGroup) {
    if (policy.groupPolicy === 'disabled') {
      return { allowed: false, reason: 'group-disabled' };
    }
    if (policy.groupPolicy === 'allowlist') {
      const groupAllowed = policy.groupAllowlist.includes(message.channelId) ||
                           policy.groupAllowlist.includes('*');
      if (!groupAllowed) {
        return { allowed: false, reason: 'not-in-allowlist' };
      }
    }
    // Mention gating for groups
    if (policy.requireMention && !isMentioned) {
      return { allowed: false, reason: 'mention-required' };
    }
    // Group policy 'open' or allowlisted
    return { allowed: true, reason: policy.groupPolicy === 'allowlist' ? 'allowlisted' : 'open-policy' };
  }

  // DM messages
  switch (policy.dmPolicy) {
    case 'disabled':
      return { allowed: false, reason: 'disabled' };

    case 'open':
      return { allowed: true, reason: 'open-policy' };

    case 'allowlist': {
      const senderId = message.externalUserId ?? message.userId ?? '';
      const allowed = policy.allowlist.includes(senderId) || policy.allowlist.includes('*');
      return allowed
        ? { allowed: true, reason: 'allowlisted' }
        : { allowed: false, reason: 'not-in-allowlist' };
    }

    case 'pairing': {
      const senderId = message.externalUserId ?? message.userId ?? '';
      // Check if already allowlisted
      if (policy.allowlist.includes(senderId)) {
        return { allowed: true, reason: 'allowlisted' };
      }
      // Check for existing pending pairing
      const existingPairing = pendingPairings.get(`${message.platform}:${senderId}`);
      if (existingPairing && new Date(existingPairing.expiresAt) > new Date()) {
        return { allowed: false, reason: 'pairing-required', pairingCode: existingPairing.code };
      }
      // Generate new pairing code
      const code = generatePairingCode();
      const now = new Date();
      const challenge: PairingChallenge = {
        code,
        platform: message.platform,
        senderId,
        senderName: undefined,
        channelId: message.channelId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), // 1 hour
      };
      pendingPairings.set(`${message.platform}:${senderId}`, challenge);
      return { allowed: false, reason: 'pairing-required', pairingCode: code };
    }

    default:
      return { allowed: false, reason: 'denied' };
  }
}

export function approvePairing(
  pendingPairings: Map<string, PairingChallenge>,
  code: string,
  policy: ChannelAccessPolicy
): { approved: boolean; senderId?: string; platform?: GatewayPlatform } {
  for (const [key, challenge] of pendingPairings) {
    if (challenge.code === code.toUpperCase()) {
      pendingPairings.delete(key);
      if (!policy.allowlist.includes(challenge.senderId)) {
        policy.allowlist.push(challenge.senderId);
      }
      return { approved: true, senderId: challenge.senderId, platform: challenge.platform };
    }
  }
  return { approved: false };
}

export interface GenericWebhookPayload {
  channelId?: string;
  chatId?: string;
  userId?: string;
  text?: string;
  message?: string;
  [key: string]: unknown;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    from?: { id?: number; username?: string };
    chat?: { id?: number | string; type?: string };
  };
}

export interface DiscordInteractionPayload {
  channel_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
  data?: { name?: string; options?: Array<{ name?: string; value?: string }> };
}

export interface SlackEventPayload {
  type?: string;
  challenge?: string;
  event?: {
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    subtype?: string;
  };
}

export interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

export interface SignalWebhookPayload {
  envelope?: {
    sourceNumber?: string;
    sourceUuid?: string;
    timestamp?: number;
    dataMessage?: {
      message?: string;
    };
  };
}

export interface EmailWebhookPayload {
  messageId?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  body?: string;
  inboxId?: string;
}

export interface MatrixWebhookPayload {
  eventId?: string;
  roomId?: string;
  sender?: string;
  content?: {
    body?: string;
    msgtype?: string;
  };
  timestamp?: number;
}

export interface SmsWebhookPayload {
  messageId?: string;
  from?: string;
  to?: string;
  text?: string;
  body?: string;
  conversationId?: string;
  timestamp?: number;
}

export interface GatewayBinding {
  platform: GatewayPlatform;
  route: string;
}

export interface TelegramWebhookRouteResult {
  ok: boolean;
  sessionKey?: string;
  message?: NormalizedInboundMessage;
}

export interface TelegramWebhookDispatch {
  sessionId: string;
  payload: {
    userMessage: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface DiscordDispatch {
  sessionId: string;
  payload: {
    userMessage: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface SlackDispatch {
  sessionId: string;
  payload: {
    userMessage: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface WhatsAppDispatch {
  sessionId: string;
  payload: {
    userMessage: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface SignalDispatch {
  sessionId: string;
  payload: {
    userMessage: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface EmailDispatch {
  sessionId: string;
  payload: {
    userMessage: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface MatrixDispatch {
  sessionId: string;
  payload: {
    userMessage: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface SmsDispatch {
  sessionId: string;
  payload: {
    userMessage: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface GatewayRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

/**
 * GatewayConfig — central knobs the gateway honours when dispatching.
 *
 * Currently consumed by:
 *   - Issue #92: `fallbackProviders` ordered chain on primary error.
 *   - Issue #97: `maxRetries` / `maxAttempts` overrides for the retry executor.
 *   - Issue #98: `requestTimeoutMs` provider-level default (model-level wins).
 *
 * Existing runner code does not yet read this directly — it's introduced as
 * the canonical place for builders to attach gateway-wide policy. New
 * dispatch helpers (`executeWithProviderFallback`, `resolveGatewayMaxAttempts`,
 * `resolveGatewayRequestTimeoutMs`) consult it explicitly.
 */
export interface GatewayConfig {
  /**
   * Issue #92: Ordered fallback providers tried on primary failure.
   * The primary is identified by the caller; this list contains *additional*
   * providers in priority order. Empty/undefined disables fallback.
   */
  fallbackProviders?: string[];
  /**
   * Issue #97: Maximum retry attempts the gateway HTTP client should make
   * before giving up. Overrides per-platform `buildGatewayRetryPolicy` when
   * provided. Hermes calls this `api_max_retries`.
   */
  maxRetries?: number;
  /**
   * Issue #98: Provider-level request timeout (ms). Used as the fallback when
   * the chosen model has no explicit `requestTimeoutMs`. Operators usually
   * set this once per gateway and let model-level overrides handle outliers.
   */
  requestTimeoutMs?: number;
  /**
   * Issue #98: Absolute global default timeout (ms). Last-resort fallback
   * when neither model nor provider declared a timeout.
   */
  globalRequestTimeoutMs?: number;
}

/**
 * Issue #97: Resolve the effective max-attempt count for a given platform.
 * Precedence: GatewayConfig.maxRetries → buildGatewayRetryPolicy(platform).maxAttempts.
 *
 * Note: Hermes' `api_max_retries` counts *additional* retries after the first
 * try. Our `maxAttempts` counts total attempts (initial + retries), so we
 * coerce by adding 1.
 */
export function resolveGatewayMaxAttempts(
  platform: GatewayPlatform,
  config?: GatewayConfig,
): number {
  if (config?.maxRetries !== undefined && config.maxRetries >= 0) {
    return config.maxRetries + 1;
  }
  return buildGatewayRetryPolicy(platform).maxAttempts;
}

/**
 * Issue #98: Resolve the effective request timeout (ms).
 * Precedence: model-level → provider/gateway-level → global default.
 * Returns `undefined` when no level configures one.
 *
 * The `modelTimeoutMs` argument is the value resolved upstream from
 * `ModelMetadata.requestTimeoutMs` (see `@crowclaw/providers`).
 */
export function resolveGatewayRequestTimeoutMs(
  modelTimeoutMs: number | undefined,
  config?: GatewayConfig,
): number | undefined {
  if (modelTimeoutMs !== undefined) return modelTimeoutMs;
  if (config?.requestTimeoutMs !== undefined) return config.requestTimeoutMs;
  return config?.globalRequestTimeoutMs;
}

/**
 * Issue #92: Result of a fallback chain attempt. `provider` reports which
 * entry in the chain ultimately succeeded (or the last one tried on failure).
 */
export interface GatewayFallbackResult<T> {
  ok: boolean;
  value?: T;
  provider: string;
  attempts: number;
  /** Each fallback hop in order: { provider, error }. Empty when primary worked. */
  fallbacksUsed: Array<{ from: string; to: string }>;
  lastError?: string;
}

/**
 * Issue #92: Run `op(provider)` against the primary provider, then walk the
 * `fallbackProviders` chain in order on failure. Each hop emits a
 * `gateway:fallback_used` event via the optional `onFallback` hook (the
 * gateway runtime is event-bus agnostic; the caller decides where it goes).
 *
 * `op` should throw or return `{ ok: false }`-shaped values for retryable
 * failure; success is anything else.
 */
export async function executeWithProviderFallback<T>(
  primary: string,
  op: (provider: string) => Promise<T>,
  config?: GatewayConfig,
  onFallback?: (event: { from: string; to: string; reason: string }) => void,
): Promise<GatewayFallbackResult<T>> {
  const chain = [primary, ...(config?.fallbackProviders ?? [])];
  const fallbacksUsed: Array<{ from: string; to: string }> = [];
  let lastError: string | undefined;
  let attempts = 0;

  for (let i = 0; i < chain.length; i += 1) {
    const provider = chain[i]!;
    attempts += 1;
    try {
      const value = await op(provider);
      // Treat `{ ok: false }` shaped responses as failure (mirrors retry.ts).
      if (
        value && typeof value === 'object' && 'ok' in value
        && (value as { ok: unknown }).ok === false
      ) {
        const rawErr = (value as { error?: unknown }).error;
        const errMsg = rawErr instanceof Error
          ? rawErr.message
          : String(rawErr ?? 'operation returned ok:false');
        lastError = errMsg;
        if (i + 1 < chain.length) {
          const next = chain[i + 1]!;
          fallbacksUsed.push({ from: provider, to: next });
          if (onFallback) onFallback({ from: provider, to: next, reason: errMsg });
        }
        continue;
      }
      return { ok: true, value, provider, attempts, fallbacksUsed };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      if (i + 1 < chain.length) {
        const next = chain[i + 1]!;
        fallbacksUsed.push({ from: provider, to: next });
        if (onFallback) onFallback({ from: provider, to: next, reason: lastError });
      }
    }
  }

  return {
    ok: false,
    provider: chain[chain.length - 1] ?? primary,
    attempts,
    fallbacksUsed,
    ...(lastError ? { lastError } : {}),
  };
}

export interface GatewayDeliveryPlan {
  platform: GatewayPlatform;
  sessionId: string;
  retryPolicy: GatewayRetryPolicy;
  idempotencyKey: string | null;
  userMessage: string;
  userId?: string;
  workspaceId?: string;
}

/**
 * Idempotency store for inbound webhook deliveries.
 *
 * `markIfAbsent` is the atomic primitive used by runtimes to decide whether
 * a delivery has already been processed; it returns `true` when the key was
 * newly recorded and `false` when an unexpired entry already existed. The
 * legacy `mark` method remains for backcompat and internally delegates to
 * `markIfAbsent`.
 *
 * Issue #78: Once visible progress occurs (a tool side-effect ran or a token
 * streamed to the user), call `poisonAfterProgress(key)`. After that, any
 * subsequent claim attempt for the same key reports `'poisoned'` rather than
 * silently re-running the side-effect. The runtime surfaces this as 409 to
 * the platform so retried inbound deliveries fail loud instead of replaying.
 */
export type GatewayIdempotencyClaim = 'fresh' | 'duplicate' | 'poisoned';

export interface GatewayIdempotencyStore {
  /**
   * Atomically record `key` if it is not already present.
   * Returns `true` if the key was newly recorded, `false` if a still-valid
   * entry already existed. The optional `ttlMs` overrides the store default.
   *
   * Note: This boolean form is preserved for backcompat. New code should
   * prefer `claim()` so the poisoned state is surfaced.
   */
  markIfAbsent(key: string, ttlMs?: number): Promise<boolean>;
  /**
   * Issue #78: Tri-state claim that distinguishes fresh / duplicate /
   * poisoned. Implementations without poisoning support should return
   * `'fresh' | 'duplicate'` only, matching `markIfAbsent` semantics.
   */
  claim?(key: string, ttlMs?: number): Promise<GatewayIdempotencyClaim>;
  /**
   * Issue #78: Mark `key` as poisoned because visible progress happened.
   * Subsequent `claim` calls return `'poisoned'`; subsequent `markIfAbsent`
   * calls return `false` (a poisoned entry counts as occupied).
   * No-op if the key is unknown or expired.
   */
  poisonAfterProgress?(key: string, ttlMs?: number): Promise<void>;
  /** Remove `key`. Used when downstream processing fails and the caller
   * wants the next retry delivery to be considered fresh. */
  unmark(key: string): Promise<void>;
  /** Whether `key` has an unexpired entry. */
  has(key: string): Promise<boolean>;
  /** Whether `key` is currently poisoned (issue #78). */
  isPoisoned?(key: string): Promise<boolean>;
  /** Backcompat shim — equivalent to `markIfAbsent` but discards the result. */
  mark(key: string, ttlMs?: number): Promise<void>;
}

/**
 * In-memory bounded idempotency store.
 *
 * Bounds:
 * - Per-entry TTL (default 24h) — entries expire automatically.
 * - Global cap on `maxEntries` (default 100k) — oldest expiring entries are
 *   evicted first when the cap is exceeded. This prevents unbounded heap
 *   growth on long-running gateways at high webhook rates.
 *
 * Pruning runs on every mutation; `has`/`markIfAbsent` also reject expired
 * entries inline so a key whose TTL elapsed is reported as absent.
 */
export class InMemoryGatewayIdempotencyStore implements GatewayIdempotencyStore {
  // Map preserves insertion order. Because TTL is uniform per call, entries
  // inserted earlier expire earlier, so the iteration order also doubles as
  // an "oldest expiresAt first" ordering for cap-based eviction.
  private readonly entries = new Map<string, number>(); // key -> expiresAt epoch ms
  // Issue #78: poisoned keys map to the same expiresAt domain. A poisoned
  // entry is still "present" for `markIfAbsent`/`has` (so dedupe still
  // rejects), but `claim()` reports `'poisoned'` so the runtime can return
  // 409 instead of silently re-running side-effects.
  private readonly poisoned = new Map<string, number>(); // key -> expiresAt epoch ms
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(opts?: { defaultTtlMs?: number; maxEntries?: number }) {
    this.defaultTtlMs = opts?.defaultTtlMs ?? 24 * 60 * 60 * 1000; // 24h
    this.maxEntries = opts?.maxEntries ?? 100_000;
  }

  /** Drop expired entries, then enforce the maxEntries cap by removing the
   * oldest (earliest-inserted) keys. Runs in O(expired + overflow). */
  private prune(now: number): void {
    // 1. Drop expired entries.
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      } else {
        // Map iteration follows insertion order, so once we hit a non-expired
        // entry we *might* still find expired ones later if TTLs differed —
        // but in practice TTLs are uniform per call site, so we can break.
        // Fall through and continue scanning to be safe against mixed TTLs.
        // (Cost: O(n) over live entries on very polluted maps. Acceptable
        //  because prune runs once per mutation, not per check.)
      }
    }
    // Drop expired poison markers in the same sweep so they cannot grow
    // unbounded. Poison TTL mirrors the entry TTL.
    for (const [key, expiresAt] of this.poisoned) {
      if (expiresAt <= now) this.poisoned.delete(key);
    }
    // 2. Enforce cap by evicting oldest entries first.
    if (this.entries.size > this.maxEntries) {
      const overflow = this.entries.size - this.maxEntries;
      let removed = 0;
      for (const key of this.entries.keys()) {
        if (removed >= overflow) break;
        this.entries.delete(key);
        // Drop matching poison marker so we don't keep stale poison forever.
        this.poisoned.delete(key);
        removed++;
      }
    }
  }

  async markIfAbsent(key: string, ttlMs: number = this.defaultTtlMs): Promise<boolean> {
    const now = Date.now();
    this.prune(now);
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > now) {
      return false;
    }
    // Issue #78: poisoned-without-entry can happen if the entry was unmarked
    // after poisoning (operator-driven). Treat as occupied — never re-run.
    const poisonedAt = this.poisoned.get(key);
    if (poisonedAt !== undefined && poisonedAt > now) {
      return false;
    }
    // If the existing entry was expired, delete first so re-set lands at the
    // tail of insertion order (matching new-entry semantics for eviction).
    if (existing !== undefined) {
      this.entries.delete(key);
    }
    this.entries.set(key, now + ttlMs);
    return true;
  }

  /**
   * Issue #78: tri-state claim. `'fresh'` = newly recorded, claim succeeded.
   * `'duplicate'` = unexpired entry exists but no side-effects yet (caller
   * may choose to wait/retry the *same* outbound). `'poisoned'` = visible
   * progress already happened; the caller MUST NOT replay and should surface
   * a 409 to the platform.
   */
  async claim(key: string, ttlMs: number = this.defaultTtlMs): Promise<GatewayIdempotencyClaim> {
    const now = Date.now();
    this.prune(now);
    const poisonedAt = this.poisoned.get(key);
    if (poisonedAt !== undefined && poisonedAt > now) {
      return 'poisoned';
    }
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > now) {
      return 'duplicate';
    }
    if (existing !== undefined) {
      this.entries.delete(key);
    }
    this.entries.set(key, now + ttlMs);
    return 'fresh';
  }

  /**
   * Issue #78: mark `key` as poisoned because the inbound delivery has
   * caused user-visible progress (tool side-effect, streamed token, etc).
   * Subsequent claims return `'poisoned'`. Idempotent.
   */
  async poisonAfterProgress(key: string, ttlMs: number = this.defaultTtlMs): Promise<void> {
    const now = Date.now();
    this.poisoned.set(key, now + ttlMs);
    // Refresh the entry's expiresAt too so `markIfAbsent` keeps treating the
    // key as occupied for the same window. This avoids a race where the
    // entry expires before the poison marker.
    if (this.entries.has(key)) {
      this.entries.set(key, now + ttlMs);
    }
  }

  async isPoisoned(key: string): Promise<boolean> {
    const expiresAt = this.poisoned.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.poisoned.delete(key);
      return false;
    }
    return true;
  }

  async unmark(key: string): Promise<void> {
    this.entries.delete(key);
    // Note: do NOT drop the poison marker. If the operator unmarks a key
    // that has produced visible progress, replays should still fail loud.
  }

  async has(key: string): Promise<boolean> {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      // Lazy expiration: drop the stale entry.
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  async mark(key: string, ttlMs?: number): Promise<void> {
    await this.markIfAbsent(key, ttlMs);
  }
}

export interface DiscordSendPayload {
  content: string;
}

export interface DiscordEditPayload {
  messageId: string;
  content: string;
}

export interface TelegramSendPayload {
  chat_id: string;
  text: string;
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disable_web_page_preview?: boolean;
}

export interface TelegramEditPayload extends TelegramSendPayload {
  message_id: number;
}

export interface SlackSendPayload {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface SlackEditPayload extends SlackSendPayload {
  ts: string;
}

/**
 * Input for `verifySlackSignature`.
 *
 * Pass either `signingSecret` (resolved by the caller) or `secretProvider`
 * (a callback the verifier invokes per-request). The callback form lets the
 * runtime read the latest secret from `configStore` on every webhook so that
 * dashboard rotations take effect immediately without restarting the worker.
 *
 * Precedence when both are provided: `secretProvider` wins. This matches the
 * documented OpenClaw 2026.4.23-beta.4 lookup order: configStore -> env -> options.
 * If `secretProvider` returns `undefined` or an empty string, verification fails
 * (treating "no secret configured" as "deny", per signature-verifier semantics).
 */
export interface SlackSignatureInput {
  signingSecret?: string;
  secretProvider?: () => string | undefined;
  timestamp: string;
  body: string;
  signature: string;
}

export const workerFirstGateways: GatewayBinding[] = [
  { platform: 'telegram', route: '/webhooks/telegram' },
  { platform: 'discord', route: '/webhooks/discord' },
  { platform: 'slack', route: '/webhooks/slack' },
  { platform: 'whatsapp', route: '/webhooks/whatsapp' },
  { platform: 'signal', route: '/webhooks/signal' },
  { platform: 'email', route: '/webhooks/email' },
  { platform: 'matrix', route: '/webhooks/matrix' },
  { platform: 'sms', route: '/webhooks/sms' },
  { platform: 'webhook', route: '/api/sessions/:id' }
];

export function buildGatewaySessionKey(message: NormalizedInboundMessage): string {
  return `${message.platform}:${message.channelId}`;
}

export function normalizeGenericWebhook(payload: GenericWebhookPayload): NormalizedInboundMessage {
  const text = typeof payload.text === 'string'
    ? payload.text
    : typeof payload.message === 'string'
      ? payload.message
      : '';
  const channelId = typeof payload.channelId === 'string'
    ? payload.channelId
    : typeof payload.chatId === 'string'
      ? payload.chatId
      : 'anonymous';
  const userId = typeof payload.userId === 'string' ? payload.userId : undefined;

  return {
    platform: 'webhook',
    channelId,
    userId,
    text,
    raw: payload,
    receivedAt: new Date().toISOString(),
    externalChatId: channelId,
    externalUserId: userId,
    deliveryId: typeof payload.deliveryId === 'string' ? payload.deliveryId : undefined
  };
}

export function normalizeTelegramWebhook(update: TelegramUpdate): NormalizedInboundMessage | null {
  const message = update.message;
  if (!message?.chat?.id || !message.text) {
    return null;
  }

  const channelId = String(message.chat.id);
  const userId = message.from?.id ? String(message.from.id) : undefined;
  return {
    platform: 'telegram',
    channelId,
    userId,
    text: message.text,
    raw: update,
    receivedAt: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    externalChatId: channelId,
    externalUserId: userId,
    deliveryId: update.update_id ? String(update.update_id) : undefined
  };
}

export function normalizeDiscordWebhook(payload: DiscordInteractionPayload): NormalizedInboundMessage | null {
  const channelId = payload.channel_id ? String(payload.channel_id) : '';
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const commandName = payload.data?.name ?? '';
  const args = payload.data?.options?.map((option) => option?.value).filter(Boolean).join(' ') ?? '';
  const text = [commandName, args].filter(Boolean).join(' ').trim();
  if (!channelId || !text) {
    return null;
  }

  return {
    platform: 'discord',
    channelId,
    userId,
    text,
    raw: payload,
    receivedAt: new Date().toISOString(),
    externalChatId: channelId,
    externalUserId: userId
  };
}

export function normalizeSlackWebhook(payload: SlackEventPayload): NormalizedInboundMessage | null {
  if (payload.type === 'url_verification') {
    return null;
  }

  const event = payload.event;
  if (!event?.channel || !event.text || event.subtype === 'bot_message') {
    return null;
  }

  return {
    platform: 'slack',
    channelId: event.channel,
    userId: event.user,
    text: event.text,
    raw: payload,
    receivedAt: new Date().toISOString(),
    externalChatId: event.channel,
    externalUserId: event.user,
    deliveryId: event.ts
  };
}

export function normalizeWhatsAppWebhook(payload: WhatsAppWebhookPayload): NormalizedInboundMessage | null {
  const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const metadata = payload.entry?.[0]?.changes?.[0]?.value?.metadata;
  const text = message?.text?.body;
  const channelId = metadata?.phone_number_id;
  if (!message?.from || !text || !channelId) {
    return null;
  }

  return {
    platform: 'whatsapp',
    channelId,
    userId: message.from,
    text,
    raw: payload,
    receivedAt: new Date(Number(message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    externalChatId: channelId,
    externalUserId: message.from,
    deliveryId: message.id
  };
}

export function normalizeSignalWebhook(payload: SignalWebhookPayload): NormalizedInboundMessage | null {
  const envelope = payload.envelope;
  const text = envelope?.dataMessage?.message;
  const userId = envelope?.sourceNumber ?? envelope?.sourceUuid;
  const channelId = userId;
  if (!text || !channelId) {
    return null;
  }

  return {
    platform: 'signal',
    channelId,
    userId,
    text,
    raw: payload,
    receivedAt: new Date(envelope?.timestamp ?? Date.now()).toISOString(),
    externalChatId: channelId,
    externalUserId: userId,
    deliveryId: envelope?.timestamp ? String(envelope.timestamp) : undefined
  };
}

export function normalizeEmailWebhook(payload: EmailWebhookPayload): NormalizedInboundMessage | null {
  const userId = payload.from;
  const channelId = payload.inboxId ?? payload.to ?? payload.from;
  const body = typeof payload.text === 'string'
    ? payload.text
    : typeof payload.body === 'string'
      ? payload.body
      : '';
  const subject = typeof payload.subject === 'string' && payload.subject.trim()
    ? `Subject: ${payload.subject.trim()}\n`
    : '';
  const text = `${subject}${body}`.trim();
  if (!channelId || !text) {
    return null;
  }

  return {
    platform: 'email',
    channelId,
    userId,
    text,
    raw: payload,
    receivedAt: new Date().toISOString(),
    externalChatId: channelId,
    externalUserId: userId,
    deliveryId: payload.messageId
  };
}

export function normalizeMatrixWebhook(payload: MatrixWebhookPayload): NormalizedInboundMessage | null {
  const channelId = payload.roomId;
  const userId = payload.sender;
  const text = payload.content?.body;
  if (!channelId || !text) {
    return null;
  }

  return {
    platform: 'matrix',
    channelId,
    userId,
    text,
    raw: payload,
    receivedAt: new Date(payload.timestamp ?? Date.now()).toISOString(),
    externalChatId: channelId,
    externalUserId: userId,
    deliveryId: payload.eventId
  };
}

export function normalizeSmsWebhook(payload: SmsWebhookPayload): NormalizedInboundMessage | null {
  const userId = payload.from;
  const channelId = payload.conversationId ?? payload.to ?? payload.from;
  const text = typeof payload.text === 'string'
    ? payload.text
    : typeof payload.body === 'string'
      ? payload.body
      : '';
  if (!channelId || !text) {
    return null;
  }

  return {
    platform: 'sms',
    channelId,
    userId,
    text,
    raw: payload,
    receivedAt: new Date(payload.timestamp ?? Date.now()).toISOString(),
    externalChatId: channelId,
    externalUserId: userId,
    deliveryId: payload.messageId
  };
}

export function routeTelegramWebhook(update: TelegramUpdate): TelegramWebhookRouteResult {
  const message = normalizeTelegramWebhook(update);
  if (!message) {
    return { ok: false };
  }

  return {
    ok: true,
    message,
    sessionKey: buildGatewaySessionKey(message)
  };
}

export function buildTelegramDispatch(update: TelegramUpdate): TelegramWebhookDispatch | null {
  const routed = routeTelegramWebhook(update);
  if (!routed.ok || !routed.message || !routed.sessionKey) {
    return null;
  }

  return {
    sessionId: routed.sessionKey,
    payload: {
      userMessage: routed.message.text,
      userId: routed.message.userId,
      workspaceId: routed.message.channelId
    }
  };
}

export function buildDiscordDispatch(payload: DiscordInteractionPayload): DiscordDispatch | null {
  const message = normalizeDiscordWebhook(payload);
  if (!message) {
    return null;
  }

  return {
    sessionId: buildGatewaySessionKey(message),
    payload: {
      userMessage: message.text,
      userId: message.userId,
      workspaceId: message.channelId
    }
  };
}

export function buildSlackDispatch(payload: SlackEventPayload): SlackDispatch | null {
  const message = normalizeSlackWebhook(payload);
  if (!message) {
    return null;
  }

  return {
    sessionId: buildGatewaySessionKey(message),
    payload: {
      userMessage: message.text,
      userId: message.userId,
      workspaceId: message.channelId
    }
  };
}

export function buildWhatsAppDispatch(payload: WhatsAppWebhookPayload): WhatsAppDispatch | null {
  const message = normalizeWhatsAppWebhook(payload);
  if (!message) {
    return null;
  }

  return {
    sessionId: buildGatewaySessionKey(message),
    payload: {
      userMessage: message.text,
      userId: message.userId,
      workspaceId: message.channelId
    }
  };
}

export function buildSignalDispatch(payload: SignalWebhookPayload): SignalDispatch | null {
  const message = normalizeSignalWebhook(payload);
  if (!message) {
    return null;
  }

  return {
    sessionId: buildGatewaySessionKey(message),
    payload: {
      userMessage: message.text,
      userId: message.userId,
      workspaceId: message.channelId
    }
  };
}

export function buildEmailDispatch(payload: EmailWebhookPayload): EmailDispatch | null {
  const message = normalizeEmailWebhook(payload);
  if (!message) {
    return null;
  }

  return {
    sessionId: buildGatewaySessionKey(message),
    payload: {
      userMessage: message.text,
      userId: message.userId,
      workspaceId: message.channelId
    }
  };
}

export function buildMatrixDispatch(payload: MatrixWebhookPayload): MatrixDispatch | null {
  const message = normalizeMatrixWebhook(payload);
  if (!message) {
    return null;
  }

  return {
    sessionId: buildGatewaySessionKey(message),
    payload: {
      userMessage: message.text,
      userId: message.userId,
      workspaceId: message.channelId
    }
  };
}

export function buildSmsDispatch(payload: SmsWebhookPayload): SmsDispatch | null {
  const message = normalizeSmsWebhook(payload);
  if (!message) {
    return null;
  }

  return {
    sessionId: buildGatewaySessionKey(message),
    payload: {
      userMessage: message.text,
      userId: message.userId,
      workspaceId: message.channelId
    }
  };
}

export function buildGatewayRetryPolicy(platform: GatewayPlatform): GatewayRetryPolicy {
  switch (platform) {
    case 'slack':
      return { maxAttempts: 3, baseDelayMs: 1_000 };
    case 'whatsapp':
      return { maxAttempts: 4, baseDelayMs: 1_500 };
    case 'telegram':
      return { maxAttempts: 2, baseDelayMs: 750 };
    case 'matrix':
      return { maxAttempts: 3, baseDelayMs: 1_000 };
    case 'sms':
      return { maxAttempts: 3, baseDelayMs: 1_250 };
    default:
      return { maxAttempts: 2, baseDelayMs: 500 };
  }
}

export function buildGatewayIdempotencyKey(message: NormalizedInboundMessage): string | null {
  if (!message.deliveryId) {
    return null;
  }
  return `${message.platform}:${message.channelId}:${message.deliveryId}`;
}

export function buildGatewayDeliveryPlan(message: NormalizedInboundMessage): GatewayDeliveryPlan {
  return {
    platform: message.platform,
    sessionId: buildGatewaySessionKey(message),
    retryPolicy: buildGatewayRetryPolicy(message.platform),
    idempotencyKey: buildGatewayIdempotencyKey(message),
    userMessage: message.text,
    userId: message.userId,
    workspaceId: message.channelId
  };
}

export function buildDiscordSendPayload(input: { content: string }): DiscordSendPayload {
  return { content: input.content };
}

export function buildDiscordEditPayload(input: { messageId: string; content: string }): DiscordEditPayload {
  return { messageId: input.messageId, content: input.content };
}

export function buildDiscordWebhookSendUrl(webhookUrl: string): string {
  return webhookUrl;
}

export function buildDiscordWebhookEditUrl(webhookUrl: string, messageId: string): string {
  return `${webhookUrl.replace(/\/$/, '')}/messages/${messageId}`;
}

export function buildTelegramSendPayload(input: {
  chatId: string;
  text: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disableWebPagePreview?: boolean;
}): TelegramSendPayload {
  return {
    chat_id: input.chatId,
    text: input.text,
    ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
    ...(typeof input.disableWebPagePreview === 'boolean'
      ? { disable_web_page_preview: input.disableWebPagePreview }
      : {})
  };
}

export function buildTelegramEditPayload(input: {
  chatId: string;
  messageId: number;
  text: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disableWebPagePreview?: boolean;
}): TelegramEditPayload {
  return {
    ...buildTelegramSendPayload({
      chatId: input.chatId,
      text: input.text,
      parseMode: input.parseMode,
      disableWebPagePreview: input.disableWebPagePreview
    }),
    message_id: input.messageId
  };
}

export function buildSlackSendPayload(input: { channel: string; text: string; threadTs?: string }): SlackSendPayload {
  return {
    channel: input.channel,
    text: input.text,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {})
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function buildSlackSignature(signingSecret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const payload = encoder.encode(`v0:${timestamp}:${body}`);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return `v0=${bytesToHex(new Uint8Array(signature))}`;
}

export async function verifySlackSignature(input: SlackSignatureInput): Promise<boolean> {
  // Resolve the secret per-call: a `secretProvider` callback wins over a
  // pre-resolved `signingSecret`. This lets runtimes pass a closure over
  // `configStore.getGatewayConfig('slack')?.signingSecret` so rotations
  // through the dashboard take effect immediately without restart.
  const resolved = input.secretProvider ? input.secretProvider() : input.signingSecret;
  if (!resolved || !input.timestamp || !input.body || !input.signature) {
    return false;
  }

  const expected = await buildSlackSignature(resolved, input.timestamp, input.body);
  return timingSafeEqual(expected, input.signature);
}

export function buildSlackEditPayload(input: { channel: string; text: string; ts: string; threadTs?: string }): SlackEditPayload {
  return {
    ...buildSlackSendPayload(input),
    ts: input.ts
  };
}

export function buildSlackSendUrl(): string {
  return 'https://slack.com/api/chat.postMessage';
}

export function buildSlackEditUrl(): string {
  return 'https://slack.com/api/chat.update';
}

export function buildTelegramApiBase(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}`;
}

/**
 * Split a text into chunks that fit within Telegram's message size limit.
 * Prefers splitting at paragraph boundaries (\n\n), then single newlines,
 * then forces a hard split at maxLength.
 */
export function splitTelegramMessage(text: string, maxLength: number = 4096): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a paragraph boundary (\n\n)
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < maxLength * 0.3) {
      // Try single newline
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // Force split at maxLength
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  return chunks;
}

// --- Telegram Typing Indicator ---

/**
 * Send a chat action (e.g. "typing") to a Telegram chat.
 * Errors are caught and returned — never throws.
 */
export async function sendTelegramChatAction(
  botToken: string,
  chatId: string,
  action: string = 'typing',
): Promise<{ ok: boolean }> {
  try {
    const url = `${buildTelegramApiBase(botToken)}/sendChatAction`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
    const data = await res.json() as { ok?: boolean };
    return { ok: data.ok === true };
  } catch {
    return { ok: false };
  }
}

/**
 * Create a repeating typing indicator for a Telegram chat.
 * Immediately sends a "typing" action, then repeats every `intervalMs`.
 * Telegram's typing indicator expires after ~5s, so 4000ms is a safe default.
 * Returns a `stop()` handle to cancel the interval.
 */
export function createTypingIndicator(
  botToken: string,
  chatId: string,
  intervalMs: number = 4000,
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  // Fire immediately (non-blocking — ignore result)
  void sendTelegramChatAction(botToken, chatId);

  timer = setInterval(() => {
    if (stopped) return;
    void sendTelegramChatAction(botToken, chatId);
  }, intervalMs);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export function buildTelegramSendUrl(botToken: string): string {
  return `${buildTelegramApiBase(botToken)}/sendMessage`;
}

export function buildTelegramEditUrl(botToken: string): string {
  return `${buildTelegramApiBase(botToken)}/editMessageText`;
}

// --- Outbound Message Sending ---

export interface GatewaySendResult {
  ok: boolean;
  platform: GatewayPlatform;
  messageId?: string;
  error?: string;
  raw?: unknown;
}

/**
 * Send a single (unsplit) Telegram message. Internal helper.
 */
async function sendTelegramMessageSingle(
  botToken: string,
  chatId: string,
  text: string,
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'
): Promise<GatewaySendResult> {
  const url = buildTelegramSendUrl(botToken);
  const payload = buildTelegramSendPayload({
    chatId,
    text,
    parseMode,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json() as { ok?: boolean; result?: { message_id?: number }; description?: string };
    return {
      ok: data.ok === true,
      platform: 'telegram',
      messageId: data.result?.message_id ? String(data.result.message_id) : undefined,
      error: data.ok ? undefined : (data.description ?? 'Unknown Telegram error'),
      raw: data,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      platform: 'telegram',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a message via Telegram Bot API.
 *
 * Automatically splits messages that exceed 4096 characters.
 * When parseMode is set, retries without formatting if Telegram rejects
 * the message (e.g. unbalanced Markdown characters).
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  options?: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'; splitLong?: boolean }
): Promise<GatewaySendResult> {
  const shouldSplit = options?.splitLong !== false;
  const chunks = shouldSplit ? splitTelegramMessage(text) : [text];

  let lastResult: GatewaySendResult = { ok: true, platform: 'telegram' };
  for (const chunk of chunks) {
    lastResult = await sendTelegramMessageSingle(botToken, chatId, chunk, options?.parseMode);
    // If Markdown parsing failed (HTTP 400 from Telegram), retry without parseMode
    if (!lastResult.ok && options?.parseMode) {
      const errorDesc = typeof lastResult.error === 'string' ? lastResult.error : '';
      if (errorDesc.includes("can't parse") || errorDesc.includes('Bad Request')) {
        lastResult = await sendTelegramMessageSingle(botToken, chatId, chunk);
      }
    }
    if (!lastResult.ok) return lastResult;
  }
  return lastResult;
}

/**
 * Send a message via Discord webhook.
 */
export async function sendDiscordMessage(
  webhookUrl: string,
  content: string
): Promise<GatewaySendResult> {
  // Validate webhook URL to prevent SSRF
  const urlCheck = validateFetchUrl(webhookUrl);
  if (!urlCheck.safe) {
    return { ok: false, platform: 'discord', error: `URL blocked: ${urlCheck.reason}` };
  }
  const payload = buildDiscordSendPayload({ content });

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status === 204) {
      return { ok: true, platform: 'discord' };
    }

    const data = await response.json() as { id?: string; message?: string };
    return {
      ok: response.ok,
      platform: 'discord',
      messageId: data.id,
      error: response.ok ? undefined : (data.message ?? `HTTP ${response.status}`),
      raw: data,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      platform: 'discord',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a message via Slack Web API (chat.postMessage).
 */
export async function sendSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  options?: { threadTs?: string }
): Promise<GatewaySendResult> {
  const url = buildSlackSendUrl();
  const payload = buildSlackSendPayload({ channel, text, threadTs: options?.threadTs });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json() as { ok?: boolean; ts?: string; error?: string };
    return {
      ok: data.ok === true,
      platform: 'slack',
      messageId: data.ts,
      error: data.ok ? undefined : (data.error ?? 'Unknown Slack error'),
      raw: data,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      platform: 'slack',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a message via WhatsApp Cloud API.
 */
export async function sendWhatsAppMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string
): Promise<GatewaySendResult> {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    });
    const data = await response.json() as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    return {
      ok: response.ok,
      platform: 'whatsapp',
      messageId: data.messages?.[0]?.id,
      error: response.ok ? undefined : (data.error?.message ?? `HTTP ${response.status}`),
      raw: data,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      platform: 'whatsapp',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a message via Matrix client-server API.
 */
export async function sendMatrixMessage(
  homeserverUrl: string,
  accessToken: string,
  roomId: string,
  text: string
): Promise<GatewaySendResult> {
  const txnId = crypto.randomUUID();
  const url = `${homeserverUrl.replace(/\/$/, '')}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        msgtype: 'm.text',
        body: text,
      }),
    });
    const data = await response.json() as { event_id?: string; errcode?: string; error?: string };
    return {
      ok: response.ok,
      platform: 'matrix',
      messageId: data.event_id,
      error: response.ok ? undefined : (data.error ?? `HTTP ${response.status}`),
      raw: data,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      platform: 'matrix',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send an email via a generic SMTP relay API (e.g., SendGrid, Mailgun).
 * This uses a webhook-style HTTP API, not raw SMTP.
 */
export async function sendEmailMessage(
  apiUrl: string,
  apiKey: string,
  to: string,
  subject: string,
  text: string,
  from?: string
): Promise<GatewaySendResult> {
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to,
        from: from ?? 'agent@crowclaw.dev',
        subject,
        text,
      }),
    });
    const data = await response.json() as { id?: string; error?: string; message?: string };
    return {
      ok: response.ok,
      platform: 'email',
      messageId: data.id,
      error: response.ok ? undefined : (data.error ?? data.message ?? `HTTP ${response.status}`),
      raw: data,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      platform: 'email',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- Platform Probes (token validation) ---

export interface ProbeResult {
  ok: boolean;
  platform: GatewayPlatform;
  identity?: string;       // Bot username, app name, etc.
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * Probe Telegram bot token by calling getMe.
 */
export async function probeTelegram(botToken: string): Promise<ProbeResult> {
  try {
    const url = `${buildTelegramApiBase(botToken)}/getMe`;
    const res = await fetch(url);
    const data = await res.json() as { ok?: boolean; result?: { username?: string; first_name?: string; id?: number } };
    if (data.ok && data.result) {
      return {
        ok: true,
        platform: 'telegram',
        identity: `@${data.result.username ?? 'unknown'}`,
        details: { id: data.result.id, firstName: data.result.first_name, username: data.result.username },
      };
    }
    return { ok: false, platform: 'telegram', error: 'Invalid bot token' };
  } catch (error: unknown) {
    return { ok: false, platform: 'telegram', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Probe Slack bot token by calling auth.test.
 */
export async function probeSlack(botToken: string): Promise<ProbeResult> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${botToken}`, 'content-type': 'application/json' },
    });
    const data = await res.json() as { ok?: boolean; user?: string; team?: string; team_id?: string; user_id?: string; error?: string };
    if (data.ok) {
      return {
        ok: true,
        platform: 'slack',
        identity: `${data.user}@${data.team}`,
        details: { user: data.user, team: data.team, teamId: data.team_id, userId: data.user_id },
      };
    }
    return { ok: false, platform: 'slack', error: data.error ?? 'Invalid token' };
  } catch (error: unknown) {
    return { ok: false, platform: 'slack', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Probe Discord webhook by calling the webhook URL.
 */
export async function probeDiscord(webhookUrl: string): Promise<ProbeResult> {
  // Validate webhook URL to prevent SSRF
  const urlCheck = validateFetchUrl(webhookUrl);
  if (!urlCheck.safe) {
    return { ok: false, platform: 'discord', error: `URL blocked: ${urlCheck.reason}` };
  }
  try {
    const res = await fetch(webhookUrl);
    if (!res.ok) {
      return { ok: false, platform: 'discord', error: `HTTP ${res.status}` };
    }
    const data = await res.json() as { name?: string; id?: string; guild_id?: string; channel_id?: string };
    return {
      ok: true,
      platform: 'discord',
      identity: data.name ?? 'Webhook',
      details: { id: data.id, guildId: data.guild_id, channelId: data.channel_id },
    };
  } catch (error: unknown) {
    return { ok: false, platform: 'discord', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Probe WhatsApp Cloud API token by checking business profile.
 */
export async function probeWhatsApp(accessToken: string, phoneNumberId: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
      headers: { 'authorization': `Bearer ${accessToken}` },
    });
    const data = await res.json() as { id?: string; display_phone_number?: string; verified_name?: string; error?: { message?: string } };
    if (data.id) {
      return {
        ok: true,
        platform: 'whatsapp',
        identity: data.verified_name ?? data.display_phone_number ?? phoneNumberId,
        details: { id: data.id, phone: data.display_phone_number },
      };
    }
    return { ok: false, platform: 'whatsapp', error: data.error?.message ?? 'Invalid credentials' };
  } catch (error: unknown) {
    return { ok: false, platform: 'whatsapp', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Probe Matrix homeserver by checking the access token.
 */
export async function probeMatrix(homeserverUrl: string, accessToken: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${homeserverUrl.replace(/\/$/, '')}/_matrix/client/r0/account/whoami`, {
      headers: { 'authorization': `Bearer ${accessToken}` },
    });
    const data = await res.json() as { user_id?: string; device_id?: string; errcode?: string; error?: string };
    if (data.user_id) {
      return {
        ok: true,
        platform: 'matrix',
        identity: data.user_id,
        details: { userId: data.user_id, deviceId: data.device_id },
      };
    }
    return { ok: false, platform: 'matrix', error: data.error ?? data.errcode ?? 'Invalid token' };
  } catch (error: unknown) {
    return { ok: false, platform: 'matrix', error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Telegram Webhook Management ---

export interface TelegramWebhookSetOptions {
  secretToken?: string;
  maxConnections?: number;
  allowedUpdates?: string[];
}

export interface TelegramWebhookSetResult {
  ok: boolean;
  description?: string;
}

export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

export interface TelegramWebhookInfoResult {
  ok: boolean;
  result?: TelegramWebhookInfo;
}

/**
 * Register a webhook URL with the Telegram Bot API.
 * The URL must use HTTPS (Telegram requirement).
 */
export async function setTelegramWebhook(
  botToken: string,
  url: string,
  options?: TelegramWebhookSetOptions,
): Promise<TelegramWebhookSetResult> {
  if (!url.startsWith('https://')) {
    return { ok: false, description: 'Webhook URL must use HTTPS' };
  }
  const apiUrl = `${buildTelegramApiBase(botToken)}/setWebhook`;
  const body: Record<string, unknown> = { url };
  if (options?.secretToken) body.secret_token = options.secretToken;
  if (options?.maxConnections !== undefined) body.max_connections = options.maxConnections;
  if (options?.allowedUpdates) body.allowed_updates = options.allowedUpdates;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json() as { ok?: boolean; description?: string };
    return { ok: data.ok === true, description: data.description };
  } catch (error: unknown) {
    return { ok: false, description: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove the current webhook integration for a Telegram bot.
 */
export async function deleteTelegramWebhook(
  botToken: string,
): Promise<{ ok: boolean; description?: string }> {
  const apiUrl = `${buildTelegramApiBase(botToken)}/deleteWebhook`;
  try {
    const response = await fetch(apiUrl, { method: 'POST' });
    const data = await response.json() as { ok?: boolean; description?: string };
    return { ok: data.ok === true, description: data.description };
  } catch (error: unknown) {
    return { ok: false, description: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Get current webhook status for a Telegram bot.
 */
export async function getTelegramWebhookInfo(
  botToken: string,
): Promise<TelegramWebhookInfoResult> {
  const apiUrl = `${buildTelegramApiBase(botToken)}/getWebhookInfo`;
  try {
    const response = await fetch(apiUrl);
    const data = await response.json() as { ok?: boolean; result?: TelegramWebhookInfo };
    return { ok: data.ok === true, result: data.result };
  } catch (error: unknown) {
    return { ok: false };
  }
}

export const normalizeTelegramUpdate = normalizeTelegramWebhook;

export { channels, type ChannelAdapter, type NormalizedChannelMessage, telegramChannel, discordChannel, slackChannel, whatsappChannel, signalChannel, genericChannel } from './channel-registry.js';

export async function normalizeGatewayRequest(platform: GatewayPlatform, request: Request): Promise<NormalizedInboundMessage | null> {
  const payload = await request.json();
  if (platform === 'telegram') {
    return normalizeTelegramWebhook(payload as TelegramUpdate);
  }
  if (platform === 'discord') {
    return normalizeDiscordWebhook(payload as DiscordInteractionPayload);
  }
  if (platform === 'slack') {
    return normalizeSlackWebhook(payload as SlackEventPayload);
  }
  if (platform === 'whatsapp') {
    return normalizeWhatsAppWebhook(payload as WhatsAppWebhookPayload);
  }
  if (platform === 'signal') {
    return normalizeSignalWebhook(payload as SignalWebhookPayload);
  }
  if (platform === 'email') {
    return normalizeEmailWebhook(payload as EmailWebhookPayload);
  }
  if (platform === 'matrix') {
    return normalizeMatrixWebhook(payload as MatrixWebhookPayload);
  }
  if (platform === 'sms') {
    return normalizeSmsWebhook(payload as SmsWebhookPayload);
  }
  return normalizeGenericWebhook(payload as GenericWebhookPayload);
}

export { GatewayRunner, type GatewayRunnerConfig, type GatewayRunnerPlatformConfig, type GatewayStatus } from './runner.js';
export { executeWithRetry, type RetryResult } from './retry.js';
export { PlatformRateLimiter } from './platform-rate-limiter.js';

// Issue #91: Gateway-level credential pool with 401-rotation and least-used picker.
export {
  ProviderKeyPool,
  GatewayCredentialPool,
  type ProviderKeyPoolOptions,
  type ProviderKeyPoolStatus,
  type CredentialPoolCursor,
} from './credential-pool.js';
