// TypeScript 型宣言 — テストから import するとき型補完を効かせるため。
// 本 .d.ts は scripts/check-pimlico-balance.mjs (CLI runtime) の `export` を
// 表す。実装は .mjs (node native ESM) で、tsc は declaration only として読む。

import type { Chain } from 'viem';

export interface ChainConfig {
  slug: string;
  chain: Chain;
  rpcEnv: string;
  rpcDefault: string;
  paymasterEnv: string;
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
  /** 残高を取得できなかった chain (`chain名: 理由`)。RPC 障害の隔離用。 */
  failures: string[];
}

export function runBalanceCheck(
  opts: BalanceCheckOptions,
): Promise<BalanceCheckResult>;
