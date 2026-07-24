'use client';

// 商品カード (MobileOrderView から抽出・おすすめセクション + カテゴリーグリッドで共用)。
// 売り切れ品はステッパを隠し、写真上に「売り切れ」を重ねて注文不可を明示する (qty も増やせない)。
//
// React.memo 化して描画スコープを分離する: 親 (MobileOrderView) は 1 品の qty 変更やカート開閉/
// テーブル番号入力/オプションモーダル開閉のたびに再レンダーするが、このカードには **その品の派生値
// (qty / 売り切れ / オプション数) + 安定コールバックだけ** を渡すため、変化していない品のカードは
// 再描画されない (アクセント色は親ルートの CSS 変数を継承するので prop 不要)。

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { UtensilsCrossed } from 'lucide-react';
import { safeHttpUrl, type MenuItem } from '@/lib/mobileOrder';

function MenuItemCardImpl({
  item,
  qty,
  isSoldOut,
  hasOptions,
  optionCount,
  onQtyChange,
  onOpenOptions,
}: {
  item: MenuItem;
  /** この品の現在数量 (親の qty マップ由来・オプション無し商品のステッパ用)。 */
  qty: number;
  /** 売り切れ (ライブ運用状態)。true でステッパを隠し「売り切れ」を重ねる。 */
  isSoldOut: boolean;
  /** オプション有り商品 (flag ON + options>0)。true で「選ぶ」ボタン (モーダル起動)。 */
  hasOptions: boolean;
  /** この品でカートに入っているオプション行の合計点数 (「選ぶ (n)」併記用)。 */
  optionCount: number;
  /** 数量変更 (安定参照)。オプション無し商品のステッパから (id, 次の数量) で呼ぶ。 */
  onQtyChange: (id: string, n: number) => void;
  /** オプション選択モーダルを開く (安定参照)。オプション有り商品の「選ぶ」から呼ぶ。 */
  onOpenOptions: (item: MenuItem) => void;
}) {
  const t = useTranslations('MobileOrder');
  const n = qty;
  const imgUrl = item.visual?.kind === 'image' ? safeHttpUrl(item.visual.url) : undefined;
  return (
    <li
      className={`flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_2px_10px_-4px_rgba(15,23,42,0.1)] transition-shadow duration-200 hover:shadow-[0_12px_28px_-12px_rgba(15,23,42,0.22)] ${
        isSoldOut ? 'opacity-60' : ''
      }`}
    >
      {/* 写真 (大きく・正方形)。画像が無ければ絵文字、それも無ければアイコン。売り切れは重ね表示。 */}
      <div className="relative flex aspect-square w-full items-center justify-center bg-slate-50">
        {imgUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgUrl} alt="" className="h-full w-full object-cover" />
        ) : item.visual?.kind === 'emoji' ? (
          <span className="text-5xl" aria-hidden>
            {item.visual.value}
          </span>
        ) : (
          <UtensilsCrossed className="h-8 w-8 text-slate-300" aria-hidden />
        )}
        {isSoldOut && (
          <span className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-bold text-slate-600">
            {t('viewSoldOut')}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <span className="line-clamp-2 text-sm font-semibold text-slate-800">{item.name}</span>
        {/* 価格 + アクション (未追加=＋ボタン / 追加後=−n+ ピル)。売り切れはどちらも出さない。 */}
        <div className="mt-auto flex items-center justify-between gap-1">
          <span className="min-w-0">
            <span className="text-base font-bold text-slate-900">{item.price}</span>{' '}
            <span className="text-[10px] font-medium text-slate-500">JPYC</span>
          </span>
          {!isSoldOut &&
            (hasOptions ? (
              // オプション有り: タップで選択モーダル → カートへ。既に追加済の点数を併記。
              <button
                type="button"
                onClick={() => onOpenOptions(item)}
                className="shrink-0 rounded-full border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-[var(--mo-accent-text)] hover:text-[var(--mo-accent-text)]"
              >
                {t('viewChooseOptions')}
                {optionCount > 0 ? ` (${optionCount})` : ''}
              </button>
            ) : n === 0 ? (
              // 未追加: 単一の ＋ (アプリ風の "追加" アフォーダンス)。タップで数量 1。
              <button
                type="button"
                onClick={() => onQtyChange(item.id, 1)}
                aria-label={t('qtyIncrease')}
                className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--mo-accent)] text-lg leading-none text-[var(--mo-accent-ink)] shadow-sm transition after:absolute after:-inset-1 after:content-[''] hover:brightness-95 active:scale-90"
              >
                ＋
              </button>
            ) : (
              // 追加後: − n + のピル型ステッパ。
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 p-0.5">
                <button
                  type="button"
                  onClick={() => onQtyChange(item.id, n - 1)}
                  aria-label={t('qtyDecrease')}
                  className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm transition after:absolute after:-inset-1 after:content-[''] active:scale-90"
                >
                  −
                </button>
                <span className="w-5 text-center text-sm font-bold tabular-nums text-slate-900">{n}</span>
                <button
                  type="button"
                  onClick={() => onQtyChange(item.id, n + 1)}
                  aria-label={t('qtyIncrease')}
                  className="relative flex h-9 w-9 items-center justify-center rounded-full bg-[var(--mo-accent)] text-[var(--mo-accent-ink)] shadow-sm transition after:absolute after:-inset-1 after:content-[''] hover:brightness-95 active:scale-90"
                >
                  ＋
                </button>
              </span>
            ))}
        </div>
      </div>
    </li>
  );
}

// props はすべて item の派生プリミティブ + 安定コールバックなので、既定の浅い比較で十分
// (変化していない品はスキップされる)。
export const MenuItemCard = memo(MenuItemCardImpl);
