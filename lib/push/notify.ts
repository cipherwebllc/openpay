import 'server-only';

import type { Address } from 'viem';
import { env } from '@/lib/env';
import { kvEval, kvExpire, kvIncr, kvSet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { sendPushToWallet, type PushPayload } from '@/lib/push/server';
import type { PushLocale } from '@/lib/push/store';

export type PaymentNotificationKind = 'payment' | 'order';

export const PUSH_NOTIFY_PENDING_TTL_SEC = 120;
export const PUSH_NOTIFY_COALESCE_TTL_SEC = 60;

const GETDEL_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
return raw
`;

export function pushNotifyPendingKey(wallet: Address | string): string {
  return `push:pending:${wallet.toLowerCase()}`;
}

export function pushNotifyCoalesceKey(wallet: Address | string): string {
  return `push:coalesce:${wallet.toLowerCase()}`;
}

export async function notifyPaymentReceived(
  wallet: Address | string,
  kind: PaymentNotificationKind,
): Promise<void> {
  if (!env.enablePushNotify) return;

  try {
    await notifyPaymentReceivedInner(wallet, kind);
  } catch (e) {
    logger.warn('push.notify_failed', {
      wallet: wallet.toLowerCase(),
      kind,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

async function notifyPaymentReceivedInner(
  wallet: Address | string,
  kind: PaymentNotificationKind,
): Promise<void> {
  const pendingKey = pushNotifyPendingKey(wallet);
  const coalesceKey = pushNotifyCoalesceKey(wallet);

  const incremented = await kvIncr(pendingKey);
  if (!incremented.ok) {
    logger.warn('push.notify_pending_incr_failed', {
      wallet: wallet.toLowerCase(),
      kind,
      reason: incremented.reason,
    });
    return;
  }

  const pendingTtl = await kvExpire(pendingKey, PUSH_NOTIFY_PENDING_TTL_SEC);
  if (!pendingTtl.ok) {
    logger.warn('push.notify_pending_ttl_failed', {
      wallet: wallet.toLowerCase(),
      kind,
      reason: pendingTtl.reason,
    });
  }

  const claim = await kvSet(coalesceKey, '1', {
    nx: true,
    ttlSec: PUSH_NOTIFY_COALESCE_TTL_SEC,
  });
  if (!claim.ok) {
    logger.warn('push.notify_coalesce_claim_failed', {
      wallet: wallet.toLowerCase(),
      kind,
      reason: claim.reason,
    });
    return;
  }
  if (claim.value === null) {
    // Coalesced events are counted in pending and sent by the next event that
    // opens a new window. A trailing event may wait until another event arrives.
    return;
  }

  const pending = await kvEval<string | null>(GETDEL_SCRIPT, [pendingKey], []);
  if (!pending.ok) {
    logger.warn('push.notify_pending_getdel_failed', {
      wallet: wallet.toLowerCase(),
      kind,
      reason: pending.reason,
    });
    return;
  }

  const count = parsePendingCount(pending.value, incremented.value);
  await sendPushToWallet(wallet, (locale) => copyFor(kind, locale, count));
}

function parsePendingCount(raw: string | null, fallback: number): number {
  if (raw === null) return Math.max(1, fallback);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(1, fallback);
}

function copyFor(
  kind: PaymentNotificationKind,
  locale: PushLocale,
  count: number,
): PushPayload {
  if (kind === 'order') {
    if (count >= 2) {
      return {
        title:
          locale === 'ja'
            ? `新着 ${count} 件の注文があります`
            : `${count} new orders received`,
      };
    }

    return {
      title: locale === 'ja' ? '新しい注文があります' : 'New order received',
    };
  }

  if (count >= 2) {
    return {
      title:
        locale === 'ja'
          ? `新着 ${count} 件の着金があります`
          : `${count} new payments received`,
    };
  }

  return {
    title: locale === 'ja' ? '着金がありました' : 'Payment received',
  };
}
