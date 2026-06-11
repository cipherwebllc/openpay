'use client';

// @handle 公開ページの受取方法メニュー。複数・単一問わず初期状態は全て折りたたみ。
// 方法ボタンをクリックするとその直下に TipForm がアコーディオン展開する。
// 同じボタン再クリックで折りたたみ、別ボタンクリックで展開先が切り替わる。
// 同時 mount は 1 つだけ (wallet/relay の二重初期化を避けるため)。
// 全方法は同一受取アドレス (config.to) へ着金。TipForm 本体・決済規則には触れない。

import { useEffect, useMemo, useState } from 'react';
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

// 展開アニメ: mount 直後は grid-rows-[0fr] で挿入し、次フレームで grid-rows-[1fr] へ遷移。
// max-height ハックを避け CSS grid-template-rows transition で実装。
// 折りたたみは unmount で即時、展開のみアニメーション。
// jsdom では requestAnimationFrame が同期的でないため、テストはクラス値を assert しない。
function ExpandOnMount({ children }: { children: React.ReactNode }) {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpened(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-300 ease-out ${opened ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

// 単一メソッドの展開コンテンツ: hooks を正しく呼べるようコンポーネントに分離。
// (map コールバック内での useMemo 使用を避けるため)
function MethodForm({
  config,
  method,
}: {
  config: HandleTipConfig;
  method: HandleReceiveMethod;
}) {
  const parsed = useMemo(() => {
    const pc = methodToPublishableConfig(config, method);
    return parseTipParams(pc.to, configToSearchParams(pc));
  }, [config, method]);

  if (!parsed.ok) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        {parsed.error}
      </div>
    );
  }
  // key で token:chain ごとに remount。TipForm は preset/金額を mount 時の params から
  // 初期化するため、key 無しだと JPYC の 300 が USDC 300 として残る (金額誤り) のを防ぐ。
  return (
    <TipForm key={`${method.token}:${method.chain}`} params={parsed.params} />
  );
}

export function ReceiveMethodPicker({ config }: { config: HandleTipConfig }) {
  const t = useTranslations('HandleProfile');
  // null = どれも未展開 (初期状態はスッキリ表示)
  const [selected, setSelected] = useState<number | null>(null);
  const methods = config.methods;

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
              <div key={`${m.token}:${m.chain}:${i}`}>
                <button
                  type="button"
                  onClick={() => setSelected(isActive ? null : i)}
                  aria-expanded={isActive}
                  className={`w-full rounded-xl border px-4 py-2.5 text-sm font-semibold transition ${
                    isActive
                      ? 'border-brand bg-brand text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {t('supportWith', { label })}
                </button>
                {isActive && (
                  <ExpandOnMount>
                    <MethodForm config={config} method={m} />
                  </ExpandOnMount>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
