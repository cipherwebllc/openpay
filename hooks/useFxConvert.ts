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
  fxRateDeviationWarning,
  isExpired,
  QR_EXPIRY_SECONDS,
  rateIsSane,
  secondsRemaining,
  type FxLkg,
} from '@/lib/fx';
import type { ChainSlug } from '@/lib/chains';
import type { PayMode } from '@/lib/fee';
import type { MarketRates } from '@/hooks/useMarketRates';
import type { QrSettings } from '@/hooks/useQrSettings';

// 「他トークン建てで受け取る」(FX 換算) を適用した状態。生成時のレートで amount を
// 確定済みなので、元の価格 (anchor) と適用レート・UI 上の期限目安を保持し URL に焼き込む。
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

// LKG (前回良好 USDC/JPY レート) の localStorage キー。ページを跨いで保持し、次回の
// レート取得時に急変検知の基準にする。DOM 依存のため純関数 fx.ts ではなくここに置く。
const FX_LKG_KEY = 'openpay:fxLkg:usdcjpy';

function readFxLkg(): FxLkg | null {
  try {
    const raw = localStorage.getItem(FX_LKG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FxLkg>;
    if (
      typeof parsed.rate !== 'number' ||
      typeof parsed.ts !== 'number'
    ) {
      return null;
    }
    return { rate: parsed.rate, ts: parsed.ts };
  } catch {
    return null;
  }
}

function writeFxLkg(rate: number, ts: number): void {
  try {
    localStorage.setItem(FX_LKG_KEY, JSON.stringify({ rate, ts }));
  } catch {
    // localStorage 不可 (Safari private 等) は黙って無視 (警告は fail-open)。
  }
}

// レート急変警告の表示状態 (LKG と新レートの両方を保持し ConvertPanel に両方を見せる)。
export type FxRateWarning = { lkgRate: number; newRate: number };

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
  fxWarning: FxRateWarning | null;
  acknowledgeFxWarning: () => void;
} {
  const { settings, amount, marketRates, setSettings, setAmount } = params;

  // convert 適用状態 (null = 通常 QR)。
  const [convert, setConvert] = useState<ConvertState | null>(null);
  // convert 中のみ 1 秒刻みで進める now (カウントダウン用)。convert null では更新しない。
  const [convertNowMs, setConvertNowMs] = useState(0);
  // レート急変警告 (F8)。新レートが LKG から ±20% を超えて跳ねたときだけ非 null。生成は
  // 止めず、ConvertPanel で目立つ警告 + acknowledge を出す。
  const [fxWarning, setFxWarning] = useState<FxRateWarning | null>(null);

  // 新しいレートを取得したら LKG と比較する (F8・defense-in-depth)。fresh な LKG から
  // ±20% 超なら警告を立て、LKG は更新しない (merchant の acknowledge / 再取得を待つ)。
  // 範囲内 / LKG 無し / stale なら silently に LKG を更新し警告を消す (bootstrap)。
  useEffect(() => {
    if (!marketRates || !rateIsSane(marketRates.usdcJpy)) return;
    const nowMs = Date.now();
    const res = fxRateDeviationWarning(readFxLkg(), marketRates.usdcJpy, nowMs);
    if (res.warn) {
      setFxWarning({ lkgRate: res.lkgRate, newRate: res.newRate });
    } else {
      setFxWarning(null);
      writeFxLkg(marketRates.usdcJpy, nowMs);
    }
    // usdcJpy の値変化だけを trigger にする (marketRates オブジェクト参照は毎回変わりうる)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketRates?.usdcJpy]);

  // merchant が急変を確認 (acknowledge): 新レートを LKG として採用し警告を消す。以後この
  // レートが基準になる (次の急変で再度警告)。
  const acknowledgeFxWarning = useCallback(() => {
    if (marketRates && rateIsSane(marketRates.usdcJpy)) {
      writeFxLkg(marketRates.usdcJpy, Date.now());
    }
    setFxWarning(null);
  }, [marketRates]);

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

  // 店主の価格入力を現レートで換算し、token を換算先へ切替・amount を確定・UI 上の
  // 期限目安を焼き込む。未署名 URL なのでサーバ側の認可条件にはならない。
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

  // 同じ anchor 価格を最新レートで再換算し、画面上の目安を 3 分リセット (token は据え置き)。
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
    fxWarning,
    acknowledgeFxWarning,
  };
}
