// JPYC relay route の共有ヘルパ (決済 relay /api/relay/jpyc と CSV パス relay /api/csv-pass/relay)。
// 両 route が near-identical に複製していた route レベルの小物 (本文サイズ上限 / 10進文字列判定 /
// IP 匿名化 / RelayResult→HTTP 応答) をここへ集約する。挙動不変 (§8.5・byte-identical):
//   respond() は 2 route で **応答 body/status が完全同一**で、唯一の差は logger イベント名の prefix。
//   そこで makeRespond(logPrefix) を factory にし、jpyc は 'relay.jpyc'、csv-pass は 'csvpass.relay'
//   を渡して現行のイベント名 (relay.jpyc.reverted 等 / csvpass.relay.reverted 等) を完全再現する。
// 注意: jpycRelay は relayRoute を import しない (RelayResult を import するだけ) ので循環は無い。

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { anonymizedIpPrefix } from '@/lib/net/cloudflareIps';
import type { RelayResult } from './jpycRelay';

// body サイズ上限 (両 route 共通)。
export const MAX_BODY_BYTES = 4 * 1024;

export function isDec(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

// uint256 相当の桁上限 (2^256-1 は 78 桁)。10進文字列を BigInt parse する前に長さで bound し、過大入力を
// 弾く。facilitator の authorization/split 検証 (facilitatorSettle) と receipt (parseReceipt) の amount/fee で
// 同一上限を共有する単一情報源。
export const MAX_UINT256_DEC_DIGITS = 78;

export function isDecWithin(v: unknown, maxDigits: number): v is string {
  return isDec(v) && v.length <= maxDigits;
}

// IPv4 は /24・IPv6 は /64 (展開してから切る)。IP でなければ 'unknown'。
// 2026-09-06: 旧実装は圧縮 IPv6 (`2001:db8::1`) を `2001:db8::1::/64` にして完全なアドレスを残していた
// (cf-connecting-ip で真の利用者 IP が流れるようになり実害化) → lib/net/cloudflareIps の展開版へ。
export function anonymizeIp(ip: string): string {
  const first = ip.split(',')[0].trim();
  return anonymizedIpPrefix(first) ?? 'unknown';
}

// 結果 → HTTP 応答 (free / recover 共通)。pending は 202 で client に fallback 禁止を伝える。
// logPrefix はログのイベント名 prefix (jpyc: 'relay.jpyc' / csv-pass: 'csvpass.relay')。応答 body/status は
// 不変。reverted/pending/relay_error のみ logger.warn を出し、prefix を付けてイベント名を構成する。
export function makeRespond(
  logPrefix: string,
): (result: RelayResult, chainId: number) => NextResponse {
  return function respond(result: RelayResult, chainId: number): NextResponse {
    switch (result.kind) {
      case 'success':
        return NextResponse.json({ ok: true, txHash: result.txHash });
      case 'reverted':
        logger.warn(`${logPrefix}.reverted`, { txHash: result.txHash, chainId });
        return NextResponse.json({ ok: false, reverted: true, txHash: result.txHash });
      case 'pending':
        // broadcast 済だが未確定。client は standard へ fallback してはならない (二重支払い防止)。
        logger.warn(`${logPrefix}.pending`, { txHash: result.txHash, chainId });
        return NextResponse.json(
          { ok: false, pending: true, txHash: result.txHash ?? null },
          { status: 202 },
        );
      case 'rejected':
        return NextResponse.json(
          { ok: false, error: result.reason },
          { status: result.httpStatus },
        );
      case 'relay_error':
        logger.warn(`${logPrefix}.relay_error`, { detail: result.detail, chainId });
        return NextResponse.json({ ok: false, error: 'relay_error' }, { status: 502 });
    }
  };
}
