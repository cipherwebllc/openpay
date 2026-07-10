import 'server-only';

import { lookup as dnsLookup } from 'node:dns';
import type {
  LookupAddress,
  LookupAllOptions,
} from 'node:dns';
import { Agent as HttpsAgent } from 'node:https';
import webPush from 'web-push';
import type { Address } from 'viem';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { isPrivateHost } from '@/lib/net/privateHost';
import {
  listPushSubscriptions,
  refreshPushSubscriptionsTtl,
  removePushSubscription,
  type PushLocale,
  type StoredPushSubscription,
} from '@/lib/push/store';

export type PushPayload = {
  title: string;
  body?: string;
};

// resolver は locale に加え購読レコード (sub) も受ける。sub.includeAmount 等の
// 購読ごとの opt-in を見て文言を出し分けるため (後方互換: 既定の {title,body}
// オブジェクトも引き続き受ける)。
export type PushPayloadInput =
  | PushPayload
  | ((locale: PushLocale, sub: StoredPushSubscription) => PushPayload);

export type SendPushSummary = {
  attempted: number;
  sent: number;
  pruned: number;
  failed: number;
};

const SEND_TIMEOUT_MS = 3_500;

type LookupAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

function blockedAddressError(): NodeJS.ErrnoException {
  const error = new Error('push_blocked_private_address') as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}

// send ごとに新しい Agent を作り、socket reuse で lookup が省略されないようにする。lookup は A/AAAA
// を全件取得し、1 件でも private・空・解決失敗なら https.request の接続前に callback error で止める。
export function createPushHttpsAgent(
  lookupAll: LookupAll = dnsLookup,
): HttpsAgent {
  return new HttpsAgent({
    keepAlive: false,
    lookup: (hostname, options, callback) => {
      try {
        lookupAll(
          hostname,
          { ...options, all: true, verbatim: true },
          (error, addresses) => {
            if (error) {
              callback(error, '', 0);
              return;
            }
            if (
              addresses.length === 0 ||
              addresses.some((address) => isPrivateHost(address.address))
            ) {
              callback(blockedAddressError(), '', 0);
              return;
            }
            if (options.all) {
              callback(null, addresses);
              return;
            }
            callback(null, addresses[0].address, addresses[0].family);
          },
        );
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error('push_dns_lookup_failed'),
          '',
          0,
        );
      }
    },
  });
}

export async function sendPushToWallet(
  wallet: Address | string,
  payload: PushPayloadInput,
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
  payloadInput: PushPayloadInput,
): Promise<'sent' | 'pruned' | 'failed'> {
  const payload = resolvePushPayload(payloadInput, sub);
  try {
    const endpoint = new URL(sub.endpoint);
    if (endpoint.protocol !== 'https:' || isPrivateHost(endpoint.hostname)) {
      logger.warn('push.send_blocked_private_endpoint', {
        endpointHash: sub.endpointHash,
      });
      return 'failed';
    }
    const agent = createPushHttpsAgent();
    await withTimeout(
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys,
        },
        JSON.stringify({
          title: payload.title,
          body: payload.body ?? '',
          // ?from=push: /history 側で最新の受取エントリを一時ハイライトする着地マーカー。
          url: `/${sub.locale}/history?from=push`,
        }),
        { agent, timeout: SEND_TIMEOUT_MS },
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

function resolvePushPayload(
  payload: PushPayloadInput,
  sub: StoredPushSubscription,
): PushPayload {
  return typeof payload === 'function' ? payload(sub.locale, sub) : payload;
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
