'use client';

// @handle 公開ページの受取方法メニュー。複数・単一問わず初期状態は全て折りたたみ。
// 方法ボタンをクリックするとその直下に TipForm がアコーディオン展開する。
// 同じボタン再クリックで折りたたみ、別ボタンクリックで展開先が切り替わる。
// 同時 mount は 1 つだけ (wallet/relay の二重初期化を避けるため)。
// 全方法は同一受取アドレス (config.to) へ着金。TipForm 本体・決済規則には触れない。

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Heart } from 'lucide-react';
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

const DEFAULT_ACCENT = '#2563eb';

export function ReceiveMethodPicker({ config }: { config: HandleTipConfig }) {
  const t = useTranslations('HandleProfile');
  // null = どれも未展開 (初期状態はスッキリ表示)
  const [selected, setSelected] = useState<number | null>(null);
  const methods = config.methods;
  const accent =
    config.color && /^#[0-9a-fA-F]{6}$/.test(config.color)
      ? config.color
      : DEFAULT_ACCENT;

  return (
    // 応援 (= OpenPay の核) はアクセントの専用カードで他のリンクと差別化し、ページの主役にする。
    <section
      className="rounded-3xl border p-4 sm:p-5"
      style={{ backgroundColor: `${accent}0d`, borderColor: `${accent}30` }}
    >
      <div className="flex items-center justify-center gap-1.5">
        <Heart className="h-[1.05rem] w-[1.05rem]" style={{ color: accent }} aria-hidden />
        <h2 className="text-base font-bold text-slate-900">{t('supportHeading')}</h2>
      </div>
      <p className="mt-1 text-center text-xs leading-relaxed text-slate-500">
        {t('supportSubtext')}
      </p>
      <div className="mt-4 flex flex-col gap-2.5">
        {methods.map((m, i) => {
          const label = methodLabel(m, t('crossChain'));
          const isActive = i === selected;

          return (
            <div key={`${m.token}:${m.chain}:${i}`}>
              <button
                type="button"
                onClick={() => setSelected(isActive ? null : i)}
                aria-expanded={isActive}
                style={
                  isActive
                    ? { backgroundColor: `${accent}1a`, borderColor: accent, color: accent }
                    : { borderColor: `${accent}59`, color: accent }
                }
                className={`w-full rounded-2xl border px-4 py-3 text-sm font-bold transition-all duration-200 ${
                  isActive
                    ? 'border-2'
                    : 'bg-white hover:-translate-y-0.5 hover:shadow-[0_8px_20px_-10px_rgba(15,23,42,0.25)]'
                }`}
              >
                {t('supportWith', { label })}
              </button>
              {isActive && (
                <ExpandOnMount>
                  <div className="pt-3">
                    <MethodForm config={config} method={m} />
                  </div>
                </ExpandOnMount>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
