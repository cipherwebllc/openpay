'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  counterpartSymbol,
  defaultConvertChainSlug,
  deploymentForSlug,
  isGaslessSupported,
  type TokenSymbol,
} from '@/lib/tokens';
import {
  convertAnchorAmount,
  isExpired,
  QR_EXPIRY_SECONDS,
  rateIsSane,
  secondsRemaining,
} from '@/lib/fx';
import type { ChainSlug } from '@/lib/chains';
import type { PayMode } from '@/lib/fee';
import type { MarketRates } from '@/hooks/useMarketRates';
import type { QrSettings } from '@/hooks/useQrSettings';

// 「他トークン建てで受け取る」(FX 換算) を適用した状態。生成時のレートで amount を
// 確定済みなので、元の価格 (anchor) と適用レート・有効期限を保持し URL に焼き込む。
// localStorage には永続化しない (時限的なので、ページ再訪で期限切れ QR を復元しない)。
export type ConvertState = {
  anchorAmount: string;
  anchorSymbol: TokenSymbol;
  anchorChain: ChainSlug;
  // convert 前の payMode (revert で復元する。convert で gasless 非対応 chain に
  // 倒れて standard 強制された場合に元へ戻すため)。
  anchorPayMode: PayMode;
  fxRate: string;
  expiresAt: number; // unix 秒
};

export function useFxConvert(params: {
  settings: QrSettings; // reads settings.token / settings.chain / settings.payMode
  amount: string;
  marketRates: MarketRates | null;
  setSettings: Dispatch<SetStateAction<QrSettings>>;
  setAmount: Dispatch<SetStateAction<string>>;
}): {
  convert: ConvertState | null;
  convertRemaining: number;
  convertExpired: boolean;
  applyConvert: () => void;
  recalcConvert: () => void;
  revertConvert: () => void;
  resetConvert: () => void;
} {
  const { settings, amount, marketRates, setSettings, setAmount } = params;

  // convert 適用状態 (null = 通常 QR)。
  const [convert, setConvert] = useState<ConvertState | null>(null);
  // convert 中のみ 1 秒刻みで進める now (カウントダウン用)。convert null では更新しない。
  const [convertNowMs, setConvertNowMs] = useState(0);

  useEffect(() => {
    if (!convert) return;
    setConvertNowMs(Date.now());
    const id = setInterval(() => setConvertNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [convert]);

  const convertRemaining = convert
    ? secondsRemaining(convert.expiresAt, convertNowMs)
    : 0;
  const convertExpired = convert
    ? isExpired(convert.expiresAt, convertNowMs)
    : false;

  // 店主の価格入力を現レートで換算し、token を換算先へ切替・amount を確定・期限を焼き込む。
  const applyConvert = useCallback(() => {
    if (!marketRates || !rateIsSane(marketRates.usdcJpy)) return;
    const target = counterpartSymbol(settings.token);
    const res = convertAnchorAmount({
      anchorAmount: amount,
      anchorSymbol: settings.token,
      targetSymbol: target,
      usdcJpy: marketRates.usdcJpy,
    });
    if (!res.ok) return;
    const targetChain = defaultConvertChainSlug(settings.chain, target);
    const dep = deploymentForSlug(target, targetChain);
    // convert と同時に nowMs を実時刻にして、初回描画で残り時間が巨大値で
    // フラッシュするのを防ぐ (effect も後追いで更新する)。
    setConvertNowMs(Date.now());
    setConvert({
      anchorAmount: amount,
      anchorSymbol: settings.token,
      anchorChain: settings.chain,
      anchorPayMode: settings.payMode,
      fxRate: String(marketRates.usdcJpy),
      expiresAt: Math.floor(Date.now() / 1000) + QR_EXPIRY_SECONDS,
    });
    setSettings((s) => ({
      ...s,
      token: target,
      chain: targetChain,
      // 換算先が gasless 非対応 chain なら standard に倒す (URL parser reject 回避)。
      payMode: isGaslessSupported(dep) ? s.payMode : 'standard',
    }));
    setAmount(res.amount);
  }, [marketRates, settings, amount, setSettings, setAmount]);

  // 同じ anchor 価格を最新レートで再換算し、期限を 3 分リセット (token は据え置き)。
  const recalcConvert = useCallback(() => {
    if (!convert || !marketRates || !rateIsSane(marketRates.usdcJpy)) return;
    const res = convertAnchorAmount({
      anchorAmount: convert.anchorAmount,
      anchorSymbol: convert.anchorSymbol,
      targetSymbol: settings.token,
      usdcJpy: marketRates.usdcJpy,
    });
    if (!res.ok) return;
    setConvertNowMs(Date.now());
    setConvert({
      ...convert,
      fxRate: String(marketRates.usdcJpy),
      expiresAt: Math.floor(Date.now() / 1000) + QR_EXPIRY_SECONDS,
    });
    setAmount(res.amount);
  }, [convert, marketRates, settings.token, setAmount]);

  // 元の価格建て (anchor token + chain + amount + payMode) に戻す。
  const revertConvert = useCallback(() => {
    if (!convert) return;
    const { anchorAmount, anchorSymbol, anchorChain, anchorPayMode } = convert;
    setConvert(null);
    setSettings((s) => ({
      ...s,
      token: anchorSymbol,
      chain: anchorChain,
      payMode: anchorPayMode,
    }));
    setAmount(anchorAmount);
  }, [convert, setSettings, setAmount]);

  const resetConvert = useCallback(() => setConvert(null), []);

  return {
    convert,
    convertRemaining,
    convertExpired,
    applyConvert,
    recalcConvert,
    revertConvert,
    resetConvert,
  };
}
