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

import { NextResponse } from 'next/server';
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  kaia,
  kairos,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
} from 'viem/chains';
import { kvLrange, kvLlen, isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const KV_KEY = 'openpay:payments:log';

// OpenPay が運用する全 chain (USDC 4 chain × mainnet/testnet + JPYC 2 chain
// × mainnet/testnet)。chainId → 表示名の lookup table、未知 chain は
// chainId をそのまま文字列化して返す。
const KNOWN_CHAINS = [
  polygon,
  polygonAmoy,
  base,
  baseSepolia,
  arbitrum,
  arbitrumSepolia,
  optimism,
  optimismSepolia,
  kaia,
  kairos,
] as const;

function chainName(chainId: number): string {
  const c = KNOWN_CHAINS.find((x) => x.id === chainId);
  return c ? c.name : `chainId:${chainId}`;
}

type LogEntry = {
  serverTs?: string;
  flow?: string;
  result?: string;
  chainId?: number;
  tokenAddress?: string;
  merchantAmount?: string;
  feeAmount?: string;
  // phase 2 cross-chain bridge fields。direct (= bridge 経由でない) 同一 chain
  // 送金は両者とも undefined、Gateway / CCTP V2 経由なら値が入る。
  bridge?: string;
  sourceChainId?: number;
};

type TokenAgg = {
  tokenAddress: string;
  successCount: number;
  revertedCount: number;
  errorCount: number;
  totalMerchantWei: bigint;
  totalFeeWei: bigint;
};

// "direct" = bridge 経由でない同一 chain transfer (entry.bridge undefined / 'none')。
// "gateway" / "cctp-v2" = 各 bridge 経由。"unknown" = 文字列だが想定外値 (future-proof)。
export type PaymentBridgeKey = 'direct' | 'gateway' | 'cctp-v2' | 'unknown';

type BridgeAgg = {
  bridge: PaymentBridgeKey;
  successCount: number;
  revertedCount: number;
  errorCount: number;
  totalMerchantWei: bigint;
  totalFeeWei: bigint;
};

type ChainAgg = {
  chainId: number;
  chainName: string;
  successCount: number;
  revertedCount: number;
  errorCount: number;
  totalMerchantWei: bigint;
  totalFeeWei: bigint;
  byToken: Map<string, TokenAgg>;
  byBridge: Map<PaymentBridgeKey, BridgeAgg>;
};

// validation: KV から取り出した entry が集計対象として有効か。raw export は
// 別 endpoint で出すのでここでは strict — chainId / tokenAddress / result が
// 揃った entry のみ集計に含める。
function isAggregable(e: LogEntry): boolean {
  if (typeof e.chainId !== 'number' || !Number.isInteger(e.chainId)) return false;
  if (typeof e.tokenAddress !== 'string') return false;
  if (e.result !== 'success' && e.result !== 'reverted' && e.result !== 'error') {
    return false;
  }
  return true;
}

function parseWei(v: string | undefined): bigint {
  if (v === undefined || v === '') return 0n;
  // /^[0-9]+$/ 以外は集計安全のため 0 として扱う (raw export で確認可能)。
  if (!/^[0-9]+$/.test(v)) return 0n;
  return BigInt(v);
}

function normalizeBridge(raw: string | undefined): PaymentBridgeKey {
  if (raw === undefined || raw === '' || raw === 'none') return 'direct';
  if (raw === 'gateway') return 'gateway';
  if (raw === 'cctp-v2') return 'cctp-v2';
  return 'unknown';
}

function emptyBridgeAgg(bridge: PaymentBridgeKey): BridgeAgg {
  return {
    bridge,
    successCount: 0,
    revertedCount: 0,
    errorCount: 0,
    totalMerchantWei: 0n,
    totalFeeWei: 0n,
  };
}

function aggregate(entries: LogEntry[]): {
  chains: ChainAgg[];
  aggregatedCount: number;
  invalidEntries: number;
  byBridge: BridgeAgg[];
} {
  const byChain = new Map<number, ChainAgg>();
  const globalByBridge = new Map<PaymentBridgeKey, BridgeAgg>();
  let aggregatedCount = 0;
  let invalidEntries = 0;

  for (const e of entries) {
    if (!isAggregable(e)) {
      invalidEntries++;
      continue;
    }
    aggregatedCount++;
    const chainId = e.chainId as number;
    const tokenAddress = (e.tokenAddress as string).toLowerCase();
    const result = e.result as 'success' | 'reverted' | 'error';
    const merchantWei = parseWei(e.merchantAmount);
    const feeWei = parseWei(e.feeAmount);
    const bridgeKey = normalizeBridge(e.bridge);
    // standard mode は merchant 送金 tx (flow=standard-merchant) と OpenPay 手数料
    // 徴収 tx (flow=standard-fee) の 2 entry で 1 logical sale を構成する。
    //   - standard-merchant: 通常 entry と同じく count++ / GMV 計上
    //   - standard-fee: count / GMV には加算せず、success の場合のみ
    //     merchantAmount (= 手数料金額) を totalFeeWei に計上する。
    //     batch / direct と異なり standard mode の手数料は別 tx なので、その
    //     収益情報を標準的な totalFeeWei 集計に統合する。
    // この特別扱いをしないと、standard-fee entry の merchantAmount (= 0.5%
    // 程度の手数料) が「店舗売上」として GMV に二重計上され、stats が systematically
    // ~0.5% 膨らむ。
    const isStandardFee = e.flow === 'standard-fee';

    let chain = byChain.get(chainId);
    if (!chain) {
      chain = {
        chainId,
        chainName: chainName(chainId),
        successCount: 0,
        revertedCount: 0,
        errorCount: 0,
        totalMerchantWei: 0n,
        totalFeeWei: 0n,
        byToken: new Map(),
        byBridge: new Map(),
      };
      byChain.set(chainId, chain);
    }

    let token = chain.byToken.get(tokenAddress);
    if (!token) {
      token = {
        tokenAddress,
        successCount: 0,
        revertedCount: 0,
        errorCount: 0,
        totalMerchantWei: 0n,
        totalFeeWei: 0n,
      };
      chain.byToken.set(tokenAddress, token);
    }

    let chainBridge = chain.byBridge.get(bridgeKey);
    if (!chainBridge) {
      chainBridge = emptyBridgeAgg(bridgeKey);
      chain.byBridge.set(bridgeKey, chainBridge);
    }
    let globalBridge = globalByBridge.get(bridgeKey);
    if (!globalBridge) {
      globalBridge = emptyBridgeAgg(bridgeKey);
      globalByBridge.set(bridgeKey, globalBridge);
    }

    if (isStandardFee) {
      // standard mode 手数料 tx: success の場合のみ totalFeeWei に計上
      // (reverted / error は手数料未徴収なので 0 計上)。count / GMV は触らない。
      if (result === 'success') {
        chain.totalFeeWei += merchantWei;
        token.totalFeeWei += merchantWei;
        chainBridge.totalFeeWei += merchantWei;
        globalBridge.totalFeeWei += merchantWei;
      }
      continue;
    }

    if (result === 'success') {
      chain.successCount++;
      token.successCount++;
      chainBridge.successCount++;
      globalBridge.successCount++;
      // GMV は success のみ計上 (reverted は資金移動なし、error は submit 失敗)
      chain.totalMerchantWei += merchantWei;
      chain.totalFeeWei += feeWei;
      token.totalMerchantWei += merchantWei;
      token.totalFeeWei += feeWei;
      chainBridge.totalMerchantWei += merchantWei;
      chainBridge.totalFeeWei += feeWei;
      globalBridge.totalMerchantWei += merchantWei;
      globalBridge.totalFeeWei += feeWei;
    } else if (result === 'reverted') {
      chain.revertedCount++;
      token.revertedCount++;
      chainBridge.revertedCount++;
      globalBridge.revertedCount++;
    } else {
      chain.errorCount++;
      token.errorCount++;
      chainBridge.errorCount++;
      globalBridge.errorCount++;
    }
  }

  // 集計順は successCount 降順、tie-breaker は chainId 昇順 (deterministic)
  const chains = Array.from(byChain.values()).sort((a, b) => {
    if (b.successCount !== a.successCount) return b.successCount - a.successCount;
    return a.chainId - b.chainId;
  });

  // bridge は固定順 ('direct' → 'gateway' → 'cctp-v2' → 'unknown')、
  // direct は本線、cross-chain bridge は派生という UI 視認性に合わせる。
  const bridgeOrder: PaymentBridgeKey[] = [
    'direct',
    'gateway',
    'cctp-v2',
    'unknown',
  ];
  const byBridge = bridgeOrder
    .map((k) => globalByBridge.get(k))
    .filter((b): b is BridgeAgg => b !== undefined);

  return { chains, aggregatedCount, invalidEntries, byBridge };
}

function serializeBridges(bridges: BridgeAgg[]) {
  return bridges.map((b) => ({
    bridge: b.bridge,
    successCount: b.successCount,
    revertedCount: b.revertedCount,
    errorCount: b.errorCount,
    totalMerchantWei: b.totalMerchantWei.toString(),
    totalFeeWei: b.totalFeeWei.toString(),
  }));
}

// 集計結果を JSON serializable に変換 (bigint → 10 進 string)。
function serialize(chains: ChainAgg[]) {
  return chains.map((c) => ({
    chainId: c.chainId,
    chainName: c.chainName,
    successCount: c.successCount,
    revertedCount: c.revertedCount,
    errorCount: c.errorCount,
    totalMerchantWei: c.totalMerchantWei.toString(),
    totalFeeWei: c.totalFeeWei.toString(),
    byToken: Array.from(c.byToken.values())
      .sort((a, b) => b.successCount - a.successCount)
      .map((t) => ({
        tokenAddress: t.tokenAddress,
        successCount: t.successCount,
        revertedCount: t.revertedCount,
        errorCount: t.errorCount,
        totalMerchantWei: t.totalMerchantWei.toString(),
        totalFeeWei: t.totalFeeWei.toString(),
      })),
    // chain ごとの bridge breakdown。固定順 (direct → gateway → cctp-v2 → unknown)。
    byBridge: serializeBridges(
      (['direct', 'gateway', 'cctp-v2', 'unknown'] as const)
        .map((k) => c.byBridge.get(k))
        .filter((b): b is BridgeAgg => b !== undefined),
    ),
  }));
}

export async function GET(req: Request): Promise<NextResponse> {
  const adminToken = process.env.PAYMENT_LOG_ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json(
      { ok: false, error: 'admin_token_not_configured' },
      { status: 503 },
    );
  }
  if (req.headers.get('authorization') !== `Bearer ${adminToken}`) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    );
  }
  if (!isKvConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'kv_not_configured' },
      { status: 503 },
    );
  }

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
    kvLrange(KV_KEY, from, to),
    kvLlen(KV_KEY),
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
  // parse error 数自体は logger.warn で別途集計可能だが、ここでは aggregate
  // の決定論性を優先して silently skip する。raw 確認は /export を使う。
  const entries: LogEntry[] = [];
  let parseErrors = 0;
  for (const s of range.value) {
    try {
      const obj = JSON.parse(s) as LogEntry;
      entries.push(obj);
    } catch {
      parseErrors++;
    }
  }

  // filter (chain + since) を集計前に適用
  const filtered = entries.filter((e) => {
    if (parsedChainIdFilter !== undefined && e.chainId !== parsedChainIdFilter) {
      return false;
    }
    if (sinceMs !== undefined) {
      const ts = e.serverTs ? Date.parse(e.serverTs) : NaN;
      if (Number.isNaN(ts) || ts < sinceMs) return false;
    }
    return true;
  });

  const { chains, aggregatedCount, invalidEntries, byBridge } =
    aggregate(filtered);

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
    filter: {
      chainId: parsedChainIdFilter ?? null,
      since: sinceFilter,
    },
    byChain: serialize(chains),
    // bridge 経路の cross-cut 集計 (phase 2 cross-chain receive integration)。
    // bridge=direct = bridge 非使用 (= 既存単一 chain 送金) の集計、
    // gateway / cctp-v2 = 各 bridge 経由の集計。新規 cross-chain UX が
    // どれくらい使われているかを直接観測できる metric。
    byBridge: serializeBridges(byBridge),
  });
}
