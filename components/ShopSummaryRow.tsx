'use client';

// お店の設定の 1 行の要約 + 「設定」ボタン (決済QR・レジ共通・2026-10 磨き上げ P2)。
// 会計の画面の先頭に置き、どの店名・受取先・通貨とチェーン・支払い方法で QR を出すかを一目で確かめられるようにする。
// 表示だけ (値はタブの設定から受け取る・ここでは変えない)。

import { Settings2 } from 'lucide-react';
import type { Address } from 'viem';
import { ChainLogo, TokenLogo } from './AssetLogo';
import { shortAddress } from '@/lib/format';
import type { ChainSlug } from '@/lib/chains';
import type { TokenSymbol } from '@/lib/tokens';

export function ShopSummaryRow({
  storeName,
  receiver,
  token,
  tokenLabel,
  chainSlug,
  chainName,
  payLabel,
  payTone,
  onOpenSettings,
  labels,
}: {
  storeName: string;
  receiver: Address | null;
  token: TokenSymbol;
  tokenLabel: string;
  chainSlug: ChainSlug;
  chainName: string;
  /** 支払い方法の短い名前 (例「ガス代不要」)。 */
  payLabel: string;
  /** ピルの色。gasless = お客様のガス代が要らない (緑) / standard = お客様がガス代を払う (灰)。 */
  payTone: 'gasless' | 'standard';
  onOpenSettings: () => void;
  labels: { settings: string; noStoreName: string; noReceiver: string };
}) {
  const name = storeName.trim();
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {/* 狭い画面では受取先の表示を次の行へ回す (店名を「No shop…」と切らない)。 */}
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className={`max-w-full truncate text-sm font-semibold ${name ? 'text-slate-900' : 'text-slate-500'}`}>
            {name || labels.noStoreName}
          </span>
          {receiver ? (
            <span className="shrink-0 font-mono text-[11px] text-slate-500">{shortAddress(receiver)}</span>
          ) : (
            <span className="shrink-0 text-[11px] font-medium text-amber-700">{labels.noReceiver}</span>
          )}
        </p>
        {/* 通貨・チェーンは 1 まとまり、支払い方法は小さなピル (折り返しても区切りの点が行末に残らない)。 */}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <TokenLogo symbol={token} size={14} className="h-3.5 w-3.5" />
            <span>{tokenLabel}</span>
            <span aria-hidden className="text-slate-300">·</span>
            <ChainLogo slug={chainSlug} size={14} className="h-3.5 w-3.5" />
            <span>{chainName}</span>
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${
              payTone === 'gasless'
                ? 'bg-emerald-50 text-emerald-800 ring-emerald-200/70'
                : 'bg-slate-100 text-slate-700 ring-slate-200'
            }`}
          >
            {payLabel}
          </span>
        </p>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-brand hover:text-brand-dark"
      >
        <Settings2 className="h-3.5 w-3.5" aria-hidden />
        {labels.settings}
      </button>
    </div>
  );
}
