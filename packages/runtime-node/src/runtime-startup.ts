import { setTelegramWebhook } from '@crowclaw/gateway';
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
