const CATEGORY_COLOR_PALETTE = [
  { border: 'border-l-emerald-400', dot: 'bg-emerald-400' },
  { border: 'border-l-sky-400', dot: 'bg-sky-400' },
  { border: 'border-l-violet-400', dot: 'bg-violet-400' },
  { border: 'border-l-amber-400', dot: 'bg-amber-400' },
  { border: 'border-l-rose-400', dot: 'bg-rose-400' },
  { border: 'border-l-cyan-400', dot: 'bg-cyan-400' },
  { border: 'border-l-fuchsia-400', dot: 'bg-fuchsia-400' },
  { border: 'border-l-lime-400', dot: 'bg-lime-400' },
] as const;

export type CategoryColorClasses = (typeof CATEGORY_COLOR_PALETTE)[number];

/** 同じカテゴリー名を、端末や描画順に依存しない固定色へ割り当てる。 */
export function categoryColorClasses(category: string): CategoryColorClasses {
  if (category.length === 0) return CATEGORY_COLOR_PALETTE[0];

  // FNV-1a (32-bit)。日本語を含む UTF-16 code unit 列を決定的に分散する。
  let hash = 0x811c9dc5;
  for (let i = 0; i < category.length; i += 1) {
    hash ^= category.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return CATEGORY_COLOR_PALETTE[(hash >>> 0) % CATEGORY_COLOR_PALETTE.length];
}
