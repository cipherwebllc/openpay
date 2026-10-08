import { chainForSlug, type ChainSlug } from '@/lib/chains';
import { ChainLogo } from './AssetLogo';

interface ChainChooserProps {
  slugs: readonly ChainSlug[];
  selected: ChainSlug;
  onSelect: (slug: ChainSlug) => void;
  /** Tailwind grid utility class for the container. Default = 2 col mobile / 3 col sm+. */
  gridClassName?: string;
  /** chain id の行を出すか (既定 true)。店の会計画面 (お店の設定) では出さない (開発者向けの値・2026-10 磨き上げ P2)。 */
  showId?: boolean;
}

/**
 * Chain 選択ボタン grid (logo + chain 名 + chain id)。
 * QR / Tip / Checkout の 3 箇所を共通化したコンポーネント。
 * Field の label + i18n は呼び出し側の責務 (label が場所により異なるため)。
 */
export function ChainChooser({
  slugs,
  selected,
  onSelect,
  gridClassName = 'grid grid-cols-2 gap-2 sm:grid-cols-3',
  showId = true,
}: ChainChooserProps) {
  return (
    <div className={gridClassName}>
      {slugs.map((slug) => {
        const c = chainForSlug(slug);
        const active = selected === slug;
        return (
          <button
            key={slug}
            type="button"
            onClick={() => onSelect(slug)}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition-all duration-200 ${
              active
                ? 'border-brand bg-brand/5 text-brand-dark ring-2 ring-brand/15'
                : 'border-slate-200 bg-white text-slate-600 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-card'
            }`}
          >
            <ChainLogo slug={slug} size={20} className="h-5 w-5 shrink-0" />
            <div className="min-w-0">
              <div className="truncate font-semibold">{c.name}</div>
              {showId && <div className="text-xs text-slate-500">id: {c.id}</div>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
