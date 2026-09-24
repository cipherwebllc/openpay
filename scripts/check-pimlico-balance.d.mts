// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 本 .d.ts は scripts/check-pimlico-balance.mjs (CLI runtime) の `export` を
// 表す。実装は .mjs (node native ESM) で、tsc は declaration only として読む。

import type { Chain } from 'viem';

export interface ChainConfig {
  slug: string;
  chain: Chain;
  rpcEnv: string;
  rpcDefault: string;
  /** 既存の監視対象 address。同名 + _V08 で 0.8 の読取先だけを上書きできる。 */
  paymasterEnv: string;
  /** 0.7 のしきい値 env。同名 + _V08 が空なら 0.8 は参照のみ。 */
  thresholdEnv: string;
  thresholdDefault: string;
  nativeSymbol: string;
  required: boolean;
}

export const CHAIN_CONFIGS: readonly ChainConfig[];

export interface BalanceCheckOptions {
  configs?: readonly ChainConfig[];
  webhookUrl: string;
  logger?: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export interface BalanceCheckResult {
  breached: boolean;
  message: string | null;
  lines: string[];
  alerts: string[];
  /** 通知対象で残高を取得できなかった chain/EntryPoint (`chain名 (EntryPoint 版): 理由`)。参照専用の失敗は含めない。 */
  failures: string[];
}

export function runBalanceCheck(
  opts: BalanceCheckOptions,
): Promise<BalanceCheckResult>;
