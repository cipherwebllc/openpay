'use client';

// OpenPay Pro (月額 ¥500) の加入パネル。SIWE ログイン → 支払い前確認 (¥500/30日/自動更新なし/返金不可/
// 超過も 30日/別途ガス代) → 500 JPYC を FEE_RECEIVER へ送金 → /api/pro/subscribe で検証 + 付与。
// 検証失敗時は再支払いさせず再検証導線を出す。FEE_RECEIVER 未設定時は支払いボタンを無効化する
// (未設定の宛先へ 500 JPYC を送らせない)。設計: plans/pro-plan.md。
//
// 描画は共有スケルトン EntitlementPaywall に委譲し、本 wrapper は wallet chain 解決と Pro hook 呼出、
// Pro tier の config 注入だけを担う (CSV パスと共通の外枠/サインイン/確認→支払いフローを共有)。
// Pro は **ガスありのみ** (supportsGasless=false) — ガスレス relay 分岐は一切描画しない。
//
// ⚠️ 現状 app コードからは未参照: CSV ダウンロードのゲートは「都度型 CSV 24時間パス」(CsvPassPaywall・
// plans/csv-pass.md) へ置換済 (2026-06-13)。本コンポーネント・/api/pro/* ・useProSubscribe /
// useProStatus は **Pro 再点灯 (freee 連携などの継続価値の傘) 用に温存** し、テストも継続実行する
// (server infra + flag は inert 維持・将来 Pro 加入者へ CSV を自動付帯する Pro ⊃ CSV を csvPass が読む)。

import { useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useProSubscribe } from '@/hooks/useProSubscribe';
import {
  resolveDeployment,
  defaultDeploymentForSymbol,
} from '@/lib/tokens';
import { PRO_PRICE_JPYC, PRO_GRANT_DAYS } from '@/lib/proPlan';
import {
  EntitlementPaywall,
  type EntitlementPaywallConfig,
} from './EntitlementPaywall';

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

const PRO_CONFIG: EntitlementPaywallConfig = {
  namespace: 'Pro',
  supportsGasless: false,
  priceValues: { price: PRO_PRICE_JPYC, days: PRO_GRANT_DAYS },
  ctaValues: { price: PRO_PRICE_JPYC },
  confirmItems: [
    { key: 'confirmPrice', values: { price: PRO_PRICE_JPYC, days: PRO_GRANT_DAYS } },
    { key: 'confirmNoAutoRenew' },
    { key: 'confirmNoRefund' },
    { key: 'confirmOverpay' },
  ],
  gasLineKey: 'confirmGas',
  formatExpiry: formatDate,
};

export function ProPaywall() {
  const { chainId } = useAccount();

  const payDeployment = useMemo(
    () => (chainId != null ? resolveDeployment('jpyc', chainId) : undefined),
    [chainId],
  );
  const defaultJpyc = defaultDeploymentForSymbol('jpyc');
  // hook は常に有効な deployment で呼ぶ (条件付き呼出は不可)。実支払いは payDeployment 定義時のみ。
  const sub = useProSubscribe(payDeployment ?? defaultJpyc);

  return <EntitlementPaywall config={PRO_CONFIG} sub={sub} />;
}
