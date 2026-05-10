// チェーン別の maxFeePerGas 上限 (gwei)。これを超える gas 価格で UserOp を
// 送ると、フロア手数料 (5 JPYC / 0.05 USDC) では赤字になる可能性が
// 高いため、送信前に弾いてユーザに「ネットワーク混雑、後で再試行」を返す。
//
// 値の根拠は Pimlico の `fast` tier 実測ベース (priority fee を含む quote)。
// L2 については「実 base fee」ではなく「Pimlico fast quote」を基準に置く点
// に注意。
//
//   - Polygon 400 gwei (sponsorship mode の運営 P&L 防衛線):
//     200,000 gas / UserOp / POL=60 JPY 想定で 0.08 POL ≒ 4.8 JPY、フロア
//     5 JPYC = 5 JPY とほぼ同額の break-even。実 ERC-4337 batched UserOp は
//     300〜500k gas が現実的なので、運用上は薄利だが Pimlico fast の平常時
//     spike (200〜400 gwei) を通すための妥協ライン。
//     500+ gwei 帯は本物の混雑なので block する。
//   - Base 10 gwei (USDC erc20 paymaster mode、顧客負担):
//     Pimlico fast の Base mainnet 平常時 quote が 1〜3 gwei、混雑時 5〜10
//     gwei 程度。実質 ceiling は「異常な spike を弾く UX ガード」のみで、
//     erc20 paymaster なので運営 P&L とは無関係。L1 calldata 費は L2 max
//     FeePerGas に乗らないため、L1 spike は別軸で監視必要。
//   - Arbitrum 5 gwei: 平常時 0.01〜1 gwei、spike 時 1〜5 gwei。USDC erc20
//     paymaster なので顧客負担、UX ガードとして妥当な水準。
//   - Optimism 5 gwei: 平常時 0.001〜0.1 gwei、spike 時 0.5〜5 gwei。
//     Arbitrum と同水準で設定。
//
// 環境別 override (NEXT_PUBLIC_GAS_CEILING_*_GWEI) で本番運用中に再デプロイ
// なしで再調整できる。Sentry の "gas_congested" 件数を見て段階的にチューニ
// ングする想定。
//
// Pimlico paymaster の sponsorship policy 側でも同等以上の上限を設定するこ
// とを推奨 (二重ガード: client-side は UX 用の早期エラー、server-side は
// クライアント改竄不可の最終防衛線)。
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
} from 'viem/chains';
import { env } from './env';

const GWEI = 10n ** 9n;

const DEFAULT_CEILING_GWEI: Record<number, bigint> = {
  [polygon.id]: 400n,
  [polygonAmoy.id]: 1000n, // testnet は開発体験を優先して緩く
  [base.id]: 10n,
  [baseSepolia.id]: 1000n,
  [arbitrum.id]: 5n,
  [arbitrumSepolia.id]: 1000n,
  [optimism.id]: 5n,
  [optimismSepolia.id]: 1000n,
};

function buildCeilingTable(): Record<number, bigint> {
  const table = { ...DEFAULT_CEILING_GWEI };
  // env 上書きは mainnet のみ適用 (運用フェーズで Sentry シグナルを見てチュー
  // ニングする想定)。testnet は固定値で開発を阻害しない。
  if (env.gasCeilingGwei.polygon !== undefined) {
    table[polygon.id] = BigInt(env.gasCeilingGwei.polygon);
  }
  if (env.gasCeilingGwei.base !== undefined) {
    table[base.id] = BigInt(env.gasCeilingGwei.base);
  }
  if (env.gasCeilingGwei.arbitrum !== undefined) {
    table[arbitrum.id] = BigInt(env.gasCeilingGwei.arbitrum);
  }
  if (env.gasCeilingGwei.optimism !== undefined) {
    table[optimism.id] = BigInt(env.gasCeilingGwei.optimism);
  }
  return table;
}

const CEILING_GWEI = buildCeilingTable();

export class GasCongestedError extends Error {
  readonly chainId: number;
  readonly ceilingGwei: bigint;
  readonly observedGwei: bigint;
  constructor(chainId: number, ceilingGwei: bigint, observedGwei: bigint) {
    super(
      `gas_congested: chainId=${chainId}, ceiling=${ceilingGwei} gwei, observed=${observedGwei} gwei`,
    );
    this.name = 'GasCongestedError';
    this.chainId = chainId;
    this.ceilingGwei = ceilingGwei;
    this.observedGwei = observedGwei;
  }
}

/** チェーン別の上限 gwei。未登録チェーンは undefined を返す。 */
export function gasCeilingGweiForChain(chainId: number): bigint | undefined {
  return CEILING_GWEI[chainId];
}

/**
 * maxFeePerGas (wei 単位) が上限を超えていれば GasCongestedError を投げる。
 * 上限が未定義のチェーン (mainnet/testnet 以外、稀ケース) では pass-through。
 */
export function assertGasCeiling(
  chainId: number,
  maxFeePerGas: bigint,
): void {
  const ceilingGwei = CEILING_GWEI[chainId];
  if (ceilingGwei === undefined) return;
  const ceilingWei = ceilingGwei * GWEI;
  if (maxFeePerGas > ceilingWei) {
    // 観測値の整数 gwei 表示用 (端数切捨て)。誤差はログ目的なので問題なし。
    const observedGwei = maxFeePerGas / GWEI;
    throw new GasCongestedError(chainId, ceilingGwei, observedGwei);
  }
}

export function isGasCongestedError(err: unknown): err is GasCongestedError {
  // instanceof は HMR / 別バンドルで信頼できないことがあるため name でも判定
  return (
    err instanceof GasCongestedError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'GasCongestedError')
  );
}
