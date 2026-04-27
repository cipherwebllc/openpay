'use client';

// paymaster mode に応じた gas 見積を返す統合フック。
// 両 hook を常に呼んで条件付きフック (React のルール違反) を避ける。enabled で
// 一方だけが active になり、もう片方は no-op。
//
// USDC ERC20 Paymaster: 顧客 USDC で gas 自動徴収 → useGasQuoteUsdc (USDC 建て)
// JPYC Sponsorship:     運営が POL gas を立替後 JPYC で精算 → useGasQuoteJpyc (JPYC 建て)
//
// 共通シェイプ ({ data?: { gasAmount: bigint }, error, isLoading, ... }) を返すので
// 呼出側は paymaster mode を意識せず breakdown / 表示計算ができる。

import { useGasQuoteJpyc } from './useGasQuoteJpyc';
import { useGasQuoteUsdc } from './useGasQuoteUsdc';
import { resolvePaymasterMode } from '@/lib/pimlico';
import type { TokenSymbol } from '@/lib/tokens';

export function useGasQuote(token: TokenSymbol, enabled: boolean = true) {
  const mode = resolvePaymasterMode(token);
  const usdc = useGasQuoteUsdc(token, enabled && mode === 'erc20');
  const jpyc = useGasQuoteJpyc(token, enabled && mode === 'sponsorship');
  return mode === 'erc20' ? usdc : jpyc;
}
