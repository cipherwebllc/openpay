import 'server-only';

import type { Address } from 'viem';
import { env } from '@/lib/env';
import { kvEval, kvExpire, kvIncr, kvSet } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { sendPushToWallet, type PushPayload } from '@/lib/push/server';
import type { PushLocale } from '@/lib/push/store';

export type PaymentNotificationKind = 'payment' | 'order' | 'store';

export const PUSH_NOTIFY_PENDING_TTL_SEC = 120;
export const PUSH_NOTIFY_COALESCE_TTL_SEC = 60;

const GETDEL_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
return raw
`;

export function pushNotifyPendingKey(
  wallet: Address | string,
  kind: PaymentNotificationKind,
): string {
  return `push:pending:${wallet.toLowerCase()}:${kind}`;
}

export function pushNotifyCoalesceKey(
  wallet: Address | string,
  kind: PaymentNotificationKind,
): string {
  return `push:coalesce:${wallet.toLowerCase()}:${kind}`;
}

export async function notifyPaymentReceived(
  wallet: Address | string,
  kind: PaymentNotificationKind,
  // ロック画面に出す金額ラベル (例 `¥1,234`)。opt-in 購読 (sub.includeAmount) かつ
  // 単一イベント (count===1) の payment 通知でのみ使う。⚠️ これは coalesce の NX 勝者
  // イベント自身の金額であり、pending にコアレスされた後続イベントの金額は加算/蓄積しない
  // (n>=2 は件数のみ)。pending 側に金額を貯めない設計なので合算漏れ/取り違えが起きない。
  amountLabel?: string,
): Promise<void> {
  if (!env.enablePushNotify) return;

  try {
    await notifyPaymentReceivedInner(wallet, kind, amountLabel);
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
  amountLabel: string | undefined,
): Promise<void> {
  // kind ごとに窓と件数を分離し、同一モバイル注文では着金と注文の 2 通知を許容する。
  const pendingKey = pushNotifyPendingKey(wallet, kind);
  const coalesceKey = pushNotifyCoalesceKey(wallet, kind);

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
  // resolver は購読ごとに評価される。金額は opt-in (sub.includeAmount) 購読にだけ出す。
  await sendPushToWallet(wallet, (locale, sub) =>
    copyFor(kind, locale, count, sub.includeAmount ? amountLabel : undefined),
  );
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
  amountLabel: string | undefined,
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

  if (kind === 'store') {
    if (count >= 2) {
      return {
        title:
          locale === 'ja'
            ? `商品が ${count} 件売れました`
            : `${count} products sold`,
      };
    }
    if (amountLabel) {
      return {
        title:
          locale === 'ja'
            ? `商品が売れました (${amountLabel})`
            : `Product sold (${amountLabel})`,
      };
    }
    return {
      title: locale === 'ja' ? '商品が売れました' : 'Product sold',
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

  // 単一 payment かつ opt-in 購読 (amountLabel present) のときだけ金額を出す。
  if (amountLabel) {
    return {
      title:
        locale === 'ja'
          ? `${amountLabel} の着金がありました`
          : `Payment received: ${amountLabel}`,
    };
  }

  return {
    title: locale === 'ja' ? '着金がありました' : 'Payment received',
  };
}
