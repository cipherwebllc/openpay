'use client';

// プリセット + カスタム金額の選択ステートマシン (TipForm / NativeTipForm 共有)。
//
// 両フォームに byte 単位で重複していた状態・導出・ハンドラを 1 箇所へ集約する
// (挙動不変)。ネイティブ版は parseEther(x) を使っていたが、parseEther(x) は定義上
// parseUnits(x, 18) と同一であり NATIVE_DECIMALS === 18 のため、decimals=18 を渡せば
// amountWei は完全に同じになる (ERC20 版は deployment.decimals を渡す)。
//
// presets[0] を初期選択に取り込むのは両フォームの現行どおり (初回レンダ時の presets[0]
// を useState 初期値として固定)。amountWei の useMemo は同じガード連鎖を踏む:
//   入力が空 / DECIMAL_PATTERN 非一致 → 0n
//   トークン精度超過 → 0n (parseUnits の黙示丸めによる表示額↔実送金額の乖離を弾く)
//   それ以外 → parseUnits(amountStr, decimals)

import { useCallback, useMemo, useState } from 'react';
import { parseUnits } from 'viem';
import { DECIMAL_PATTERN, exceedsTokenPrecision } from '@/lib/url';

export interface UseTipAmountResult {
  selectedPreset: string | null;
  customAmount: string;
  customSelected: boolean;
  amountStr: string;
  amountWei: bigint;
  amountPrecisionError: boolean;
  selectPreset: (preset: string) => void;
  selectCustom: () => void;
  changeCustomAmount: (rawValue: string) => void;
}

export function useTipAmount({
  presets,
  decimals,
}: {
  presets: string[];
  decimals: number;
}): UseTipAmountResult {
  const [selectedPreset, setSelectedPreset] = useState<string | null>(
    presets[0] ?? null,
  );
  const [customAmount, setCustomAmount] = useState('');
  const customSelected = selectedPreset === null;

  const amountStr = customSelected ? customAmount : (selectedPreset ?? '');
  const amountWei = useMemo(() => {
    if (!amountStr || !DECIMAL_PATTERN.test(amountStr)) return 0n;
    // 精度超過は parseUnits が黙って丸めて表示額と実送金額が乖離するため弾く。
    if (exceedsTokenPrecision(amountStr, decimals)) return 0n;
    return parseUnits(amountStr, decimals);
  }, [amountStr, decimals]);
  const amountPrecisionError =
    !!amountStr &&
    DECIMAL_PATTERN.test(amountStr) &&
    exceedsTokenPrecision(amountStr, decimals);

  const selectPreset = useCallback((preset: string) => {
    setSelectedPreset(preset);
    setCustomAmount('');
  }, []);

  const selectCustom = useCallback(() => {
    setSelectedPreset(null);
  }, []);

  const changeCustomAmount = useCallback((rawValue: string) => {
    setSelectedPreset(null);
    setCustomAmount(rawValue.replace(/[^\d.]/g, ''));
  }, []);

  return {
    selectedPreset,
    customAmount,
    customSelected,
    amountStr,
    amountWei,
    amountPrecisionError,
    selectPreset,
    selectCustom,
    changeCustomAmount,
  };
}
