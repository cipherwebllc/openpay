// @handle プロフィール (link-in-bio) のテーマプリセット。純関数のみ (KV/React 非依存) で、
// 公開ページ (app/[locale]/[handle]/page.tsx = server) とプレビュー描画 (HandleProfile.tsx =
// client)・ビルダー (HandleProfileBuilder.tsx) が同一トークンを共有する単一情報源。
//
// 設計原則:
//   - clean = 既定 = **現行の見た目と完全一致** (テーマ導入前のレコードは theme 無し → clean)。
//     そのため clean は「トークン無し (undefined)」を返し、呼び出し側は既存の className を
//     一切変えずに描画する (= ピクセル一致を型で担保)。他テーマだけ inline style で上書きする。
//   - 未知/不正な theme 値は clean に落とす (エラーにしない・破損レコードでも tip を落とさない)。
//   - アクセント色 (config.color = `#rrggbb`) と 6 テーマは自由に組合せ可。alpha は 8 桁 hex 付与。

import type { CSSProperties } from 'react';
import {
  HANDLE_THEMES,
  isHandleTheme,
  type HandleTheme,
} from '@/lib/handleThemeKey';

export { HANDLE_THEMES, isHandleTheme };
export type { HandleTheme };

// テーマ名はプロフ / Tip 生成の両ピッカーで共有する固有名詞 (翻訳しない)。
export const HANDLE_THEME_NAMES: Record<HandleTheme, string> = {
  clean: 'Clean',
  gradient: 'Gradient',
  bold: 'Bold',
  outline: 'Outline',
  night: 'Night',
  soft: 'Soft',
};

// 保存値/クエリ由来の任意値を安全な HandleTheme へ。未知は clean (既定)。
export function resolveHandleTheme(v: unknown): HandleTheme {
  return isHandleTheme(v) ? v : 'clean';
}

// ── 公開ページ / プレビュー描画 (HandleProfileView) のトークン ──────────────────
export interface HandleViewTheme {
  theme: HandleTheme;
  // ダーク基調 (night)。フッター/SNS の可読色切替に使う。
  dark: boolean;
  // アバターのリング (boxShadow)。
  avatarRing: string;
  // 表示名の色。undefined = 既存 className (text-slate-900) を維持 (clean のピクセル一致)。
  inkColor?: string;
  // bio の色。undefined = 既存 className (text-slate-600) を維持 (clean)。
  bioColor?: string;
  // @handle の色 (通常はアクセント。night のみ可読性のため淡いブルー)。
  handleColor: string;
  // 通常リンクの inline style。undefined = 既存 className のみで描画 (clean)。
  linkStyle?: CSSProperties;
  // 注目 (featured) リンクの inline style。全テーマで inline (clean も featured は新機能)。
  featuredStyle: CSSProperties;
  // SNS アイコン行の配色 variant (night のみ dark)。
  socialVariant: 'default' | 'dark';
}

// clean のアバターリングは**現行値**を維持 (mock の近似値ではなく現行 component と一致させる)。
const CLEAN_AVATAR_RING = (accent: string) =>
  `0 0 0 4px #ffffff, 0 0 0 6px ${accent}33, 0 16px 36px -12px ${accent}59`;

export function handleViewTheme(
  accent: string,
  theme: HandleTheme,
): HandleViewTheme {
  switch (theme) {
    case 'gradient':
      return {
        theme,
        dark: false,
        avatarRing: `0 0 0 4px #ffffff, 0 0 0 6px ${accent}44, 0 16px 34px -10px ${accent}66`,
        inkColor: '#0f172a',
        bioColor: '#3f4c66',
        handleColor: accent,
        linkStyle: {
          backgroundColor: '#ffffff',
          color: '#1e293b',
          boxShadow: `0 3px 10px -3px ${accent}40`,
        },
        featuredStyle: {
          backgroundColor: '#ffffff',
          color: '#1e293b',
          outline: `2px solid ${accent}`,
          boxShadow: `0 10px 24px -8px ${accent}59`,
        },
        socialVariant: 'default',
      };
    case 'bold':
      return {
        theme,
        dark: false,
        avatarRing: `0 0 0 4px #ffffff, 0 0 0 6px ${accent}40, 0 14px 30px -10px ${accent}59`,
        inkColor: '#0f172a',
        bioColor: '#475569',
        handleColor: accent,
        linkStyle: {
          backgroundColor: accent,
          color: '#ffffff',
          boxShadow: `0 4px 12px -4px ${accent}73`,
        },
        featuredStyle: {
          backgroundColor: accent,
          color: '#ffffff',
          outline: `3px solid ${accent}40`,
          boxShadow: `0 12px 26px -8px ${accent}99`,
        },
        socialVariant: 'default',
      };
    case 'outline':
      return {
        theme,
        dark: false,
        avatarRing: `0 0 0 3px #ffffff, 0 0 0 5px ${accent}`,
        inkColor: '#0f172a',
        bioColor: '#475569',
        handleColor: accent,
        linkStyle: {
          backgroundColor: 'transparent',
          color: accent,
          boxShadow: `inset 0 0 0 1.5px ${accent}`,
        },
        featuredStyle: {
          backgroundColor: `${accent}0d`,
          color: accent,
          boxShadow: `inset 0 0 0 2px ${accent}`,
        },
        socialVariant: 'default',
      };
    case 'night':
      return {
        theme,
        dark: true,
        avatarRing: `0 0 0 4px #0f172a, 0 0 0 6px ${accent}, 0 18px 40px -8px ${accent}bb`,
        inkColor: '#f8fafc',
        bioColor: '#cbd5e1',
        handleColor: '#93c5fd',
        linkStyle: {
          backgroundColor: 'rgba(255,255,255,0.08)',
          color: '#f1f5f9',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)',
        },
        featuredStyle: {
          backgroundColor: 'rgba(255,255,255,0.13)',
          color: '#ffffff',
          boxShadow: `inset 0 0 0 1.5px #93c5fd88, 0 10px 28px -8px ${accent}aa`,
        },
        socialVariant: 'dark',
      };
    case 'soft':
      return {
        theme,
        dark: false,
        avatarRing: `0 0 0 5px #ffffff, 0 12px 30px -10px ${accent}4d`,
        inkColor: '#1e293b',
        bioColor: '#5b6b84',
        handleColor: accent,
        linkStyle: {
          backgroundColor: '#ffffff',
          color: '#334155',
          borderRadius: '22px',
          boxShadow: 'none',
        },
        featuredStyle: {
          backgroundColor: '#ffffff',
          color: accent,
          borderRadius: '24px',
          outline: `2px solid ${accent}2e`,
          boxShadow: `0 10px 24px -10px ${accent}59`,
        },
        socialVariant: 'default',
      };
    case 'clean':
    default:
      return {
        theme: 'clean',
        dark: false,
        avatarRing: CLEAN_AVATAR_RING(accent),
        // inkColor / bioColor / linkStyle は undefined = 現行 className を維持 (ピクセル一致)。
        handleColor: accent,
        // clean でも featured は新機能なので inline style (現行レコードは featured 無し)。
        featuredStyle: {
          backgroundColor: '#ffffff',
          color: '#1e293b',
          outline: `2px solid ${accent}`,
          boxShadow: `0 8px 22px -8px ${accent}66`,
        },
        socialVariant: 'default',
      };
  }
}

// ── 公開ページの背景ウォッシュ (page.tsx の fixed div) ──────────────────────────
export interface HandlePageTheme {
  dark: boolean;
  // ウォッシュが全画面を覆うか (inset-0)。clean は現行どおり上部 h-96 の淡いウォッシュのみ。
  full: boolean;
  // ウォッシュ div の CSS background。
  background: string;
}

export function handlePageTheme(
  accent: string,
  theme: HandleTheme,
): HandlePageTheme {
  switch (theme) {
    case 'gradient':
      return {
        dark: false,
        full: true,
        background: `linear-gradient(180deg, ${accent}33 0%, ${accent}0d 46%, rgba(255,255,255,0) 76%), #ffffff`,
      };
    case 'bold':
      return { dark: false, full: true, background: '#ffffff' };
    case 'outline':
      return { dark: false, full: true, background: '#fcfdff' };
    case 'night':
      return {
        dark: true,
        full: true,
        background: `radial-gradient(90% 55% at 50% -6%, ${accent}52 0%, rgba(15,23,42,0) 55%), #0f172a`,
      };
    case 'soft':
      return { dark: false, full: true, background: '#eef4fe' };
    case 'clean':
    default:
      return {
        dark: false,
        full: false,
        // 現行と完全一致 (page.tsx の従来ウォッシュ)。
        background: `radial-gradient(125% 70% at 50% 0%, ${accent}29 0%, ${accent}0d 32%, transparent 68%)`,
      };
  }
}

// 背景プレビュー / TipForm のテーマトークンは /tip がプロフィール表示用の大きな
// module 全体を初回読込しないよう分離。既存 import の互換性は re-export で保つ。
export {
  handlePreviewBackground,
  tipFormTheme,
} from '@/lib/tipFormTheme';
export type { TipFormTheme } from '@/lib/tipFormTheme';
