'use client';

// 注文サマリ + 支払い — 商品があれば画面下部に浮く (sticky) アプリ風カートバー
// (MobileOrderView から抽出)。テーブル番号入力 / 受取スロット選択 / カート明細 (−n+) / 合計 /
// システム利用料の注記 / ラストオーダー告知 / 支払いボタン の純表示コンポーネント。
//
// 状態はすべて親 (MobileOrderView) が保持し、決済リンク (checkoutUrl) も **親で組み立てて** 渡す。
// この分割は再描画スコープの整理のみで、money-path / URL 構築には一切触れない (checkoutUrl は
// そのまま <a href> へ流すだけ)。アクセント色 (--mo-accent 系) は親ルートの CSS 変数を継承する。

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatUnits, parseUnits } from 'viem';
import { ChevronDown, ChevronUp, ShoppingCart } from 'lucide-react';
import { CHECKOUT_MAX_ITEMS } from '@/lib/url';
import { tokyoHHMM } from '@/lib/shopTime';
import type { CartLineView } from '@/components/MobileOrderView';

export function MobileOrderCartBar({
  tooMany,
  dineIn,
  tableNumber,
  onTableNumberChange,
  needsTable,
  pickup,
  cart,
  lastOrder,
  checkoutUrl,
  checkoutPending,
  onCheckout,
}: {
  /** /checkout の上限 (10 品) 超過。true で明細/支払いを止めて明示する。 */
  tooMany: boolean;
  /** 店内 (dineIn) 時のみテーブル番号入力を出す。 */
  dineIn?: boolean;
  tableNumber: string;
  /** テーブル番号入力の生値ハンドラ (最大長の切り詰めは親が行う)。 */
  onTableNumberChange: (value: string) => void;
  /** 店内なのにテーブル番号が未入力 → 支払いを止める (入力欄と支払いボタンの両方で使用)。 */
  needsTable: boolean;
  /** 受取スロット (Phase 4・preorder + flag ON のときだけ show=true)。 */
  pickup: {
    show: boolean;
    slots: number[];
    value: number | null;
    onChange: (value: number | null) => void;
  };
  /** カート明細 + 合計 + システム利用料 + ステッパのコールバック束。 */
  cart: {
    open: boolean;
    onToggle: () => void;
    lines: CartLineView[];
    decimals: number;
    count: number;
    totalHuman: string;
    feeUpcharge: bigint;
    feeBps: number;
    onItemQtyChange: (id: string, n: number) => void;
    onOptionQtyChange: (key: string, n: number) => void;
  };
  /** ラストオーダー時刻 "HH:mm" (Phase 4・受付中のみ・flag OFF/未設定は undefined)。 */
  lastOrder?: string;
  /** 親が組み立てた /checkout への deep-link (byte-identical にそのまま href へ)。 */
  checkoutUrl: string;
  /** 受付番号の mount 後生成待ち。true の間は checkout link を無効化する。 */
  checkoutPending: boolean;
  /** @handle 注文の server admission を通してから /checkout へ進む。 */
  onCheckout?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
  const t = useTranslations('MobileOrder');
  // テーブル番号入力に触れた (blur した) か。触れる前から警告色 (amber) で案内すると
  // エラー前のエラー表示になり、直下の取消不可注意 (真の警告・同色) の目立ちも薄める —
  // 触れる前はニュートラル色の案内、blur 後の未入力だけ警告色にする。
  const [tableTouched, setTableTouched] = useState(false);
  return (
    <div className="sticky bottom-3 z-30">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_-1px_3px_rgba(15,23,42,0.04),0_18px_44px_-14px_rgba(15,23,42,0.35)] supports-[backdrop-filter]:bg-white/85 supports-[backdrop-filter]:backdrop-blur">
        {tooMany ? (
          <p className="text-center text-sm text-red-600">
            {t('tooManyItems', { max: CHECKOUT_MAX_ITEMS })}
          </p>
        ) : (
          <div className="space-y-3">
            {/* 店内 (dineIn): テーブル番号 (必須)。未入力なら支払いボタンを無効化。 */}
            {dineIn && (
              <div>
                <label htmlFor="mo-table" className="block text-sm font-medium text-slate-700">
                  {t('tableLabel')}
                </label>
                <input
                  id="mo-table"
                  type="text"
                  inputMode="numeric"
                  value={tableNumber}
                  onChange={(e) => onTableNumberChange(e.target.value)}
                  placeholder={t('tablePlaceholder')}
                  aria-required="true"
                  aria-invalid={needsTable && tableTouched}
                  onBlur={() => setTableTouched(true)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[var(--mo-accent-text)] focus:outline-none"
                />
                {needsTable && (
                  <p
                    className={`mt-1 text-xs ${tableTouched ? 'text-amber-700' : 'text-slate-500'}`}
                  >
                    {t('tableRequired')}
                  </p>
                )}
              </div>
            )}
            {/* 受取時間 (Phase 4・preorder のみ・flag ON)。15分刻みのスロットから選ぶ (未選択=最短)。 */}
            {pickup.show && (
              <div>
                <label htmlFor="mo-pickup" className="block text-sm font-medium text-slate-700">
                  {t('pickupLabel')}
                </label>
                {pickup.slots.length === 0 ? (
                  <p className="mt-1 text-xs text-amber-700">{t('pickupNone')}</p>
                ) : (
                  <select
                    id="mo-pickup"
                    value={pickup.value ?? ''}
                    onChange={(e) => pickup.onChange(e.target.value ? Number(e.target.value) : null)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-[var(--mo-accent-text)] focus:outline-none"
                  >
                    <option value="">{t('pickupAsap')}</option>
                    {pickup.slots.map((ms) => (
                      <option key={ms} value={ms}>
                        {tokyoHHMM(ms)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            {/* ご注文内容 (合計の上)。カートマーク+点数のタップで明細を開閉。明細では −n+ で増減。 */}
            {cart.open && (
              <ul className="max-h-[42vh] space-y-2 overflow-y-auto border-b border-slate-100 pb-3">
                {cart.lines.map((l) => {
                  const adjust = (n: number) =>
                    l.isOption ? cart.onOptionQtyChange(l.key, n) : cart.onItemQtyChange(l.itemId, n);
                  return (
                    <li key={l.key} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-slate-700">{l.name}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => adjust(l.qty - 1)}
                          aria-label={t('qtyDecrease')}
                          className="relative flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-600 after:absolute after:-inset-1.5 after:content-['']"
                        >
                          −
                        </button>
                        <span className="w-5 text-center text-sm font-semibold tabular-nums">{l.qty}</span>
                        <button
                          type="button"
                          onClick={() => adjust(l.qty + 1)}
                          aria-label={t('qtyIncrease')}
                          className="relative flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-600 after:absolute after:-inset-1.5 after:content-['']"
                        >
                          ＋
                        </button>
                      </span>
                      <span className="w-16 shrink-0 text-right tabular-nums text-slate-600">
                        {formatUnits(parseUnits(l.price, cart.decimals) * BigInt(l.qty), cart.decimals)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* 合計 = カートマーク + 点数 (タップで上の明細を開閉) + 総額 */}
            <button
              type="button"
              onClick={cart.onToggle}
              aria-expanded={cart.open}
              aria-label={t('orderItemsToggle')}
              className="flex w-full items-center justify-between gap-2"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <span className="relative inline-flex">
                  <ShoppingCart className="h-5 w-5 text-slate-600" aria-hidden />
                  <span className="absolute -right-2 -top-2 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--mo-accent)] px-1 text-[10px] font-bold leading-none text-[var(--mo-accent-ink)]">
                    {cart.count}
                  </span>
                </span>
                {t('orderItemsToggle')}
                {cart.open ? (
                  <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden />
                ) : (
                  <ChevronUp className="h-4 w-4 text-slate-400" aria-hidden />
                )}
              </span>
              <span className="text-base font-semibold text-slate-900">{cart.totalHuman} JPYC</span>
            </button>
            {cart.feeUpcharge > 0n && (
              <p className="text-xs text-slate-500">
                {t('feeIncludedNote', {
                  fee: formatUnits(cart.feeUpcharge, cart.decimals),
                  percent: cart.feeBps / 100,
                })}
              </p>
            )}
            {/* ラストオーダー時刻の事前告知 (受付中のみ・超過後は上のバナーへ切替)。 */}
            {lastOrder && (
              <p className="text-xs text-slate-500">
                {t('lastOrderNote', { time: lastOrder })}
              </p>
            )}
            <p className="text-xs text-amber-700">{t('irreversibleNote')}</p>
            {needsTable || checkoutPending ? (
              // テーブル番号 未入力、または受付番号の生成前は支払いを止める。
              <button
                type="button"
                disabled
                className="block w-full cursor-not-allowed rounded-xl bg-slate-300 px-4 py-3 text-center text-sm font-semibold text-white"
              >
                {t('payButton')}
              </button>
            ) : (
              <a
                href={checkoutUrl}
                onClick={onCheckout}
                className="block rounded-xl bg-[var(--mo-accent)] px-4 py-3 text-center text-sm font-semibold text-[var(--mo-accent-ink)] hover:brightness-95"
              >
                {t('payButton')}
              </a>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
