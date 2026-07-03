import 'server-only';

import webPush from 'web-push';
import type { Address } from 'viem';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  listPushSubscriptions,
  refreshPushSubscriptionsTtl,
  removePushSubscription,
  type StoredPushSubscription,
} from '@/lib/push/store';

export type PushPayload = {
  title: string;
  body?: string;
};

export type SendPushSummary = {
  attempted: number;
  sent: number;
  pruned: number;
  failed: number;
};

const SEND_TIMEOUT_MS = 3_500;

export async function sendPushToWallet(
  wallet: Address | string,
  payload: PushPayload,
): Promise<SendPushSummary> {
  const summary: SendPushSummary = { attempted: 0, sent: 0, pruned: 0, failed: 0 };
  if (!env.enablePushNotify) return summary;
  if (!configureVapid()) return summary;

  const subs = await listPushSubscriptions(wallet);
  if (!subs.ok) {
    logger.warn('push.subscriptions_read_failed', { wallet: wallet.toLowerCase() });
    return summary;
  }

  summary.attempted = subs.value.length;
  const settled = await Promise.allSettled(
    subs.value.map((sub) => sendOne(wallet, sub, payload)),
  );
  for (const result of settled) {
    if (result.status === 'rejected') {
      summary.failed += 1;
      continue;
    }
    switch (result.value) {
      case 'sent':
        summary.sent += 1;
        break;
      case 'pruned':
        summary.pruned += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
    }
  }
  return summary;
}

function configureVapid(): boolean {
  const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY;
  const subject = process.env.PUSH_VAPID_SUBJECT;
  const publicKey = env.pushVapidPublicKey;
  if (!privateKey || !subject || !publicKey) {
    logger.warn('push.vapid_misconfigured');
    return false;
  }
  try {
    webPush.setVapidDetails(subject, publicKey, privateKey);
    return true;
  } catch (e) {
    logger.warn('push.vapid_config_failed', { detail: errorDetail(e) });
    return false;
  }
}

async function sendOne(
  wallet: Address | string,
  sub: StoredPushSubscription,
  payload: PushPayload,
): Promise<'sent' | 'pruned' | 'failed'> {
  try {
    await withTimeout(
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys,
        },
        JSON.stringify({
          title: payload.title,
          body: payload.body ?? '',
          url: `/${sub.locale}/history`,
        }),
      ),
      SEND_TIMEOUT_MS,
    );
    await refreshPushSubscriptionsTtl(wallet);
    return 'sent';
  } catch (e) {
    const status = responseStatus(e);
    if (status === 404 || status === 410) {
      await removePushSubscription(wallet, { endpointHash: sub.endpointHash });
      return 'pruned';
    }
    logger.warn('push.send_failed', {
      endpointHash: sub.endpointHash,
      status,
      detail: errorDetail(e),
    });
    return 'failed';
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('push_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function responseStatus(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null;
  const r = e as { statusCode?: unknown; status?: unknown };
  if (typeof r.statusCode === 'number') return r.statusCode;
  if (typeof r.status === 'number') return r.status;
  return null;
}

function errorDetail(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
