'use client';

// CSV 24時間パス (都度 100 JPYC) の購入パネル。会計CSVダウンロードが CSV パスゲート (passLocked)
// のときに HistoryView が描画する。SIWE ログイン → 支払い前確認 (100 JPYC/24時間/自動更新なし/返金不可/
// 合算なし/超過も24時間/別途ガス代) → 100 JPYC を FEE_RECEIVER へ送金 → /api/csv-pass/subscribe で
// 検証 + 付与。検証失敗時は再支払いさせず再検証導線を出す。FEE_RECEIVER 未設定時は支払いボタンを
// 無効化する (未設定の宛先へ 100 JPYC を送らせない)。設計: plans/csv-pass.md。
//
// 描画は共有スケルトン EntitlementPaywall に委譲し、本 wrapper は wallet chain 解決と CSV パス hook 呼出、
// CSV パス tier の config 注入だけを担う (Pro と共通の外枠/サインイン/確認→支払いフローを共有)。
// CSV パスは **ガスレス relay 対応** (supportsGasless=true) — relay 503 後のガスあり fallback・
// pending 再送信・payCtaGasless/noteGasless の出し分けは EntitlementPaywall が sub の gasless フィールド
// から描画する (本 wrapper の hook が relayEndpoint + 署名 callback を渡してガスレス経路を有効化する)。

import { useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useCsvPassSubscribe } from '@/hooks/useCsvPassSubscribe';
import {
  resolveDeployment,
  defaultDeploymentForSymbol,
} from '@/lib/tokens';
import { CSV_PASS_PRICE_JPYC, CSV_PASS_GRANT_HOURS } from '@/lib/csvPass';
import {
  EntitlementPaywall,
  type EntitlementPaywallConfig,
} from './EntitlementPaywall';

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

const CSV_PASS_CONFIG: EntitlementPaywallConfig = {
  namespace: 'CsvPass',
  supportsGasless: true,
  priceValues: { price: CSV_PASS_PRICE_JPYC, hours: CSV_PASS_GRANT_HOURS },
  ctaValues: { price: CSV_PASS_PRICE_JPYC },
  confirmItems: [
    {
      key: 'confirmPrice',
      values: { price: CSV_PASS_PRICE_JPYC, hours: CSV_PASS_GRANT_HOURS },
    },
    { key: 'confirmNoAutoRenew' },
    { key: 'confirmNoRefund' },
    { key: 'confirmNoStacking', values: { hours: CSV_PASS_GRANT_HOURS } },
    { key: 'confirmOverpay', values: { hours: CSV_PASS_GRANT_HOURS } },
  ],
  gasLineKey: 'confirmGas',
  gaslessGasLineKey: 'confirmGasGasless',
  formatExpiry: formatDate,
};

export function CsvPassPaywall() {
  const { chainId } = useAccount();

  const payDeployment = useMemo(
    () => (chainId != null ? resolveDeployment('jpyc', chainId) : undefined),
    [chainId],
  );
  const defaultJpyc = defaultDeploymentForSymbol('jpyc');
  // hook は常に有効な deployment で呼ぶ (条件付き呼出は不可)。実支払いは payDeployment 定義時のみ。
  const sub = useCsvPassSubscribe(payDeployment ?? defaultJpyc);

  return <EntitlementPaywall config={CSV_PASS_CONFIG} sub={sub} />;
}
