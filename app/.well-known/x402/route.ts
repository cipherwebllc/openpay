// x402scan 互換の discovery fan-out (docs/DISCOVERY.md B 方式)。
// GET /.well-known/x402 → { version: 1, resources: [このドメインの有料エンドポイント] }。
// flag OFF (本番既定) は 404 = 完全 inert。X402_PAY_TO_ADDRESS 未設定時は resources: [] に
// 縮退する (支払えない URL を外部インデクサに広告する波及を断つ — /api/discovery と同じ判断)。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import {
  FIRST_PARTY_RESOURCES,
  firstPartyPayToOrNull,
  firstPartyResourceUrl,
} from '@/lib/x402/firstParty';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const resources =
    firstPartyPayToOrNull() === null
      ? []
      : FIRST_PARTY_RESOURCES.map((r) => firstPartyResourceUrl(r));
  return NextResponse.json(
    { version: 1, resources },
    {
      headers: {
        // 内容は env でしか変わらないため edge キャッシュ可 (discovery route と同じ方針)。
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    },
  );
}
