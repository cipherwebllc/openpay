// 対応 locale。新規追加する時はここと middleware.ts と messages/ を同時更新。
export const LOCALES = ['ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ja';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
