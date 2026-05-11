/**
 * Self-Registering Channel System
 *
 * Inspired by the self-registering channel pattern popularized by NanoClaw.
 * Adding a new channel is a single-file change — no core modifications needed.
 */

import {
  checkDestinationAcl,
  emitAclDenied,
  buildAclDeniedEvent,
  type DestinationAclConfig,
  type DestinationAclDecision,
} from './destination-acl.js';
import {
  checkDiscordAcl,
  emitDiscordAclDenied,
  extractDiscordAclInput,
  loadDiscordAclConfig,
  type DiscordAclConfig,
} from './discord-acl.js';
import {
  checkWhatsAppAcl,
  emitWhatsAppAclDenied,
  loadWhatsAppAclConfig,
  type WhatsAppAclConfig,
} from './whatsapp-acl.js';

export interface ChannelAdapter {
  /** Unique channel identifier */
  name: string;
  /** Display name */
  displayName: string;
  /** Normalize an incoming webhook payload to a standard message format */
  normalizeInbound(payload: unknown): NormalizedChannelMessage | null;
  /** Build an outbound payload for this channel */
  buildOutbound(
    channelId: string,
    text: string,
    options?: Record<string, unknown>
  ): unknown;
  /** Verify webhook signature (optional) */
  verifySignature?(
    payload: unknown,
    headers: Record<string, string>,
    secret: string
  ): boolean;
  /**
   * Per-channel access gate. Runs **after** `normalizeInbound` returns a
   * non-null message and **before** the agent loop receives it.
   *
   * Returning `{ allowed: false }` causes the runtime to drop the inbound
   * (silently for `silentDrop`, otherwise with a `gateway:acl_denied` audit
   * event already emitted by the adapter implementation).
   *
   * The `config` parameter is the per-channel slice of the runtime config —
   * adapters interpret it according to their own ACL primitive.
   */
  checkAccess?(
    payload: unknown,
    normalized: NormalizedChannelMessage,
    config: unknown,
  ): ChannelAccessResult;
}

/** Generic ACL result a channel adapter returns. */
export interface ChannelAccessResult {
  allowed: boolean;
  reason: string;
  /**
   * True when the runtime should drop the message without audit-emitting
   * (reserved for self-chat suppression — see whatsapp-acl). Adapters return
   * this directly from the underlying ACL primitive.
   */
  silentDrop?: boolean;
}

export interface NormalizedChannelMessage {
  platform: string;
  channelId: string;
  senderId: string;
  senderName?: string;
  text: string;
  messageId?: string;
  timestamp?: string;
  replyToId?: string;
  attachments?: Array<{ type: string; url: string }>;
  raw: unknown;
}

class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();

  /** Register a channel adapter */
  register(adapter: ChannelAdapter): this {
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  /** Get a registered adapter by name */
  get(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name);
  }

  /** List all registered channels */
  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  /** List channel names */
  names(): string[] {
    return [...this.adapters.keys()];
  }

  /** Normalize an inbound payload by trying all registered adapters */
  normalizeAny(
    payload: unknown
  ): { channel: string; message: NormalizedChannelMessage } | null {
    for (const [name, adapter] of this.adapters) {
      try {
        const message = adapter.normalizeInbound(payload);
        if (message) return { channel: name, message };
      } catch {
        /* adapter doesn't handle this payload */
      }
    }
    return null;
  }

  /** Build outbound message for a specific channel */
  buildOutbound(
    channelName: string,
    channelId: string,
    text: string,
    options?: Record<string, unknown>
  ): unknown {
    const adapter = this.adapters.get(channelName);
    if (!adapter) throw new Error(`Unknown channel: ${channelName}`);
    return adapter.buildOutbound(channelId, text, options);
  }
}

/** Global channel registry singleton */
export const channels = new ChannelRegistry();

// ---------------------------------------------------------------------------
// Helpers shared by the per-channel ACL wiring.
// ---------------------------------------------------------------------------

function loadDestinationAclConfig(raw: unknown): DestinationAclConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const allowedDestinations = Array.isArray(value.allowedDestinations)
    ? value.allowedDestinations.filter((s): s is string => typeof s === 'string')
    : [];
  return { allowedDestinations };
}

// --- Built-in channel adapters ---

export const telegramChannel: ChannelAdapter = {
  name: 'telegram',
  displayName: 'Telegram',
  normalizeInbound(payload: unknown): NormalizedChannelMessage | null {
    const p = payload as Record<string, unknown>;
    const msg = (p.message ?? p.edited_message) as
      | Record<string, unknown>
      | undefined;
    if (!msg) return null;
    const chat = msg.chat as Record<string, unknown> | undefined;
    const from = msg.from as Record<string, unknown> | undefined;
    if (!chat?.id || !from?.id) return null;
    return {
      platform: 'telegram',
      channelId: String(chat.id),
      senderId: String(from.id),
      senderName: from.first_name as string | undefined,
      text: (msg.text as string) ?? '',
      messageId: String(msg.message_id ?? ''),
      raw: payload,
    };
  },
  buildOutbound(channelId, text) {
    return { method: 'sendMessage', chat_id: channelId, text };
  },
  /** #318 — Telegram destination allowlist on `chat.id`. */
  checkAccess(_payload, normalized, config) {
    const aclConfig = loadDestinationAclConfig(config);
    const decision: DestinationAclDecision = checkDestinationAcl(normalized.channelId, aclConfig);
    if (!decision.allowed) {
      emitAclDenied(
        buildAclDeniedEvent({
          platform: 'telegram',
          reason: decision.reason,
          destinationId: normalized.channelId,
          senderId: normalized.senderId,
        }),
      );
    }
    return decision;
  },
};

export const discordChannel: ChannelAdapter = {
  name: 'discord',
  displayName: 'Discord',
  normalizeInbound(payload: unknown): NormalizedChannelMessage | null {
    const p = payload as Record<string, unknown>;
    if (p.type !== 0 && p.t !== 'MESSAGE_CREATE') return null;
    const d = (p.d ?? p) as Record<string, unknown>;
    const author = d.author as Record<string, unknown> | undefined;
    if (!d.channel_id || !author?.id) return null;
    return {
      platform: 'discord',
      channelId: String(d.channel_id),
      senderId: String(author.id),
      senderName: author.username as string | undefined,
      text: (d.content as string) ?? '',
      messageId: String(d.id ?? ''),
      raw: payload,
    };
  },
  buildOutbound(_channelId, text) {
    return { content: text };
  },
  /**
   * #294 — Discord guild-scoped role allowlist.
   * `config` is the raw `channels.discord` slice. We normalize via
   * `loadDiscordAclConfig` (which also handles the legacy string[] migration),
   * extract `(guild_id, member.roles, sender)` from the webhook payload, and
   * delegate to `checkDiscordAcl`. Denials emit `gateway:acl_denied`.
   */
  checkAccess(payload, normalized, config) {
    const aclConfig: DiscordAclConfig = loadDiscordAclConfig(config);
    const input = extractDiscordAclInput(payload);
    if (!input) {
      // No usable signal — fail closed to keep parity with Hermes' guarded fix.
      emitDiscordAclDenied({ reason: 'missing-roles', senderId: normalized.senderId });
      return { allowed: false, reason: 'missing-roles' };
    }
    const decision = checkDiscordAcl(input, aclConfig);
    if (!decision.allowed) {
      emitDiscordAclDenied({
        reason: decision.reason,
        guildId: decision.guildId ?? input.guildId,
        senderId: input.senderId,
        destinationId: normalized.channelId,
      });
    }
    return { allowed: decision.allowed, reason: decision.reason };
  },
};

export const slackChannel: ChannelAdapter = {
  name: 'slack',
  displayName: 'Slack',
  normalizeInbound(payload: unknown): NormalizedChannelMessage | null {
    const p = payload as Record<string, unknown>;
    const event = (p.event ?? p) as Record<string, unknown>;
    if (event.type !== 'message' || event.subtype) return null;
    if (!event.channel || !event.user) return null;
    return {
      platform: 'slack',
      channelId: String(event.channel),
      senderId: String(event.user),
      text: (event.text as string) ?? '',
      messageId: String(event.ts ?? ''),
      replyToId: event.thread_ts as string | undefined,
      raw: payload,
    };
  },
  buildOutbound(channelId, text, options) {
    return {
      channel: channelId,
      text,
      ...(options?.threadTs ? { thread_ts: options.threadTs } : {}),
    };
  },
  /** #318 — Slack destination allowlist on `event.channel`. */
  checkAccess(_payload, normalized, config) {
    const aclConfig = loadDestinationAclConfig(config);
    const decision = checkDestinationAcl(normalized.channelId, aclConfig);
    if (!decision.allowed) {
      emitAclDenied(
        buildAclDeniedEvent({
          platform: 'slack',
          reason: decision.reason,
          destinationId: normalized.channelId,
          senderId: normalized.senderId,
        }),
      );
    }
    return decision;
  },
};

export const whatsappChannel: ChannelAdapter = {
  name: 'whatsapp',
  displayName: 'WhatsApp',
  normalizeInbound(payload: unknown): NormalizedChannelMessage | null {
    const p = payload as Record<string, unknown>;
    const entry = Array.isArray(p.entry) ? p.entry[0] as Record<string, unknown> | undefined : undefined;
    const changes = Array.isArray(entry?.changes) ? entry?.changes[0] as Record<string, unknown> | undefined : undefined;
    const value = changes?.value as Record<string, unknown> | undefined;
    const metadata = value?.metadata as Record<string, unknown> | undefined;
    const message = Array.isArray(value?.messages) ? value?.messages[0] as Record<string, unknown> | undefined : undefined;
    const text = (message?.text as Record<string, unknown> | undefined)?.body;
    const channelId = metadata?.phone_number_id;
    if (!message?.from || typeof text !== 'string' || !channelId) return null;
    return {
      platform: 'whatsapp',
      channelId: String(channelId),
      senderId: String(message.from),
      text,
      messageId: String(message.id ?? ''),
      timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : undefined,
      raw: payload,
    };
  },
  buildOutbound(channelId, text) {
    return {
      messaging_product: 'whatsapp',
      to: channelId,
      type: 'text',
      text: { body: text },
    };
  },
  /**
   * #295 — WhatsApp stranger + self-chat ban.
   * Self-chat is reported as `silentDrop: true` so the runtime never enqueues
   * or audits — that's the explicit fix for the Hermes echo loop.
   */
  checkAccess(_payload, normalized, config) {
    const aclConfig: WhatsAppAclConfig = loadWhatsAppAclConfig(config);
    const decision = checkWhatsAppAcl({ senderWaId: normalized.senderId }, aclConfig);
    if (!decision.allowed && !decision.silentDrop) {
      emitWhatsAppAclDenied({ reason: decision.reason, senderId: normalized.senderId });
    }
    return decision;
  },
};

export const signalChannel: ChannelAdapter = {
  name: 'signal',
  displayName: 'Signal',
  normalizeInbound(payload: unknown): NormalizedChannelMessage | null {
    const p = payload as Record<string, unknown>;
    const envelope = p.envelope as Record<string, unknown> | undefined;
    const dataMessage = envelope?.dataMessage as Record<string, unknown> | undefined;
    const text = dataMessage?.message;
    const senderId = envelope?.sourceNumber ?? envelope?.sourceUuid;
    if (typeof text !== 'string' || !senderId) return null;
    return {
      platform: 'signal',
      channelId: String(senderId),
      senderId: String(senderId),
      text,
      messageId: envelope?.timestamp ? String(envelope.timestamp) : undefined,
      timestamp: envelope?.timestamp ? new Date(Number(envelope.timestamp)).toISOString() : undefined,
      raw: payload,
    };
  },
  buildOutbound(channelId, text) {
    return { recipient: channelId, message: text };
  },
  /** #318 — Signal destination allowlist. Sender phone/UUID is the destination id. */
  checkAccess(_payload, normalized, config) {
    const aclConfig = loadDestinationAclConfig(config);
    const decision = checkDestinationAcl(normalized.channelId, aclConfig);
    if (!decision.allowed) {
      emitAclDenied(
        buildAclDeniedEvent({
          platform: 'signal',
          reason: decision.reason,
          destinationId: normalized.channelId,
          senderId: normalized.senderId,
        }),
      );
    }
    return decision;
  },
};

export const genericChannel: ChannelAdapter = {
  name: 'generic',
  displayName: 'Generic Webhook',
  normalizeInbound(payload: unknown): NormalizedChannelMessage | null {
    const p = payload as Record<string, unknown>;
    const text = (p.text ?? p.message ?? p.content) as string | undefined;
    if (!text) return null;
    const sender = (p.sender ?? p.from ?? p.user) as
      | Record<string, unknown>
      | undefined;
    return {
      platform: 'generic',
      channelId: String(p.channelId ?? p.channel ?? 'default'),
      senderId: String(sender?.id ?? p.senderId ?? 'anonymous'),
      senderName: sender?.name as string | undefined,
      text,
      raw: payload,
    };
  },
  buildOutbound(_channelId, text) {
    return { text };
  },
};

// ---------------------------------------------------------------------------
// #318 — adapters that previously lived only in `packages/gateway/src/index.ts`
// are surfaced here so the destination ACL primitive has a uniform plug-in
// point across Matrix, Mattermost, DingTalk, and Email.
// ---------------------------------------------------------------------------

function buildDestinationChannelAdapter(
  name: 'matrix' | 'mattermost' | 'dingtalk' | 'email',
  displayName: string,
): ChannelAdapter {
  return {
    name,
    displayName,
    /**
     * These adapters intentionally return null — the existing dedicated
     * `normalize<X>Webhook` helpers in `index.ts` handle their platform
     * shape. They are registered here so the `checkAccess` hook is
     * discoverable through `channels.get(name)?.checkAccess(...)`.
     */
    normalizeInbound() {
      return null;
    },
    buildOutbound(channelId, text) {
      return { channelId, text };
    },
    checkAccess(_payload, normalized, config) {
      const aclConfig = loadDestinationAclConfig(config);
      const decision = checkDestinationAcl(normalized.channelId, aclConfig);
      if (!decision.allowed) {
        emitAclDenied(
          buildAclDeniedEvent({
            platform: name,
            reason: decision.reason,
            destinationId: normalized.channelId,
            senderId: normalized.senderId,
          }),
        );
      }
      return decision;
    },
  };
}

export const matrixChannel = buildDestinationChannelAdapter('matrix', 'Matrix');
export const mattermostChannel = buildDestinationChannelAdapter('mattermost', 'Mattermost');
export const dingtalkChannel = buildDestinationChannelAdapter('dingtalk', 'DingTalk');
export const emailChannel = buildDestinationChannelAdapter('email', 'Email');

// Auto-register built-in channels
channels.register(telegramChannel);
channels.register(discordChannel);
channels.register(slackChannel);
channels.register(whatsappChannel);
channels.register(signalChannel);
channels.register(matrixChannel);
channels.register(mattermostChannel);
channels.register(dingtalkChannel);
channels.register(emailChannel);
channels.register(genericChannel);

// Re-export ACL primitives so consumers can import from `@crowclaw/gateway`.
export {
  checkDestinationAcl,
  buildAclDeniedEvent,
  emitAclDenied,
  setAclEventSink,
  type DestinationAclConfig,
  type DestinationAclDecision,
  type DestinationAclReason,
  type AclDeniedEvent,
  type AclEventSink,
} from './destination-acl.js';
export {
  checkDiscordAcl,
  loadDiscordAclConfig,
  isLegacyAllowedRolesShape,
  extractDiscordAclInput,
  emitDiscordAclDenied,
  type DiscordAclConfig,
  type DiscordAclDecision,
  type DiscordAclInput,
  type DiscordAclReason,
  type DiscordGuildRoleEntry,
} from './discord-acl.js';
export {
  checkWhatsAppAcl,
  loadWhatsAppAclConfig,
  emitWhatsAppAclDenied,
  type WhatsAppAclConfig,
  type WhatsAppAclDecision,
  type WhatsAppAclInput,
  type WhatsAppAclReason,
} from './whatsapp-acl.js';
