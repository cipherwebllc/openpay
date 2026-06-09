'use client';

// @handle 公開ページの受取方法メニュー。複数の受取方法 (JPYC Polygon / JPYC Kaia /
// USDC cross-chain 等) をボタンで提示し、選択中の方法の TipForm を1つだけ描画する
// (3つ同時 mount は wallet/relay の二重初期化になるため避ける)。全方法は同一受取アドレス
// (config.to) へ着金。TipForm 本体・決済規則には触れない。
//
// 単一方法のハンドルはボタンを出さず TipForm を直描画 (旧 single-config の後方互換)。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TipForm } from '@/components/TipForm';
import {
  methodToPublishableConfig,
  configToSearchParams,
  type HandleReceiveMethod,
  type HandleTipConfig,
} from '@/lib/handle';
import { parseTipParams } from '@/lib/url';
import { displaySymbolFor } from '@/lib/tokens';
import type { ChainSlug } from '@/lib/chains';

const CHAIN_LABEL: Record<ChainSlug, string> = {
  base: 'Base',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  polygon: 'Polygon',
  kaia: 'Kaia',
  ethereum: 'Ethereum',
  avalanche: 'Avalanche',
};

export function methodLabel(
  method: HandleReceiveMethod,
  crossChainText: string,
): string {
  const token = displaySymbolFor(method.token);
  const chainPart =
    method.token === 'usdc' && method.crossChain
      ? crossChainText
      : (CHAIN_LABEL[method.chain] ?? method.chain);
  return `${token} (${chainPart})`;
}

export function ReceiveMethodPicker({ config }: { config: HandleTipConfig }) {
  const t = useTranslations('HandleProfile');
  const [selected, setSelected] = useState(0);
  const methods = config.methods;

  // 選択中の方法を TipForm 用 params へ。保存時に検証済みだが読込時も再検証 (staleness 吸収)。
  const active = methods[Math.min(selected, methods.length - 1)];
  const parsed = useMemo(() => {
    const pc = methodToPublishableConfig(config, active);
    return parseTipParams(pc.to, configToSearchParams(pc));
  }, [config, active]);

  const form = parsed.ok ? (
    // key で token:chain ごとに remount。TipForm は preset/金額を mount 時の params から
    // 初期化するため、key 無しだと JPYC の 300 が USDC 300 として残る (金額誤り) のを防ぐ。
    <TipForm key={`${active.token}:${active.chain}`} params={parsed.params} />
  ) : (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
      {parsed.error}
    </div>
  );

  if (methods.length <= 1) return form;

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-center text-sm font-medium text-slate-600">
          {t('supportHeading')}
        </p>
        <div className="flex flex-col gap-2">
          {methods.map((m, i) => {
            const label = methodLabel(m, t('crossChain'));
            const isActive = i === selected;
            return (
              <button
                key={`${m.token}:${m.chain}:${i}`}
                type="button"
                onClick={() => setSelected(i)}
                aria-pressed={isActive}
                className={`rounded-xl border px-4 py-2.5 text-sm font-semibold transition ${
                  isActive
                    ? 'border-brand bg-brand text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {t('supportWith', { label })}
              </button>
            );
          })}
        </div>
      </div>
      {form}
    </div>
  );
}
