// 蓄積した payment log を chain 別に集計する admin endpoint。Bearer 認証必須。
// GMV / count / token 別内訳を返し、Kaia 投入後の chain 別 throughput 把握、
// Pimlico 残高との突合などに使用。
//
// ⚠️ 重要なデータ信頼性 disclosure (Codex 2026-05-23 audit):
// 集計元 `POST /api/log/payment` は認証なし + shape validation のみで、
// クライアントが result/chainId/merchantAmount を自由に申告できる。本 endpoint
// はその log を集計するため、出力は **「client-reported telemetry」** であり
// on-chain の真実ではない。弁護士 review / 金融庁事前相談など外部 evidence と
// しての利用には、`txHash` / `userOpHash` を chain RPC で再検証して transferFrom
// receipt と突合する追加 verifier が必要。本 endpoint の response には
// `meta.dataSource: 'client-reported, unverified'` を含めて呼出側に明示する。
//
// 集計は読み取り専用 (KV LRANGE のみ)、ストレージ追加なし。raw log は
// /api/log/payment/export で取得、本 endpoint はその chain 別 reduce 版。
// 集計そのもの (parse / filter / chain・token・bridge・provider 別の reduce / bigint の文字列化) は
// lib/paymentLogStats.ts の純関数。この route は認証・query の検証・KV の読み取り・応答だけを持つ。

import { NextResponse } from 'next/server';
import { kvLrange, kvLlen } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { PAYMENT_LOG_KV_KEY } from '@/lib/paymentLog';
import {
  aggregatePaymentLog,
  filterPaymentLogEntries,
  parsePaymentLogLines,
  serializeBridges,
  serializeChains,
  serializeProviders,
} from '@/lib/paymentLogStats';
import { requireAdminAuth } from '../_auth';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const authError = requireAdminAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const chainIdFilter = url.searchParams.get('chainId');
  const sinceFilter = url.searchParams.get('since');
  // 巨大 list 全件 LRANGE は KV / 帯域負荷 + Function CPU/メモリ負荷が大きい
  // ため、stats endpoint では window を hard cap (最大 5000 entry)。
  // - to=-1 (KV 末尾までスキャン) を拒否
  // - to - from > MAX_WINDOW を拒否
  // 全期間 raw データが必要なら /api/log/payment/export を使う設計。
  const MAX_WINDOW = 5_000;
  const from = Number(url.searchParams.get('from') ?? 0);
  const toRaw = url.searchParams.get('to');
  const to = toRaw === null ? MAX_WINDOW - 1 : Number(toRaw);

  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    to < from ||
    to - from + 1 > MAX_WINDOW
  ) {
    return NextResponse.json(
      { ok: false, error: 'invalid_window', maxWindow: MAX_WINDOW },
      { status: 400 },
    );
  }

  let parsedChainIdFilter: number | undefined;
  if (chainIdFilter !== null) {
    const n = Number(chainIdFilter);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json(
        { ok: false, error: 'invalid_chain_id' },
        { status: 400 },
      );
    }
    parsedChainIdFilter = n;
  }

  let sinceMs: number | undefined;
  if (sinceFilter !== null) {
    const t = Date.parse(sinceFilter);
    if (Number.isNaN(t)) {
      return NextResponse.json(
        { ok: false, error: 'invalid_since' },
        { status: 400 },
      );
    }
    sinceMs = t;
  }

  const [range, len] = await Promise.all([
    kvLrange(PAYMENT_LOG_KV_KEY, from, to),
    kvLlen(PAYMENT_LOG_KV_KEY),
  ]);

  if (!range.ok) {
    logger.warn('payment-log.stats-read-failed', {
      reason: range.reason,
      status: range.status,
    });
    return NextResponse.json(
      { ok: false, error: 'kv_read_failed' },
      { status: 502 },
    );
  }

  // JSON parse 失敗 entry は count せず considered から除外 (集計の sanity 保持)。
  const { entries, parseErrors } = parsePaymentLogLines(range.value);

  // filter (chain + since) を集計前に適用
  const filtered = filterPaymentLogEntries(entries, {
    chainId: parsedChainIdFilter,
    sinceMs,
  });

  const {
    chains,
    aggregatedCount,
    invalidEntries,
    crossChainDeduped,
    byBridge,
    byProvider,
  } = aggregatePaymentLog(filtered);

  return NextResponse.json({
    ok: true,
    // データ信頼性 disclosure: 集計元の POST /api/log/payment は認証なしの
    // shape-only validation 経路で、client-reported telemetry。on-chain と
    // 突合した verified GMV ではない。詳細は本 route ファイルの top comment。
    meta: {
      dataSource: 'client-reported, unverified',
      verifiedAgainstChain: false,
      maxWindow: 5_000,
    },
    total: len.ok ? len.value : null,
    windowFrom: from,
    windowTo: to,
    fetched: range.value.length,
    parseErrors,
    // 旧 `considered` は filter 通過数を指していたが、aggregate 段で skip
    // される entry を含んでいたため operational metric として誤解を招いた
    // (Codex audit 2026-05-23)。filteredCount (filter 通過) と
    // aggregatedCount (実際に byChain に反映) を分離、invalidEntries に
    // 「filter は通ったが isAggregable 不可」 を計上。
    filteredCount: filtered.length,
    aggregatedCount,
    invalidEntries,
    // cross-chain success の (bridge+chainId+txHash) 重複 (resume 由来) を除外した件数。
    crossChainDeduped,
    filter: {
      chainId: parsedChainIdFilter ?? null,
      since: sinceFilter,
    },
    byChain: serializeChains(chains),
    // bridge 経路の cross-cut 集計 (phase 2 cross-chain receive integration)。
    // bridge=direct = bridge 非使用 (= 既存単一 chain 送金) の集計、
    // gateway / cctp-v2 = 各 bridge 経由の集計。新規 cross-chain UX が
    // どれくらい使われているかを直接観測できる metric。
    byBridge: serializeBridges(byBridge),
    // provider 別集計 (Phase1 Circle Paymaster 並行対応)。pimlico / circle / unknown の固定順で
    // success / reverted / error の件数と circleNetUsdcReported (circle の success の gas 徴収 net の
    // client 申告額・circle 以外は '0') を出す。サーバ検証 (on-chain) の値を書く writer は無いので
    // verified の field は出さない (C8)。dataSource 注記の通り reported は未検証値。
    byProvider: serializeProviders(byProvider),
  });
}
