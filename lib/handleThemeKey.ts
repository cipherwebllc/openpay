// handle/profile/tip URL が共有するテーマ識別子だけの軽量モジュール。
// UI トークン (handleTheme.ts) を URL parser 経由で /pay bundle に引き込まないため分離する。
export const HANDLE_THEMES = [
  'clean',
  'gradient',
  'bold',
  'outline',
  'night',
  'soft',
] as const;

export type HandleTheme = (typeof HANDLE_THEMES)[number];

const THEME_SET: ReadonlySet<string> = new Set<string>(HANDLE_THEMES);

export function isHandleTheme(value: unknown): value is HandleTheme {
  return typeof value === 'string' && THEME_SET.has(value);
}
