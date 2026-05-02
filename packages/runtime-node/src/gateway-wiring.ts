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
