// 支払いログ (POST /api/log/payment が KV に積んだ JSON 行) を chain / token / bridge / provider 別に
// 集計する純関数。GET /api/log/payment/stats (admin) の集計部分を route から抜き出したもの
// (第 8 回レビュー F-8・PR-18)。route は認証・query の検証・KV の読み取り・応答だけを持つ。
//
// ⚠️ 集計元は認証なしの client 申告 (shape だけ検証) なので、ここで出す値は「client-reported
// telemetry」で on-chain の真実ではない (route の先頭コメントと応答の meta.dataSource を参照)。
// 表示用の集計で、決済の判定には使わない。

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
import { chainNameForId } from '@/lib/chains';

// chainId → 表示名 (B-R6d・C16)。まず lib/chains の chainNameForId (選択中 network で対応する
// chain の一覧) で引き、無ければ下の固定表、それも無ければ `chainId:N`。chainNameForId は
// 選択中 network の chain しか名前を返さないため、固定表だけで名前が付いていた反対側 network の
// id (mainnet 選択時の Amoy・testnet 選択時の Polygon 等) を `chainId:N` に落とさないよう固定表を残す。
// 両方にある id は同じ viem Chain.name を返すので、既存の名前は変わらない。
const LEGACY_NAMED_CHAINS = [
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

export function statsChainName(chainId: number): string {
  return (
    chainNameForId(chainId) ??
    LEGACY_NAMED_CHAINS.find((x) => x.id === chainId)?.name ??
    `chainId:${chainId}`
  );
}

export type PaymentLogStatsEntry = {
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
  gatewayTransferSpecHash?: string;
  txHash?: string;
  bridgeFeeMax?: string;
  // Phase1 Circle Paymaster 監査フィールド (gasless circle 経路のみ)。
  provider?: string;
  circlePaymasterNetUsdc?: string;
};

// gasless paymaster 系統別の集計 key。undefined provider (standard/legacy) は 'unknown'。
export type PaymentProviderKey = 'pimlico' | 'circle' | 'unknown';

export type ProviderAgg = {
  provider: PaymentProviderKey;
  successCount: number;
  revertedCount: number;
  errorCount: number;
  // circle のみ: client 申告 net USDC (サーバ検証の writer は存在しない)。
  circleNetUsdcReported: bigint;
};

export type TokenAgg = {
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

export type BridgeAgg = {
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

export type ChainAgg = {
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

export type PaymentLogAggregate = {
  chains: ChainAgg[];
  aggregatedCount: number;
  invalidEntries: number;
  crossChainDeduped: number;
  byBridge: BridgeAgg[];
  byProvider: ProviderAgg[];
};

// bridge は固定順 ('direct' → 'gateway' → 'cctp-v2' → 'unknown')、
// direct は本線、cross-chain bridge は派生という UI 視認性に合わせる。
const BRIDGE_ORDER: readonly PaymentBridgeKey[] = ['direct', 'gateway', 'cctp-v2', 'unknown'];
// provider は固定順 ('pimlico' → 'circle' → 'unknown')。
const PROVIDER_ORDER: readonly PaymentProviderKey[] = ['pimlico', 'circle', 'unknown'];

/** KV の JSON 行を entry に戻す。JSON として読めない行は entries に入れず parseErrors に数える。
 * parse error 数自体は logger.warn で別途集計可能だが、ここでは aggregate の決定論性を優先して
 * silently skip する。raw 確認は /export を使う。 */
export function parsePaymentLogLines(lines: readonly string[]): {
  entries: PaymentLogStatsEntry[];
  parseErrors: number;
} {
  const entries: PaymentLogStatsEntry[] = [];
  let parseErrors = 0;
  for (const s of lines) {
    try {
      const obj = JSON.parse(s) as PaymentLogStatsEntry;
      entries.push(obj);
    } catch {
      parseErrors++;
    }
  }
  return { entries, parseErrors };
}

/** chain と since (serverTs が sinceMs 以上) で絞る。since 指定時は serverTs が無いか読めない entry を外す。 */
export function filterPaymentLogEntries(
  entries: readonly PaymentLogStatsEntry[],
  filter: { chainId?: number; sinceMs?: number },
): PaymentLogStatsEntry[] {
  return entries.filter((e) => {
    // 壊れた KV 行が JSON の `null` だと下の e.chainId / e.serverTs が TypeError を投げ、窓全体の GET が
    // 500 になる (POST は shape を検証するので通常の経路では入らない)。行 1 本の破損が集計全体に
    // 波及しないよう、null は chainId も serverTs も無い entry と同じ結果にする: 絞り込みがあれば外し、
    // 無ければ残して aggregatePaymentLog の invalidEntries に数える。42・"x"・[] など他の object で
    // ない値は property を読んでも投げず、もともとこの結果になる。
    if (e === null) return filter.chainId === undefined && filter.sinceMs === undefined;
    if (filter.chainId !== undefined && e.chainId !== filter.chainId) {
      return false;
    }
    if (filter.sinceMs !== undefined) {
      const ts = e.serverTs ? Date.parse(e.serverTs) : NaN;
      if (Number.isNaN(ts) || ts < filter.sinceMs) return false;
    }
    return true;
  });
}

// validation: KV から取り出した entry が集計対象として有効か。raw export は
// 別 endpoint で出すのでここでは strict — chainId / tokenAddress / result が
// 揃った entry のみ集計に含める。
export function isAggregable(
  e: PaymentLogStatsEntry,
): e is PaymentLogStatsEntry & {
  chainId: number;
  tokenAddress: string;
  result: 'success' | 'reverted' | 'error';
} {
  // 壊れた KV 行が JSON の `null` だと e.chainId が TypeError を投げ、集計全体 (GET) が 500 になる。
  // その波及を断つため、null は 42・"x"・[] など他の object でない値と同じく集計できない entry に
  // する (それらは property を読んでも投げず、下の chainId の検査で false になる)。
  if (e === null) return false;
  if (typeof e.chainId !== 'number' || !Number.isInteger(e.chainId)) return false;
  if (typeof e.tokenAddress !== 'string') return false;
  if (e.result !== 'success' && e.result !== 'reverted' && e.result !== 'error') {
    return false;
  }
  return true;
}

export function parseWei(v: string | undefined): bigint {
  if (v === undefined || v === '') return 0n;
  // /^[0-9]+$/ 以外は集計安全のため 0 として扱う (raw export で確認可能)。
  if (!/^[0-9]+$/.test(v)) return 0n;
  return BigInt(v);
}

export function normalizeBridge(raw: string | undefined): PaymentBridgeKey {
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

export function normalizeProvider(raw: string | undefined): PaymentProviderKey {
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
  };
}

export function aggregatePaymentLog(entries: readonly PaymentLogStatsEntry[]): PaymentLogAggregate {
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
    const settlementIdentity = bridgeKeyForDedup === 'gateway' && typeof e.gatewayTransferSpecHash === 'string'
      ? e.gatewayTransferSpecHash : e.txHash;
    if (
      bridgeKeyForDedup !== 'direct' &&
      e.result === 'success' &&
      typeof settlementIdentity === 'string' &&
      settlementIdentity.length > 0
    ) {
      const key = `${bridgeKeyForDedup}:${e.chainId}:${settlementIdentity.toLowerCase()}`;
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
        chainName: statsChainName(chainId),
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
      // サーバ検証の writer は存在しない。既存の client 申告分だけを集計する。
      if (providerKey === 'circle') {
        provider.circleNetUsdcReported += parseWei(e.circlePaymasterNetUsdc);
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

  const byBridge = BRIDGE_ORDER
    .map((k) => globalByBridge.get(k))
    .filter((b): b is BridgeAgg => b !== undefined);

  const byProvider = PROVIDER_ORDER
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

export function serializeBridges(bridges: readonly BridgeAgg[]) {
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

export function serializeProviders(providers: readonly ProviderAgg[]) {
  return providers.map((p) => ({
    provider: p.provider,
    successCount: p.successCount,
    revertedCount: p.revertedCount,
    errorCount: p.errorCount,
    // Circle gas 徴収 net (raw USDC)。client 申告のみで、サーバ検証済みではない。
    circleNetUsdcReported: p.circleNetUsdcReported.toString(),
  }));
}

// 集計結果を JSON serializable に変換 (bigint → 10 進 string)。
export function serializeChains(chains: readonly ChainAgg[]) {
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
      BRIDGE_ORDER
        .map((k) => c.byBridge.get(k))
        .filter((b): b is BridgeAgg => b !== undefined),
    ),
  }));
}
