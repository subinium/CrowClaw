/**
 * Cross-platform destination allowlist primitive.
 *
 * Closes Hermes v0.13 parity (#21251, salvages #7401) — uniform `allowed_*`
 * gating across Slack (`allowed_channels`), Telegram (`allowed_chats`),
 * Matrix (`allowed_rooms`), Mattermost, DingTalk, Email, and Signal.
 *
 * Semantics are intentionally simple to keep the per-channel call-site small:
 *   - Empty allowlist → allow all (backward compat).
 *   - Non-empty allowlist → strict allowlist on the platform-specific
 *     destination id (chat id, channel id, room id, mailbox, etc.).
 *   - Wildcard `'*'` entry treats the allowlist as "explicitly allow any"
 *     — useful when an operator wants the audit trail to record an
 *     intentional allow-all rather than an unconfigured one.
 *
 * Discord guild-role gating and WhatsApp stranger/self-chat filtering are
 * intentionally NOT modelled here — their checks need extra context
 * (`guild_id`, `bot_wa_id`) and live in `discord-acl.ts` / `whatsapp-acl.ts`.
 */

/** Reason returned alongside an ACL decision. Aligns with Hermes audit shape. */
export type DestinationAclReason =
  | 'allowed'
  | 'allowlisted'
  | 'open-policy'
  | 'not-in-allowlist'
  | 'missing-destination';

export interface DestinationAclDecision {
  allowed: boolean;
  reason: DestinationAclReason;
}

/**
 * Per-channel allowlist configuration.
 *
 * `allowedDestinations` is the platform-specific destination ID list.
 * Channel adapters interpret what "destination" means for their platform:
 *   - slack: `event.channel` (C0123...)
 *   - telegram: `chat.id`
 *   - matrix: `roomId`
 *   - mattermost: `channel_id`
 *   - dingtalk: `conversationId`
 *   - email: mailbox / inbox id
 *   - signal: source phone/UUID (used as channel id)
 */
export interface DestinationAclConfig {
  allowedDestinations: string[];
}

/**
 * Audit event emitted on every denied destination.
 *
 * Channel adapters should forward this to whatever audit sink the runtime
 * wires up — typically the observability bus. The shape mirrors Hermes' own
 * `gateway:acl_denied` event so log pipelines can be reused.
 */
export interface AclDeniedEvent {
  event: 'gateway:acl_denied';
  platform: string;
  reason: string;
  destinationId?: string;
  senderId?: string;
  guildId?: string;
  detail?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Check whether a given destination is permitted under the supplied config.
 *
 * Pure function — no logging, no side effects. Callers are responsible for
 * emitting `gateway:acl_denied` via `emitAclDenied()` when `allowed` is false.
 */
export function checkDestinationAcl(
  destinationId: string | undefined,
  config: DestinationAclConfig,
): DestinationAclDecision {
  // Empty allowlist → backward-compat allow-all.
  if (!config.allowedDestinations || config.allowedDestinations.length === 0) {
    return { allowed: true, reason: 'open-policy' };
  }

  if (!destinationId) {
    return { allowed: false, reason: 'missing-destination' };
  }

  if (config.allowedDestinations.includes('*')) {
    return { allowed: true, reason: 'allowed' };
  }

  if (config.allowedDestinations.includes(destinationId)) {
    return { allowed: true, reason: 'allowlisted' };
  }

  return { allowed: false, reason: 'not-in-allowlist' };
}

/**
 * Build a `gateway:acl_denied` audit event.
 *
 * Channel adapters/runtimes should call this on every denied inbound and
 * forward the result to their observability bus. The function never throws.
 */
export function buildAclDeniedEvent(input: {
  platform: string;
  reason: string;
  destinationId?: string;
  senderId?: string;
  guildId?: string;
  detail?: Record<string, unknown>;
}): AclDeniedEvent {
  return {
    event: 'gateway:acl_denied',
    platform: input.platform,
    reason: input.reason,
    ...(input.destinationId !== undefined ? { destinationId: input.destinationId } : {}),
    ...(input.senderId !== undefined ? { senderId: input.senderId } : {}),
    ...(input.guildId !== undefined ? { guildId: input.guildId } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Optional sink used by channel adapters to publish ACL events. Default is a
 * no-op so library callers don't need to wire anything up; the runtime sets
 * a real sink (typically `observabilityBus.publish`) when it boots.
 */
export type AclEventSink = (event: AclDeniedEvent) => void;

let aclEventSink: AclEventSink = () => {};

/** Install the runtime-wide ACL event sink. Returns the previous sink. */
export function setAclEventSink(sink: AclEventSink): AclEventSink {
  const previous = aclEventSink;
  aclEventSink = sink;
  return previous;
}

/** Emit an ACL-denied event through the installed sink. Never throws. */
export function emitAclDenied(event: AclDeniedEvent): void {
  try {
    aclEventSink(event);
  } catch {
    /* sink must not break inbound dispatch */
  }
}
