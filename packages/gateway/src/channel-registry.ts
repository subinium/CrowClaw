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

/**
 * Per-attachment payload used by the multi-image / multi-file outbound path.
 *
 * Closes Hermes v0.12 ([#17909](https://github.com/NousResearch/hermes-agent/pull/17909),
 * [#17833](https://github.com/NousResearch/hermes-agent/pull/17833)) where agents
 * can now ship N images in a single message across Telegram, Discord, Slack,
 * Mattermost, Email, and Signal.
 */
export interface Attachment {
  /** Common types: `image`, `audio`, `video`, `file`. */
  type: 'image' | 'audio' | 'video' | 'file' | string;
  /** Public URL or pre-signed link the channel adapter can hand off. */
  url: string;
  /** Optional MIME type — required for Email multi-part assembly. */
  mimeType?: string;
  /** Optional filename hint (Slack `files.upload`, Email attachment naming). */
  filename?: string;
  /** Optional caption — Discord embeds and Telegram captions use this. */
  caption?: string;
}

/**
 * Standardized outbound message envelope. Backward compat is preserved:
 * `text` alone still works; `attachments` is optional and additive.
 */
export interface OutgoingMessage {
  /** Primary message body. Empty string is permitted for attachment-only sends. */
  text: string;
  /** Zero or more attachments. Channel adapters cap per-platform limits. */
  attachments?: Attachment[];
  /** Channel-specific options (thread_ts, parse_mode, etc.). */
  options?: Record<string, unknown>;
}

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
  /**
   * Build a multi-attachment outbound payload. Optional — when not defined,
   * callers fall back to N invocations of `buildOutbound`. Implemented for
   * Telegram (mediaGroup), Discord (multi-embed), Slack (files.upload + thread),
   * Email (multi-part), Signal (multi-attachment via signal-cli).
   */
  buildOutboundMessage?(
    channelId: string,
    message: OutgoingMessage,
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
   * (used by WhatsApp self-chat). Adapters return this directly from the
   * underlying ACL primitive.
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

  /**
   * Build a multi-attachment outbound message for a specific channel.
   *
   * If the adapter defines `buildOutboundMessage`, the result is returned
   * directly. Otherwise the call falls back to the single-payload
   * `buildOutbound` (which silently ignores attachments). The fallback path
   * means existing channels keep working until they opt in.
   */
  buildOutboundMessage(
    channelName: string,
    channelId: string,
    message: OutgoingMessage,
  ): unknown {
    const adapter = this.adapters.get(channelName);
    if (!adapter) throw new Error(`Unknown channel: ${channelName}`);
    if (adapter.buildOutboundMessage) {
      return adapter.buildOutboundMessage(channelId, message);
    }
    return adapter.buildOutbound(channelId, message.text, message.options);
  }
}

/** Global channel registry singleton */
export const channels = new ChannelRegistry();

// ---------------------------------------------------------------------------
// Helpers shared by the per-channel outbound builders.
// ---------------------------------------------------------------------------

function filterImageAttachments(attachments: Attachment[] = []): Attachment[] {
  return attachments.filter((a) => a.type === 'image');
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
  /**
   * Telegram outbound:
   *   - 0 attachments → plain `sendMessage`
   *   - 1 image       → `sendPhoto` with caption
   *   - 2..10 images  → `sendMediaGroup` (Telegram caps the group at 10)
   *
   * Audio/video falls back to single-payload `sendDocument` for now —
   * Hermes #17833 (FLAC) is tracked separately.
   */
  buildOutboundMessage(channelId, message) {
    const attachments = message.attachments ?? [];
    const images = filterImageAttachments(attachments);

    if (attachments.length === 0) {
      return { method: 'sendMessage', chat_id: channelId, text: message.text };
    }

    if (images.length === 1) {
      const [img] = images;
      if (!img) {
        return { method: 'sendMessage', chat_id: channelId, text: message.text };
      }
      return {
        method: 'sendPhoto',
        chat_id: channelId,
        photo: img.url,
        ...(message.text || img.caption ? { caption: message.text || img.caption } : {}),
      };
    }

    if (images.length >= 2) {
      // Telegram mediaGroup hard-limit is 10. Trim and surface a continuation
      // in a follow-up text message rather than silently dropping.
      const TELEGRAM_MEDIA_GROUP_MAX = 10;
      const group = images.slice(0, TELEGRAM_MEDIA_GROUP_MAX).map((img, idx) => ({
        type: 'photo',
        media: img.url,
        // Caption only on the first item per Telegram convention.
        ...(idx === 0 && (message.text || img.caption)
          ? { caption: message.text || img.caption }
          : {}),
      }));
      const overflow = images.length - TELEGRAM_MEDIA_GROUP_MAX;
      return {
        method: 'sendMediaGroup',
        chat_id: channelId,
        media: group,
        ...(overflow > 0 ? { _overflow: overflow } : {}),
      };
    }

    // Single non-image attachment.
    const [first] = attachments;
    if (!first) {
      return { method: 'sendMessage', chat_id: channelId, text: message.text };
    }
    return {
      method: 'sendDocument',
      chat_id: channelId,
      document: first.url,
      ...(message.text ? { caption: message.text } : {}),
    };
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
   * Discord supports up to 10 attachments / embeds per message — we use the
   * `attachments` payload field (multipart upload) for files and `embeds` for
   * direct image URLs. Mixed sends collapse to embeds because they don't need
   * a multipart body.
   */
  buildOutboundMessage(_channelId, message) {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) {
      return { content: message.text };
    }
    const DISCORD_MAX_ATTACHMENTS = 10;
    const trimmed = attachments.slice(0, DISCORD_MAX_ATTACHMENTS);
    const embeds = trimmed.map((att) => ({
      ...(att.type === 'image' ? { image: { url: att.url } } : {}),
      ...(att.caption ? { description: att.caption } : {}),
      ...(att.type !== 'image' ? { url: att.url } : {}),
    }));
    const overflow = attachments.length - DISCORD_MAX_ATTACHMENTS;
    return {
      content: message.text,
      embeds,
      ...(overflow > 0 ? { _overflow: overflow } : {}),
    };
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
  /**
   * Slack: post the text first as the thread root, then attach files via
   * `files.upload` keyed by `thread_ts`. We return a multi-call descriptor —
   * the runtime is responsible for executing the steps in order. Backward
   * compat: when no attachments, behavior is identical to `buildOutbound`.
   */
  buildOutboundMessage(channelId, message) {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) {
      return {
        channel: channelId,
        text: message.text,
        ...(message.options?.threadTs ? { thread_ts: message.options.threadTs } : {}),
      };
    }
    return {
      kind: 'multi-step',
      channel: channelId,
      text: message.text,
      ...(message.options?.threadTs ? { thread_ts: message.options.threadTs } : {}),
      files: attachments.map((att) => ({
        url: att.url,
        ...(att.filename ? { filename: att.filename } : {}),
        ...(att.caption ? { title: att.caption } : {}),
        ...(att.mimeType ? { filetype: att.mimeType } : {}),
      })),
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
   * WhatsApp Cloud API: multi-image sends go as separate API calls (the API
   * has no native mediaGroup). We return a `multi-step` descriptor so the
   * runtime issues N image sends followed by the text body. Backward compat:
   * zero attachments returns the legacy single text payload.
   */
  buildOutboundMessage(channelId, message) {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) {
      return {
        messaging_product: 'whatsapp',
        to: channelId,
        type: 'text',
        text: { body: message.text },
      };
    }
    return {
      kind: 'multi-step',
      to: channelId,
      messaging_product: 'whatsapp',
      ...(message.text ? { text: { body: message.text } } : {}),
      attachments: attachments.map((att) => ({
        type: att.type === 'image' ? 'image' : 'document',
        ...(att.type === 'image' ? { image: { link: att.url, ...(att.caption ? { caption: att.caption } : {}) } } : { document: { link: att.url } }),
      })),
    };
  },
  /**
   * #295 — WhatsApp stranger + self-chat ban.
   * Self-chat is reported as `silentDrop: true` so the runtime never enqueues
   * or audits — that's the explicit fix for the Hermes echo loop.
   */
  checkAccess(_payload, normalized, config) {
    const aclConfig: WhatsAppAclConfig = loadWhatsAppAclConfig(config);
    // Self-chat (echo-loop) suppression is ALWAYS enforced when botWaId is
    // known — pure safety, no downside.
    if (aclConfig.botWaId && normalized.senderId === aclConfig.botWaId) {
      return { allowed: false, reason: 'self-chat', silentDrop: true };
    }
    // Stranger-gating is OPT-IN. An unconfigured channel (no allowlist, no
    // explicit allowStrangers) stays open so a fresh install / upgrade does
    // not silently reject every inbound message. Enforcement engages once the
    // operator configures `allowedContacts` or sets `allowStrangers`.
    const raw = (config ?? {}) as Record<string, unknown>;
    const gatingConfigured =
      aclConfig.allowedContacts.length > 0 || typeof raw.allowStrangers === 'boolean';
    if (!gatingConfigured) {
      return { allowed: true, reason: 'unconfigured-open' };
    }
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
  /**
   * Signal-CLI accepts multiple `--attachment` flags per send. We surface the
   * attachment URLs in an array — the runtime maps these to per-flag invocations.
   */
  buildOutboundMessage(channelId, message) {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) {
      return { recipient: channelId, message: message.text };
    }
    return {
      recipient: channelId,
      message: message.text,
      attachments: attachments.map((att) => att.url),
    };
  },
  /** #318 — Signal destination allowlist. Sender phone/UUID is the "destination" id. */
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
// Adapters that previously lived only in `packages/gateway/src/index.ts` —
// surfaced here so the destination ACL primitive has a uniform plug-in point.
// They share a single `checkAccess` implementation backed by
// `checkDestinationAcl`.
// ---------------------------------------------------------------------------

function loadDestinationAclConfig(raw: unknown): DestinationAclConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const allowedDestinations = Array.isArray(value.allowedDestinations)
    ? value.allowedDestinations.filter((s): s is string => typeof s === 'string')
    : [];
  return { allowedDestinations };
}

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
    buildOutboundMessage(channelId, message) {
      const attachments = message.attachments ?? [];
      if (attachments.length === 0) {
        return { channelId, text: message.text };
      }
      // Generic shape — Email/Matrix etc. consume this via runtime adapters.
      return {
        channelId,
        text: message.text,
        attachments: attachments.map((att) => ({
          type: att.type,
          url: att.url,
          ...(att.mimeType ? { mimeType: att.mimeType } : {}),
          ...(att.filename ? { filename: att.filename } : {}),
          ...(att.caption ? { caption: att.caption } : {}),
        })),
      };
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

// Apply #318 destination ACL to Telegram in addition to its native logic.
telegramChannel.checkAccess = (_payload, normalized, config) => {
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
};

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
