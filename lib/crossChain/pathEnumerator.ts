// Path enumerator — selectPath が「自動 best 1 経路」だけを返すのに対し、
// CrossChainSourceChooser UI が「buyer が選べる全 source chain options」を
// 列挙する必要があるため、共通の前段ロジックを分離。各 option は path 種別
// (direct / gateway / cctp-v2) + service fee (USDC atomic) + 推定 gas units +
// ETA を持つ。UI は chain 名 + balance + fee を表示して buyer に選ばせる。
//
// 設計方針:
// - 各 wallet balance entry を 1 つ以上の PathOption に展開
// - 同 chain (= target) なら direct path (service fee = 0)
// - cross-chain なら CCTP V2 option を必ず生成、Gateway pre-deposit 残高が
//   足りる source domain では Gateway option も加算 (より高速)
// - balance 不足の chain は除外 (chooser は viable options のみ表示)
//
// Fee 推定値の根拠 (実機計測ではなく Circle docs + EVM 一般値):
// - direct: ERC20 transfer ~50k gas
// - gateway mint (destination): ~150k gas
// - cctp-v2 burn (source) + receive (destination): ~80k + ~120k = ~200k gas
// - Gateway service fee: 10 bps (DEFAULT_MAX_FEE_BPS、min $0.001) — gateway.ts と同期
// - CCTP V2 Fast fee: 5 bps (Circle docs published、min $0.001 で揃える)
// 実機運用後に観測値で再 calibrate 推奨。

import type { MultiChainBalances } from './balance';
import { domainForChainId } from './config';
import type { CircleDomain } from './types';

export type PathKind = 'direct' | 'gateway' | 'cctp-v2';

export interface PathOption {
  /** React key + 一意識別子 (kind + chainId / domain) */
  key: string;
  kind: PathKind;
  /** Source chain id (buyer が USDC を持つ chain) */
  sourceChainId: number;
  /** Source domain (CCTP/Gateway 共通) */
  sourceDomain: CircleDomain;
  /** Buyer が source chain で利用可能な USDC 残高 (atomic、6 decimals)。
   *  direct/cctp-v2 は wallet balance、gateway は Gateway pre-deposit 残高。 */
  sourceBalanceAtomic: bigint;
  /** Circle 側 service fee (atomic USDC)。direct = 0 */
  serviceFeeAtomic: bigint;
  /** Buyer が支払う推定 gas units (ハードコード概算値) */
  estimatedGasUnits: bigint;
  /** どの chain の native token で gas を払うか。
   *  - direct / cctp-v2: source chain (buyer が source で tx 送信)
   *  - gateway: destination chain (gatewayMint は dest で submit) */
  gasOnChainId: number;
  /** End-to-end ETA (sec) — UX 表示用、Circle docs SLA 起点の概算値 */
  etaSeconds: number;
}

// === Gas units (path 種別ごとの典型値) ===
const GAS_UNITS_DIRECT_ERC20 = 50_000n;
const GAS_UNITS_GATEWAY_MINT = 150_000n;
const GAS_UNITS_CCTP_BURN_AND_RECEIVE = 200_000n;

// === Service fee bps (Circle 公開値) ===
// Gateway: gateway.ts の DEFAULT_MAX_FEE_BPS (10 bps) と一致
const GATEWAY_FEE_BPS = 10n;
// CCTP V2 Fast: Circle docs 公表値 0.5 bps だが、early access の margin で
// gateway と同じ 10 bps を上限として保守的に見積もる (実機計測後に再評価)
const CCTP_FAST_FEE_BPS = 10n;
// 最低 fee (atomic USDC = 0.001 USDC = 1000)。微少額 transfer で計算結果が
// 0/1 atomic に落ちて reject されるのを避けるための下限。
const MIN_FEE_ATOMIC = 1000n;

export function computeGatewayServiceFee(requiredAtomic: bigint): bigint {
  const computed = (requiredAtomic * GATEWAY_FEE_BPS) / 10000n;
  return computed < MIN_FEE_ATOMIC ? MIN_FEE_ATOMIC : computed;
}

export function computeCctpFastFee(requiredAtomic: bigint): bigint {
  const computed = (requiredAtomic * CCTP_FAST_FEE_BPS) / 10000n;
  return computed < MIN_FEE_ATOMIC ? MIN_FEE_ATOMIC : computed;
}

// === ETA (sec) ===
const ETA_DIRECT_SEC = 15;
const ETA_GATEWAY_SEC = 5;
const ETA_CCTP_V2_SEC = 30;

export interface EnumerateArgs {
  /** merchant 着金 chain id */
  targetChainId: number;
  /** 請求額 (invoice amount, atomic)。案A′ では顧客はこの額を source USDC で burn
   *  する (内訳: merchant 宛 amount-fee + operator 宛 fee)。balance 充足判定に使う。 */
  requiredAtomic: bigint;
  /** balance.ts readAllCrossChainBalances の戻り値 */
  balances: MultiChainBalances;
}

/** 全 viable source chain × path 組合せを返す。
 *  並び順: direct → gateway → cctp-v2、同 kind 内では balance 降順。
 *  balance 不足の chain (< requiredAtomic) は除外。
 *  各 PathOption の serviceFeeAtomic は Circle ブリッジ手数料の見積で、cross-chain
 *  path の比較用に表示する (merchant/operator が受取減で負担、顧客の支出は requiredAtomic)。 */
export function enumeratePathOptions(args: EnumerateArgs): PathOption[] {
  const { targetChainId, requiredAtomic, balances } = args;
  const options: PathOption[] = [];

  for (const w of balances.wallet) {
    if (w.status !== 'ok') continue;
    if (w.balance < requiredAtomic) continue;

    const sourceDomain = w.target.domain;

    // direct path: source == target
    if (w.target.chainId === targetChainId) {
      options.push({
        key: `direct-${w.target.chainId}`,
        kind: 'direct',
        sourceChainId: w.target.chainId,
        sourceDomain,
        sourceBalanceAtomic: w.balance,
        serviceFeeAtomic: 0n,
        estimatedGasUnits: GAS_UNITS_DIRECT_ERC20,
        gasOnChainId: w.target.chainId,
        etaSeconds: ETA_DIRECT_SEC,
      });
      continue;
    }

    // cross-chain: Gateway pre-deposit が源残高に足りるなら gateway option も加算
    const gatewayPreDeposit =
      balances.gateway.status === 'ok'
        ? (balances.gateway.perDomain.get(sourceDomain) ?? 0n)
        : 0n;
    if (gatewayPreDeposit >= requiredAtomic) {
      options.push({
        key: `gateway-${sourceDomain}`,
        kind: 'gateway',
        sourceChainId: w.target.chainId,
        sourceDomain,
        sourceBalanceAtomic: gatewayPreDeposit,
        serviceFeeAtomic: computeGatewayServiceFee(requiredAtomic),
        estimatedGasUnits: GAS_UNITS_GATEWAY_MINT,
        gasOnChainId: targetChainId,
        etaSeconds: ETA_GATEWAY_SEC,
      });
    }

    // CCTP V2 option (wallet balance from source chain)
    options.push({
      key: `cctp-v2-${w.target.chainId}`,
      kind: 'cctp-v2',
      sourceChainId: w.target.chainId,
      sourceDomain,
      sourceBalanceAtomic: w.balance,
      serviceFeeAtomic: computeCctpFastFee(requiredAtomic),
      estimatedGasUnits: GAS_UNITS_CCTP_BURN_AND_RECEIVE,
      gasOnChainId: w.target.chainId,
      etaSeconds: ETA_CCTP_V2_SEC,
    });
  }

  // Gateway pre-deposit のみで源 wallet なし (= 純粋な Gateway 残高利用)
  // のケースを補完: target 以外で gateway.perDomain に balance あって wallet
  // entry に出ない / wallet status='error' の domain があれば gateway option
  // を加算。chainId は domain から逆引き、未解決なら skip。
  if (balances.gateway.status === 'ok') {
    for (const [domain, gwBalance] of balances.gateway.perDomain.entries()) {
      if (gwBalance < requiredAtomic) continue;
      const alreadyHasGateway = options.some(
        (o) => o.kind === 'gateway' && o.sourceDomain === domain,
      );
      if (alreadyHasGateway) continue;
      // domain → chainId を逆引き (current env の mainnet/testnet)
      const chainId = chainIdForDomainLocal(domain, balances);
      if (chainId === undefined) continue;
      if (chainId === targetChainId) continue; // direct path で扱うべき (同 chain)
      options.push({
        key: `gateway-${domain}`,
        kind: 'gateway',
        sourceChainId: chainId,
        sourceDomain: domain,
        sourceBalanceAtomic: gwBalance,
        serviceFeeAtomic: computeGatewayServiceFee(requiredAtomic),
        estimatedGasUnits: GAS_UNITS_GATEWAY_MINT,
        gasOnChainId: targetChainId,
        etaSeconds: ETA_GATEWAY_SEC,
      });
    }
  }

  // 並び順: kind 優先度 (direct → gateway → cctp-v2) → 同 kind は balance 降順
  const kindRank: Record<PathKind, number> = {
    direct: 0,
    gateway: 1,
    'cctp-v2': 2,
  };
  options.sort((a, b) => {
    if (a.kind !== b.kind) return kindRank[a.kind] - kindRank[b.kind];
    if (a.sourceBalanceAtomic !== b.sourceBalanceAtomic) {
      return b.sourceBalanceAtomic > a.sourceBalanceAtomic ? 1 : -1;
    }
    return a.sourceChainId - b.sourceChainId;
  });
  return options;
}

// CROSS_CHAIN_TARGETS を import 循環せずに使えるよう、balances 内の wallet
// entries (= CROSS_CHAIN_TARGETS から enumerate された target) から逆引きする。
function chainIdForDomainLocal(
  domain: CircleDomain,
  balances: MultiChainBalances,
): number | undefined {
  for (const w of balances.wallet) {
    if (w.target.domain === domain) return w.target.chainId;
  }
  // 上記で見つからない場合 (= wallet 全 error + gateway balance のみ) は
  // domainForChainId の逆引きが使えないため、本 enumerator では skip。
  // selectPath / execute 経路は別途 chainIdForDomain (config.ts) を使うので
  // ここで undefined を返しても上流の決済は壊れない。
  return undefined;
}

// 上流 (router.ts の selectPath) と整合性を保つための helper export。
// 将来 router.ts と enumerator を統合する余地があるため、共通の domain
// resolution を将来 refactor で 1 箇所にまとめる候補。
export { domainForChainId as enumeratorDomainForChainId };
