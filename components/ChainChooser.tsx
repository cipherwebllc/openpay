import { chainForSlug, type ChainSlug } from '@/lib/chains';
import { ChainLogo } from './AssetLogo';

interface ChainChooserProps {
  slugs: readonly ChainSlug[];
  selected: ChainSlug;
  onSelect: (slug: ChainSlug) => void;
  /** Tailwind grid utility class for the container. Default = 2 col mobile / 3 col sm+. */
  gridClassName?: string;
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
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition ${
              active
                ? 'border-brand bg-brand/5 text-brand-dark'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
            }`}
          >
            <ChainLogo slug={slug} size={20} className="h-5 w-5 shrink-0" />
            <div className="min-w-0">
              <div className="truncate font-semibold">{c.name}</div>
              <div className="text-xs text-slate-500">id: {c.id}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
