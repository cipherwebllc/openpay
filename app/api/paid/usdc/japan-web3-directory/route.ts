// Japan Web3 Directory 一覧を USDC (Base) の vanilla x402 で販売する route。
//
// sibling の /api/paid/japan-web3-directory (JPYC・forwarder-split・自前 facilitator) とは
// **別 money-path** (掟 12: 既存経路には触れない追加のみ)。精算は lib/x402/vanillaGate
// (v2 dual-stack・外部 facilitator = X402_FACILITATOR_URL) で、OpenPay 手数料なし =
// 表示価格の 100% が X402_PAY_TO_ADDRESS に届く。
//
// x402-next を使わない理由: 最新 (1.2.0) でも v1 応答しか出せず、x402scan が
// 「migrate to v2 spec」で登録拒否するため (2026-07-28 実測)。
//
// 買い手保護: gate は verify → content → (2xx/3xx のみ) settle の順。下の snapshot 503 で
// 課金されることはない。
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
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_QUERY: DirectoryQuery = {
  limit: DIRECTORY_MAX_LIMIT,
  offset: 0,
};

async function directoryListContent(): Promise<NextResponse> {
  const verificationSnapshot = await readDirectoryVerificationSnapshot();
  if (verificationSnapshot === null) {
    // 4xx/5xx は gate が settle しない = 買い手は課金されない。
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
  return NextResponse.json(envelope);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.enableWeb3Directory) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }
  return handleVanillaPaidGet(
    request,
    {
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}${USDC_DIRECTORY_LIST.path}`,
      description: USDC_DIRECTORY_LIST.description,
      price: USDC_DIRECTORY_LIST.price,
      outputSchema: {
        input: { type: 'http', method: 'GET', discoverable: true },
      },
    },
    directoryListContent,
  );
}
