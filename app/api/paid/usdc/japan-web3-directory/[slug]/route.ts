// Japan Web3 Directory の 1 件 (slug) を USDC (Base / Arc) の vanilla x402 で販売する route。
// 一覧版 (../route.ts) と同じ vanillaGate 経由・同じ買い手保護 (verify → content →
// 2xx/3xx のみ settle)。JPYC 版 /api/paid/japan-web3-directory/[slug] とは別 money-path
// (掟 12: 既存経路には触れない追加のみ)。OpenPay 手数料なし = 表示価格の 100% が payTo に届く。
//
// 存在しない / 非公開の slug は支払い要求より先に 404 にする (署名も課金も発生させない・JPYC 版と同じ順序)。
// outputSchema を渡さない = Bazaar の掲載宣言を付けない: slug ごとに別 URL になり、カタログを
// 1 件ずつの行で埋めてしまうため (発見面は /openapi.json と llms.txt)。

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  createDirectoryEnvelope,
  findPublishedDirectoryEntry,
} from '@/lib/directory/query';
import {
  USDC_DIRECTORY_DETAIL,
  usdcDirectoryDetailDescription,
  usdcDirectoryDetailPath,
} from '@/lib/directory/usdcResource';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';
import type { DirectoryEntry } from '@/lib/directory/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function detailContent(entry: DirectoryEntry): Promise<NextResponse> {
  const verificationSnapshot = await readDirectoryVerificationSnapshot();
  if (verificationSnapshot === null) {
    // 4xx/5xx は gate が settle しない = 買い手は課金されない。
    return NextResponse.json(
      { ok: false, error: 'storage_unavailable' },
      { status: 503 },
    );
  }
  const envelope = createDirectoryEnvelope(
    { slug: entry.slug },
    { items: [entry], total: 1 },
    new Date().toISOString(),
    verificationSnapshot,
  );
  return NextResponse.json(envelope);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  if (!env.enableWeb3Directory) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }
  const { slug } = await params;
  const entry = findPublishedDirectoryEntry(DIRECTORY_ENTRIES, slug);
  if (!entry) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }
  return handleVanillaPaidGet(
    request,
    {
      // canonical URL は掲載データの slug から組む (リクエストの表記揺れを 402 に持ち込まない)。
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}${usdcDirectoryDetailPath(entry.slug)}`,
      description: usdcDirectoryDetailDescription(entry.slug),
      serviceName: USDC_DIRECTORY_DETAIL.serviceName,
      tags: USDC_DIRECTORY_DETAIL.tags,
      price: USDC_DIRECTORY_DETAIL.price,
    },
    () => detailContent(entry),
  );
}
