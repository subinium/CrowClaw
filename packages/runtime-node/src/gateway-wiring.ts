import {
  buildGatewaySessionKey,
  createDefaultAccessPolicy,
  evaluateAccess,
  sendDiscordMessage,
  sendSlackMessage,
  sendTelegramMessage,
  type ChannelAccessPolicy,
  type GatewayPlatform,
  type NormalizedInboundMessage,
  type PairingChallenge,
} from '@crowclaw/gateway';
import type { DeliveryFn, DeliveryTarget } from '@crowclaw/scheduler';
import type { RuntimeConfigStore } from './config-store.js';
import type { EventBus } from './event-bus.js';

export type GatewayActivityType = 'inbound' | 'outbound' | 'validation' | 'pairing';

export interface GatewayActivityEntry {
  timestamp: string;
  type: GatewayActivityType;
  platform: string;
  channelId?: string;
  userId?: string;
  ok?: boolean;
  error?: string;
  action?: string;
  sourceIp?: string;
}

export function createGatewayActivityLog(limit = 100) {
  const entries: GatewayActivityEntry[] = [];
  return {
    push(entry: Omit<GatewayActivityEntry, 'timestamp'> & { timestamp?: string }): void {
      entries.unshift({
        ...entry,
        timestamp: entry.timestamp ?? new Date().toISOString(),
      });
      if (entries.length > limit) entries.length = limit;
    },
    list(platform?: string | null, requestedLimit = limit): GatewayActivityEntry[] {
      const capped = Math.max(1, Math.min(limit, requestedLimit));
      return entries
        .filter((entry) => !platform || entry.platform === platform)
        .slice(0, capped);
    },
  };
}

export function compareSemverLike(left: string, right: string): number {
  const a = left.replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = right.replace(/^v/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface GatewayActivityLog {
  push(entry: Omit<GatewayActivityEntry, 'timestamp'> & { timestamp?: string }): void;
  list(platform?: string | null, requestedLimit?: number): GatewayActivityEntry[];
}

export function createGatewayAccessController(options: {
  configStore: RuntimeConfigStore;
  eventBus: EventBus;
  gatewayActivityLog: GatewayActivityLog;
}) {
  const { configStore, eventBus, gatewayActivityLog } = options;

  function getGatewayAccessPolicy(platform: GatewayPlatform): ChannelAccessPolicy | null {
    const config = configStore.getGatewayConfig(platform);
    if (!config) {
      return null;
    }

    const defaults = createDefaultAccessPolicy();
    if (!config.dmPolicy) config.dmPolicy = defaults.dmPolicy;
    if (!config.groupPolicy) config.groupPolicy = defaults.groupPolicy;
    if (!config.allowlist) config.allowlist = [...defaults.allowlist];
    if (!config.groupAllowlist) config.groupAllowlist = [...defaults.groupAllowlist];
    if (typeof config.requireMention !== 'boolean') config.requireMention = defaults.requireMention;
    return config as ChannelAccessPolicy;
  }

  function isGroupMessage(message: NormalizedInboundMessage): boolean {
    switch (message.platform) {
      case 'telegram': {
        const chatType = (message.raw as { message?: { chat?: { type?: string } } }).message?.chat?.type;
        return Boolean(chatType && chatType !== 'private');
      }
      case 'discord':
        return Boolean((message.raw as { guild_id?: string }).guild_id);
      case 'slack':
        return /^[CG]/.test(message.channelId);
      case 'matrix':
        return message.channelId.startsWith('!');
      default:
        return false;
    }
  }

  function enforceGatewayAccess(message: NormalizedInboundMessage): Response | null {
    eventBus.emit('gateway:inbound', { platform: message.platform, channelId: message.channelId, userId: message.userId });
    gatewayActivityLog.push({
      type: 'inbound',
      platform: message.platform,
      channelId: message.channelId,
      userId: message.userId,
    });
    if (message.channelId) {
      const existing = configStore.getGatewayConfig(message.platform);
      if (existing) {
        const extra = existing.extra ?? {};
        const channelKey = `channel:${message.channelId}`;
        if (!extra[channelKey]) {
          extra[channelKey] = new Date().toISOString();
          if (!extra[`mute:${message.channelId}`]) {
            extra[`mute:${message.channelId}`] = 'false';
          }
          configStore.setGatewayConfig(message.platform, { ...existing, extra });
        }
      }
    }
    const policy = getGatewayAccessPolicy(message.platform);
    if (!policy) {
      return Response.json(
        { ok: false, error: 'No access policy configured', platform: message.platform },
        { status: 403 }
      );
    }

    configStore.getPendingPairings();
    const decision = evaluateAccess(
      message,
      policy,
      isGroupMessage(message),
      configStore.getPendingPairingsMap() as Map<string, PairingChallenge>
    );

    if (decision.allowed) {
      return null;
    }

    const error = decision.reason === 'pairing-required'
      ? 'Pairing required.'
      : `Access denied: ${decision.reason}`;
    return Response.json({
      ok: false,
      error,
      reason: decision.reason,
      pairingCode: decision.pairingCode ?? null,
      sessionId: buildGatewaySessionKey(message)
    }, { status: 403 });
  }

  return {
    getGatewayAccessPolicy,
    enforceGatewayAccess,
  };
}

export function createGatewayDelivery(options: {
  configStore: RuntimeConfigStore;
  eventBus: EventBus;
  gatewayActivityLog: GatewayActivityLog;
}): DeliveryFn {
  const { configStore, eventBus, gatewayActivityLog } = options;

  return async (target: DeliveryTarget, content: string) => {
    const { platform, config: cfg } = target;
    eventBus.emit('gateway:outbound', { platform, contentLength: content.length });
    gatewayActivityLog.push({
      type: 'outbound',
      platform,
      channelId: cfg.channel ?? cfg.chatId ?? cfg.webhookUrl,
    });
    try {
      switch (platform) {
        case 'telegram': {
          const token = cfg.token ?? configStore.getGatewayConfig('telegram')?.token;
          const chatId = cfg.channel ?? cfg.chatId;
          if (!token || !chatId) return { ok: false, error: 'Missing Telegram token or chatId' };
          const result = await sendTelegramMessage(token, chatId, content, { parseMode: 'Markdown' });
          if (!result.ok) {
            eventBus.emit('gateway:error', { platform, error: result.error ?? 'send failed' });
            return { ok: false, error: result.error ?? 'Telegram send failed' };
          }
          return { ok: true };
        }
        case 'discord': {
          const webhookUrl = cfg.webhookUrl ?? cfg.channel;
          if (!webhookUrl) return { ok: false, error: 'Missing Discord webhook URL' };
          const result = await sendDiscordMessage(webhookUrl, content);
          if (!result.ok) {
            const raw = result.raw as { event?: string; reason?: string } | undefined;
            eventBus.emit('gateway:error', {
              platform,
              error: result.error,
              ...(raw?.event === 'gateway:endpoint_policy' && raw.reason ? { reason: `endpoint-policy:${raw.reason}` } : {}),
            });
          }
          return { ok: result.ok, error: result.error };
        }
        case 'slack': {
          const token = cfg.token ?? configStore.getGatewayConfig('slack')?.token;
          const channel = cfg.channel;
          if (!token || !channel) return { ok: false, error: 'Missing Slack token or channel' };
          const result = await sendSlackMessage(token, channel, content);
          if (!result.ok) eventBus.emit('gateway:error', { platform, error: result.error });
          return { ok: result.ok, error: result.error };
        }
        default:
          return { ok: false, error: `Unsupported delivery platform: ${platform}` };
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      eventBus.emit('gateway:error', { platform, error });
      return { ok: false, error };
    }
  };
}
