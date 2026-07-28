// Japan Web3 Directory 一覧を USDC (Base) の vanilla x402 で販売する route。
//
// sibling の /api/paid/japan-web3-directory (JPYC・forwarder-split・自前 facilitator) とは
// **別 money-path** (掟 12: 既存経路には触れない追加のみ)。こちらは x402-next の
// withX402Payment (検証/精算は X402_FACILITATOR_URL の外部 facilitator) で、
// OpenPay 手数料なし = 表示価格の 100% が X402_PAY_TO_ADDRESS に届く。
//
// 買い手保護: x402-next は verify → handler → (status<400 のときだけ) settle の順で動く
// (node_modules/x402-next 実装で確認済み) ため、下の snapshot 503 で課金されることはない。
//
// flag: データ本体と同じ NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY でゲート。JPYC facilitator の
// flag (enableX402Facilitator) は不要 — この経路は自前 facilitator を使わない。

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  createDirectoryEnvelope,
  DIRECTORY_MAX_LIMIT,
  queryDirectory,
} from '@/lib/directory/query';
import type { DirectoryQuery } from '@/lib/directory/types';
import { USDC_DIRECTORY_LIST } from '@/lib/directory/usdcResource';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
import { withX402Payment } from '@/lib/x402/middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_QUERY: DirectoryQuery = {
  limit: DIRECTORY_MAX_LIMIT,
  offset: 0,
};

async function directoryListHandler(
  _request: NextRequest,
): Promise<NextResponse> {
  const verificationSnapshot = await readDirectoryVerificationSnapshot();
  if (verificationSnapshot === null) {
    // 4xx/5xx を返すと x402-next は settle しない = 買い手は課金されない。
    return NextResponse.json(
      { ok: false, error: 'storage_unavailable' },
      { status: 503 },
    );
  }
  const result = queryDirectory(DIRECTORY_ENTRIES, LIST_QUERY);
  const envelope = createDirectoryEnvelope(
    LIST_QUERY,
    result,
    new Date().toISOString(),
    verificationSnapshot,
  );
  return NextResponse.json(envelope, {
    // 有料応答は共有キャッシュに載せない (#277 と同じ判断)。
    headers: { 'Cache-Control': 'no-store' },
  });
}

const paidHandler = withX402Payment(directoryListHandler, {
  price: USDC_DIRECTORY_LIST.price,
  description: USDC_DIRECTORY_LIST.description,
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.enableWeb3Directory) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }
  return paidHandler(request);
}
