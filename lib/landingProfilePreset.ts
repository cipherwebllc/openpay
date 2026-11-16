// トップの見本 (components/LandingProfileDemo.tsx) で選べる色と、見本で選んだテーマと色を作成画面 (プロフのタブ) へ
// 持って行く query の組み立てと読み取り (plans/lp-polish-2026-11.md P6)。トップと作成画面の両方が読むので軽く保つ:
// テーマは識別子だけの lib/handleThemeKey を使い、見た目のトークン (lib/handleTheme) は引き込まない。
// 色は名前 (blue など) で渡し、作成側はこの表で hex に戻す (許す値をこの 5 つに絞る)。

import { isHandleTheme, type HandleTheme } from '@/lib/handleThemeKey';

export const LANDING_ACCENTS = {
  blue: '#2563eb',
  green: '#059669',
  rose: '#e11d48',
  amber: '#d97706',
  violet: '#7c3aed',
} as const;
export type LandingAccentKey = keyof typeof LANDING_ACCENTS;
export const LANDING_ACCENT_KEYS = Object.keys(LANDING_ACCENTS) as LandingAccentKey[];

function isLandingAccentKey(value: string | null): value is LandingAccentKey {
  return value !== null && Object.hasOwn(LANDING_ACCENTS, value);
}

/** 見本で選んだテーマと色を、作成画面への href に付ける (値はどちらも決まった一覧の名前なので encode は要らない)。 */
export function withLandingLook(href: string, theme: HandleTheme, accent: LandingAccentKey): string {
  return `${href}${href.includes('?') ? '&' : '?'}theme=${theme}&color=${accent}`;
}

/** 作成画面に持って来た見た目 (正しい値だけ・色は hex)。 */
export type LandingLook = { theme?: HandleTheme; color?: string };

/**
 * URL の query から、見本で選んだテーマと色を読む。`theme` も `color` も無ければ null (URL を触らない)。
 * 値は許す一覧で確かめ、正しい方だけを返す (片方だけ正しいときは、その片方だけを入れる)。
 */
export function readLandingLook(search: string): LandingLook | null {
  const params = new URLSearchParams(search);
  if (!params.has('theme') && !params.has('color')) return null;
  const theme = params.get('theme');
  const color = params.get('color');
  return {
    ...(isHandleTheme(theme) ? { theme } : {}),
    ...(isLandingAccentKey(color) ? { color: LANDING_ACCENTS[color] } : {}),
  };
}

/** URL (path + query + hash) から `theme` と `color` だけを消す。ほかの query (tab) と hash は残す。 */
export function withoutLandingLook(pathname: string, search: string, hash: string): string {
  const params = new URLSearchParams(search);
  params.delete('theme');
  params.delete('color');
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}
