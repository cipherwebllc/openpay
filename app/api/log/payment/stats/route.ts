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
import { kvLrange, kvLlen } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { requireAdminAuth } from '../_auth';

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
  // v3 fee/gas 分離フィールド。saleAmount = 売上総額 (gross・GMV の基礎)、
  // networkFeeEquivalent = 非 circle のネットワーク手数料相当額、feeBreakdownVersion を
  // 持つ log は分離記録済 (feeAmount = サービス料のみ)。持たない旧 log は feeAmount が
  // conflated (gas 混在) のため、利用手数料 total から除外する。
  saleAmount?: string;
  networkFeeEquivalent?: string;
  feeBreakdownVersion?: number;
  // phase 2 cross-chain bridge fields。direct (= bridge 経由でない) 同一 chain
  // 送金は両者とも undefined、Gateway / CCTP V2 経由なら値が入る。
  bridge?: string;
  sourceChainId?: number;
  // cross-chain (Step 3) の dest mint tx (= idempotency key) と bridge fee 上限 (ceiling)。
  // cross-chain success は resume で複数回 log され得るため (bridge+chainId+txHash) で dedup する。
  txHash?: string;
  bridgeFeeMax?: string;
  // Phase1 Circle Paymaster 監査フィールド (gasless circle 経路のみ)。
  provider?: string;
  circlePaymasterNetUsdc?: string;
  circleVerification?: string;
};

// gasless paymaster 系統別の集計 key。undefined provider (standard/legacy) は 'unknown'。
export type PaymentProviderKey = 'pimlico' | 'circle' | 'unknown';

type ProviderAgg = {
  provider: PaymentProviderKey;
  successCount: number;
  revertedCount: number;
  errorCount: number;
  // circle のみ: client 申告 net USDC と on-chain verified net USDC を別計上
  // (verified と client-reported を区別する・C2/C3)。
  circleNetUsdcReported: bigint;
  circleNetUsdcVerified: bigint;
};

type TokenAgg = {
  tokenAddress: string;
  successCount: number;
  revertedCount: number;
  errorCount: number;
  totalMerchantWei: bigint;
  totalFeeWei: bigint;
  // v3: 売上総額 (gross・GMV) と全経路横断のネットワーク手数料相当額。
  totalSaleWei: bigint;
  totalNetworkFeeWei: bigint;
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
  totalSaleWei: bigint;
  totalNetworkFeeWei: bigint;
  // cross-chain の bridge fee **上限** 合計 (ceiling・実 charge ではない・unreconciled)。
  totalBridgeFeeMaxWei: bigint;
};

type ChainAgg = {
  chainId: number;
  chainName: string;
  successCount: number;
  revertedCount: number;
  errorCount: number;
  totalMerchantWei: bigint;
  totalFeeWei: bigint;
  // v3: 売上総額 (gross・GMV)、全経路横断のネットワーク手数料相当額、内訳不明 (旧 log・
  // feeBreakdownVersion 不在) の success 件数 (利用手数料 total から除外した分の可視化)。
  totalSaleWei: bigint;
  totalNetworkFeeWei: bigint;
  unknownBreakdownCount: number;
  // cross-chain bridge fee 上限合計 (ceiling・unreconciled)。
  totalBridgeFeeMaxWei: bigint;
  byToken: Map<string, TokenAgg>;
  byBridge: Map<PaymentBridgeKey, BridgeAgg>;
};

// validation: KV から取り出した entry が集計対象として有効か。raw export は
// 別 endpoint で出すのでここでは strict — chainId / tokenAddress / result が
// 揃った entry のみ集計に含める。
function isAggregable(
  e: LogEntry,
): e is LogEntry & {
  chainId: number;
  tokenAddress: string;
  result: 'success' | 'reverted' | 'error';
} {
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
    totalSaleWei: 0n,
    totalNetworkFeeWei: 0n,
    totalBridgeFeeMaxWei: 0n,
  };
}

function normalizeProvider(raw: string | undefined): PaymentProviderKey {
  if (raw === 'pimlico') return 'pimlico';
  if (raw === 'circle') return 'circle';
  return 'unknown';
}

function emptyProviderAgg(provider: PaymentProviderKey): ProviderAgg {
  return {
    provider,
    successCount: 0,
    revertedCount: 0,
    errorCount: 0,
    circleNetUsdcReported: 0n,
    circleNetUsdcVerified: 0n,
  };
}

function aggregate(entries: LogEntry[]): {
  chains: ChainAgg[];
  aggregatedCount: number;
  invalidEntries: number;
  crossChainDeduped: number;
  byBridge: BridgeAgg[];
  byProvider: ProviderAgg[];
} {
  const byChain = new Map<number, ChainAgg>();
  const globalByBridge = new Map<PaymentBridgeKey, BridgeAgg>();
  const globalByProvider = new Map<PaymentProviderKey, ProviderAgg>();
  let aggregatedCount = 0;
  let invalidEntries = 0;
  // cross-chain success は executor の onMerchantMint が resume で複数回発火し得る
  // (route は POST を無条件 append)。同一着金の二重計上を防ぐため (bridge+chainId+txHash)
  // で dedup する。dedup 件数は透明性のため response に出す。
  let crossChainDeduped = 0;
  const seenCrossChain = new Set<string>();

  for (const e of entries) {
    if (!isAggregable(e)) {
      invalidEntries++;
      continue;
    }
    // cross-chain success の冪等 dedup (mint tx hash 単位)。
    const bridgeKeyForDedup = normalizeBridge(e.bridge);
    if (
      bridgeKeyForDedup !== 'direct' &&
      e.result === 'success' &&
      typeof e.txHash === 'string' &&
      e.txHash.length > 0
    ) {
      const key = `${bridgeKeyForDedup}:${e.chainId}:${e.txHash}`;
      if (seenCrossChain.has(key)) {
        crossChainDeduped++;
        continue;
      }
      seenCrossChain.add(key);
    }
    aggregatedCount++;
    const chainId = e.chainId;
    const tokenAddress = e.tokenAddress.toLowerCase();
    const result = e.result;
    const merchantWei = parseWei(e.merchantAmount);
    const feeWei = parseWei(e.feeAmount);
    const bridgeKey = normalizeBridge(e.bridge);
    // cross-chain (bridge !== direct) の merchantAmount は bridged intent (実着金 = minted は
    // bridge fee 控除後で未確定・B-3 で receipt 照合)。settled income ではないため chain/token の
    // totalMerchantWei には計上せず、byBridge 側にのみ intent として残す。GMV (totalSaleWei) と
    // bridge fee 上限 (totalBridgeFeeMaxWei) は計上する。
    const isCrossChain = bridgeKey !== 'direct';
    const bridgeFeeMaxWei = parseWei(e.bridgeFeeMax);
    // v3: 売上総額 (gross) は saleAmount を優先し、無い旧 log は着金額で代替 (gas=customer の
    // 大多数は両者一致するため GMV は概ね保たれる)。ネットワーク手数料相当額は非 circle の
    // networkFeeEquivalent と circle の circlePaymasterNetUsdc を coalesce。
    const saleWei =
      e.saleAmount !== undefined ? parseWei(e.saleAmount) : merchantWei;
    const netFeeWei =
      e.networkFeeEquivalent !== undefined
        ? parseWei(e.networkFeeEquivalent)
        : parseWei(e.circlePaymasterNetUsdc);
    // feeBreakdownVersion を持たない旧 log は feeAmount が conflated (gas 混在) のため、
    // OpenPay 利用手数料 total (totalFeeWei) には計上しない (内訳不明として別途カウント)。
    const hasSeparatedBreakdown =
      typeof e.feeBreakdownVersion === 'number' && e.feeBreakdownVersion >= 1;
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
        totalSaleWei: 0n,
        totalNetworkFeeWei: 0n,
        unknownBreakdownCount: 0,
        totalBridgeFeeMaxWei: 0n,
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
        totalSaleWei: 0n,
        totalNetworkFeeWei: 0n,
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

    // provider 別集計 (standard-fee は上で continue 済)。
    const providerKey = normalizeProvider(e.provider);
    let provider = globalByProvider.get(providerKey);
    if (!provider) {
      provider = emptyProviderAgg(providerKey);
      globalByProvider.set(providerKey, provider);
    }

    if (result === 'success') {
      chain.successCount++;
      token.successCount++;
      chainBridge.successCount++;
      globalBridge.successCount++;
      provider.successCount++;
      // Circle gas 徴収 net を verified / client-reported に分けて計上 (C2/C3)。
      if (providerKey === 'circle') {
        const net = parseWei(e.circlePaymasterNetUsdc);
        if (e.circleVerification === 'verified') {
          provider.circleNetUsdcVerified += net;
        } else {
          provider.circleNetUsdcReported += net;
        }
      }
      // GMV は success のみ計上 (reverted は資金移動なし、error は submit 失敗)。
      // totalFeeWei (OpenPay 利用手数料) は分離記録済 log のみ計上し、内訳不明の旧 log は
      // 除外する (conflated feeAmount が利用手数料収益として誤計上されるのを防ぐ)。
      const serviceFeeWei = hasSeparatedBreakdown ? feeWei : 0n;
      if (!hasSeparatedBreakdown) chain.unknownBreakdownCount++;
      // settled income (totalMerchantWei) は同一 chain 決済のみ。cross-chain は bridged intent
      // (実着金未確定) のため chain/token からは除外し、byBridge 側に intent として残す。
      const settledMerchantWei = isCrossChain ? 0n : merchantWei;
      chain.totalMerchantWei += settledMerchantWei;
      chain.totalFeeWei += serviceFeeWei;
      chain.totalSaleWei += saleWei;
      chain.totalNetworkFeeWei += netFeeWei;
      chain.totalBridgeFeeMaxWei += bridgeFeeMaxWei;
      token.totalMerchantWei += settledMerchantWei;
      token.totalFeeWei += serviceFeeWei;
      token.totalSaleWei += saleWei;
      token.totalNetworkFeeWei += netFeeWei;
      chainBridge.totalMerchantWei += merchantWei;
      chainBridge.totalFeeWei += serviceFeeWei;
      chainBridge.totalSaleWei += saleWei;
      chainBridge.totalNetworkFeeWei += netFeeWei;
      chainBridge.totalBridgeFeeMaxWei += bridgeFeeMaxWei;
      globalBridge.totalMerchantWei += merchantWei;
      globalBridge.totalFeeWei += serviceFeeWei;
      globalBridge.totalSaleWei += saleWei;
      globalBridge.totalNetworkFeeWei += netFeeWei;
      globalBridge.totalBridgeFeeMaxWei += bridgeFeeMaxWei;
    } else if (result === 'reverted') {
      chain.revertedCount++;
      token.revertedCount++;
      chainBridge.revertedCount++;
      globalBridge.revertedCount++;
      provider.revertedCount++;
    } else {
      chain.errorCount++;
      token.errorCount++;
      chainBridge.errorCount++;
      globalBridge.errorCount++;
      provider.errorCount++;
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

  // provider は固定順 ('pimlico' → 'circle' → 'unknown')。
  const providerOrder: PaymentProviderKey[] = ['pimlico', 'circle', 'unknown'];
  const byProvider = providerOrder
    .map((k) => globalByProvider.get(k))
    .filter((p): p is ProviderAgg => p !== undefined);

  return {
    chains,
    aggregatedCount,
    invalidEntries,
    crossChainDeduped,
    byBridge,
    byProvider,
  };
}

function serializeBridges(bridges: BridgeAgg[]) {
  return bridges.map((b) => ({
    bridge: b.bridge,
    successCount: b.successCount,
    revertedCount: b.revertedCount,
    errorCount: b.errorCount,
    totalMerchantWei: b.totalMerchantWei.toString(),
    totalFeeWei: b.totalFeeWei.toString(),
    totalSaleWei: b.totalSaleWei.toString(),
    totalNetworkFeeWei: b.totalNetworkFeeWei.toString(),
    totalBridgeFeeMaxWei: b.totalBridgeFeeMaxWei.toString(),
  }));
}

function serializeProviders(providers: ProviderAgg[]) {
  return providers.map((p) => ({
    provider: p.provider,
    successCount: p.successCount,
    revertedCount: p.revertedCount,
    errorCount: p.errorCount,
    // Circle gas 徴収 net (raw USDC)。verified = on-chain receipt 由来、
    // reported = client 申告 (未検証)。両者を混ぜない。
    circleNetUsdcVerified: p.circleNetUsdcVerified.toString(),
    circleNetUsdcReported: p.circleNetUsdcReported.toString(),
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
    totalSaleWei: c.totalSaleWei.toString(),
    totalNetworkFeeWei: c.totalNetworkFeeWei.toString(),
    totalBridgeFeeMaxWei: c.totalBridgeFeeMaxWei.toString(),
    unknownBreakdownCount: c.unknownBreakdownCount,
    byToken: Array.from(c.byToken.values())
      .sort((a, b) => b.successCount - a.successCount)
      .map((t) => ({
        tokenAddress: t.tokenAddress,
        successCount: t.successCount,
        revertedCount: t.revertedCount,
        errorCount: t.errorCount,
        totalMerchantWei: t.totalMerchantWei.toString(),
        totalFeeWei: t.totalFeeWei.toString(),
        totalSaleWei: t.totalSaleWei.toString(),
        totalNetworkFeeWei: t.totalNetworkFeeWei.toString(),
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

  const {
    chains,
    aggregatedCount,
    invalidEntries,
    crossChainDeduped,
    byBridge,
    byProvider,
  } = aggregate(filtered);

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
    byChain: serialize(chains),
    // bridge 経路の cross-cut 集計 (phase 2 cross-chain receive integration)。
    // bridge=direct = bridge 非使用 (= 既存単一 chain 送金) の集計、
    // gateway / cctp-v2 = 各 bridge 経由の集計。新規 cross-chain UX が
    // どれくらい使われているかを直接観測できる metric。
    byBridge: serializeBridges(byBridge),
    // provider 別集計 (Phase1 Circle Paymaster 並行対応)。pimlico / circle / unknown。
    // circle は gas 徴収 net を verified (on-chain) と reported (client 申告) に分けて出す
    // (C2/C3: 監査では両者を混同しない)。dataSource 注記の通り reported は未検証値。
    byProvider: serializeProviders(byProvider),
  });
}
