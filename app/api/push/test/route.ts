// テスト通知: 店主が「設定できているか」を着金なしで確認するための自分宛て送信。
// - wallet は requireSession() のみ (自分の購読にしか送れない = 他人への push 爆撃不可)
// - 1 分 1 回の rate limit (coalescing は経由しない直接送信のため、ここで抑制する)
// - flag OFF は 404 (購読 API と同じ inert 方針)
import { NextResponse } from 'next/server';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { env } from '@/lib/env';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
import { clientIp } from '@/lib/net/ipHash';
import { anonymizeIp } from '@/lib/relay/relayRoute';
import { sendPushToWallet } from '@/lib/push/server';

export const runtime = 'nodejs';
export const maxDuration = 10;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enablePushNotify) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const session = await requireSession();
  if (!session.ok) return session.response;

  try {
    const ipPrefix = anonymizeIp(
      clientIp(req) ?? '',
    );
    const key = `pushtest:${session.address.toLowerCase()}:${ipPrefix}`;
    if (!(await checkReadRateLimit(key, 1, 60))) {
      return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
    }
  } catch {
    // rate limit 障害でテスト通知を止めない (subscribe route と同方針)。
  }

  const summary = await sendPushToWallet(session.address, (locale) => ({
    title: locale === 'ja' ? 'テスト通知' : 'Test notification',
    body:
      locale === 'ja'
        ? 'OpenPay の着金通知はこの端末に届きます。'
        : 'OpenPay payment notifications will arrive on this device.',
  }));

  if (summary.attempted === 0) {
    return NextResponse.json(
      { ok: false, error: 'no_subscription' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, ...summary });
}
