/**
 * Self-Registering Channel System
 *
 * Inspired by the self-registering channel pattern popularized by NanoClaw.
 * Adding a new channel is a single-file change — no core modifications needed.
 */

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

// Auto-register built-in channels
channels.register(telegramChannel);
channels.register(discordChannel);
channels.register(slackChannel);
channels.register(whatsappChannel);
channels.register(signalChannel);
channels.register(genericChannel);
