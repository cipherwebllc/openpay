// Japan Web3 Directory 検索を USDC (Base) の vanilla x402 で販売する route。
// 一覧版 (../route.ts) と同じ vanillaGate 経由・同じ買い手保護 (verify → content →
// 2xx/3xx のみ settle)。query の検証は**支払い要求より先**に行い、不正 query に
// 402 を返して署名だけさせる無駄を断つ (JPYC 版と同じ順序)。
//
// 支払いの使い回しについて: 1 回の settle 成功が 1 応答の配信を gate するため、同一署名を
// 別 query に使い回しても 2 度目の settle は nonce 消費済みで失敗し配信されない
// (redelivery KV を持たない vanilla の設計は lib/x402/vanillaGate.ts 冒頭コメント参照)。

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  createDirectoryEnvelope,
  queryDirectory,
  validateDirectoryQuery,
} from '@/lib/directory/query';
import { USDC_DIRECTORY_SEARCH } from '@/lib/directory/usdcResource';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';
import type { DirectoryQuery } from '@/lib/directory/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function searchContent(query: DirectoryQuery): Promise<NextResponse> {
  const verificationSnapshot = await readDirectoryVerificationSnapshot();
  if (verificationSnapshot === null) {
    // 4xx/5xx は gate が settle しない = 買い手は課金されない。
    return NextResponse.json(
      { ok: false, error: 'storage_unavailable' },
      { status: 503 },
    );
  }
  const result = queryDirectory(DIRECTORY_ENTRIES, query);
  const envelope = createDirectoryEnvelope(
    query,
    result,
    new Date().toISOString(),
    verificationSnapshot,
  );
  return NextResponse.json(envelope);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.enableWeb3Directory) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }
  const parsed = validateDirectoryQuery(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  }
  return handleVanillaPaidGet(
    request,
    {
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}${USDC_DIRECTORY_SEARCH.path}`,
      description: USDC_DIRECTORY_SEARCH.description,
      price: USDC_DIRECTORY_SEARCH.price,
      outputSchema: {
        input: { type: 'http', method: 'GET', discoverable: true },
      },
    },
    () => searchContent(parsed.value),
  );
}
