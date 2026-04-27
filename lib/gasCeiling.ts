// チェーン別の maxFeePerGas 上限 (gwei)。これを超える gas 価格で UserOp を
// 送ると、フロア手数料 (15 JPYC / 0.2 USDC ≒ 30 JPY) では赤字になる可能性が
// 高いため、送信前に弾いてユーザに「ネットワーク混雑、後で再試行」を返す。
//
// 推定根拠 (200,000 gas / 1 UserOp 想定):
//   - Polygon 200 gwei: 0.04 POL ≒ 6 JPY (POL=$0.40, USD/JPY=150)、フロア
//     15 JPYC = 15 JPY との差 +9 JPY を担保。年数回起きる 300+ gwei spike を
//     除外しつつ、平常時の混雑 (100〜200 gwei) は通す。
//   - Base 1 gwei: L2 だけで判定。L1 calldata 費は L2 maxFeePerGas には乗ら
//     ないため、L1 spike (Ethereum mainnet 200+ gwei) は別軸で監視が必要。
//     ここでは L2 側のスパイクを捕らえる近似ガードとして 1 gwei を採用。
//
// Pimlico paymaster の sponsorship policy 側でも同等以上の上限を設定するこ
// とを推奨 (二重ガード: client-side は UX 用の早期エラー、server-side は
// クライアント改竄不可の最終防衛線)。
import { base, baseSepolia, polygon, polygonAmoy } from 'viem/chains';
import { env } from './env';

const GWEI = 10n ** 9n;

const DEFAULT_CEILING_GWEI: Record<number, bigint> = {
  [polygon.id]: 200n,
  [polygonAmoy.id]: 1000n, // testnet は開発体験を優先して緩く
  [base.id]: 1n,
  [baseSepolia.id]: 1000n,
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
