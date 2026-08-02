import type { CSSProperties } from 'react';
import type { HandleTheme } from '@/lib/handleThemeKey';

// ビルダーのライブプレビューカードの背景。TipForm の gradient / night / soft
// トークンでも同じ背景を使うため、フォーム用テーマと同じ小さな module に置く。
export function handlePreviewBackground(
  accent: string,
  theme: HandleTheme,
): string | undefined {
  switch (theme) {
    case 'gradient':
      return `linear-gradient(180deg, ${accent}26, ${accent}0d 60%, #ffffff)`;
    case 'bold':
      return '#ffffff';
    case 'outline':
      return '#fcfdff';
    case 'night':
      return `radial-gradient(90% 60% at 50% 0%, ${accent}3d, rgba(15,23,42,0) 60%), #0f172a`;
    case 'soft':
      return '#eef4fe';
    case 'clean':
    default:
      return undefined;
  }
}

// TipForm のテーマトークン。theme 未指定時は呼び出し側がこの関数を呼ばず、
// 従来 class/style をそのまま使う。
export interface TipFormTheme {
  rootClassName: string;
  rootStyle?: CSSProperties;
  headerClassName: string;
  headerStyle: CSSProperties;
  amountClassName: string;
  // 地色をクラスで上書きするテーマ (night) 用。既存 bg-white とのクラス競合は stylesheet 順
  // 依存で不確実なため、確実に勝つ inline style で渡す。
  amountStyle?: CSSProperties;
  // 金額以外のカード (メッセージ / 明細 / ウォレット) 用。テーマを全カードへ波及させ
  // 「テーマはヘッダーと金額だけ・残りは白」のパッチワーク (特に night) を解消する
  // (2026-08-02 受取ページ磨き上げ P2)。文字色はカード内の既存クラスに勝つ必要が
  // あるため nested arbitrary variant で上書きする。
  sectionClassName: string;
  sectionStyle?: CSSProperties;
  inactivePillClassName: string;
  activePillStyle: CSSProperties;
  submitClassName: string;
  submitStyle: CSSProperties;
}

// ヘッダーの質感 (右上からの淡い光)。backgroundColor と独立した backgroundImage に
// 分けることで、アクセント色の適用 (backgroundColor) を検証する既存フェンスを壊さず
// 重ねられる。flat が美学の bold / 白地の outline には使わない。
export const HEADER_SHEEN =
  'radial-gradient(120% 150% at 100% 0%, rgba(255,255,255,0.18), rgba(255,255,255,0) 55%)';

function readableTextColor(hex: string): '#ffffff' | '#0f172a' {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return '#ffffff';
  const value = match[1];
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  // WCAG の相対輝度に近い重みで、明るいアクセント上は濃色文字へ切り替える。
  return red * 0.299 + green * 0.587 + blue * 0.114 > 160
    ? '#0f172a'
    : '#ffffff';
}

export function tipFormTheme(
  accent: string,
  theme: HandleTheme,
): TipFormTheme {
  const accentText = readableTextColor(accent);
  switch (theme) {
    case 'gradient':
      return {
        rootClassName: 'rounded-[1.75rem] bg-white p-3 ring-1 ring-slate-200/70',
        rootStyle: { background: handlePreviewBackground(accent, theme) },
        headerClassName: 'ring-1 ring-white/30',
        headerStyle: {
          background: `linear-gradient(135deg, ${accent} 0%, ${accent}cc 55%, #0f172a 150%)`,
          color: accentText,
        },
        amountClassName: 'border-white/80 bg-white/90 shadow-sm',
        sectionClassName: 'border-white/80 bg-white/90 shadow-sm',
        inactivePillClassName: 'bg-white/80 text-slate-700 hover:bg-white',
        activePillStyle: { backgroundColor: accent, color: accentText },
        submitClassName: 'ring-1 ring-white/30',
        submitStyle: { backgroundColor: accent, color: accentText },
      };
    case 'bold':
      return {
        rootClassName: 'rounded-[1.75rem] bg-white p-3 ring-4 ring-slate-900',
        headerClassName: 'rounded-xl shadow-[6px_6px_0_#0f172a]',
        headerStyle: { backgroundColor: accent, color: accentText },
        amountClassName: 'border-2 border-slate-900 shadow-[4px_4px_0_#0f172a]',
        sectionClassName: 'border-2 border-slate-900 shadow-[4px_4px_0_#0f172a]',
        inactivePillClassName: 'border-slate-900 bg-white text-slate-900',
        activePillStyle: { backgroundColor: accent, color: accentText },
        submitClassName: 'rounded-lg shadow-[5px_5px_0_#0f172a]',
        submitStyle: { backgroundColor: accent, color: accentText },
      };
    case 'outline':
      return {
        rootClassName: 'rounded-[1.75rem] bg-white p-3',
        rootStyle: { boxShadow: `inset 0 0 0 2px ${accent}` },
        headerClassName: 'shadow-none',
        headerStyle: {
          backgroundColor: '#ffffff',
          color: accent,
          boxShadow: `inset 0 0 0 2px ${accent}`,
        },
        amountClassName: 'bg-transparent shadow-none',
        sectionClassName: 'bg-transparent shadow-none',
        inactivePillClassName: 'bg-transparent text-slate-700',
        activePillStyle: {
          backgroundColor: `${accent}12`,
          color: accent,
          boxShadow: `inset 0 0 0 2px ${accent}`,
        },
        submitClassName: 'bg-white shadow-none',
        submitStyle: {
          backgroundColor: '#ffffff',
          color: accent,
          boxShadow: `inset 0 0 0 2px ${accent}`,
        },
      };
    case 'night':
      return {
        rootClassName: 'rounded-[1.75rem] bg-slate-950 p-3 text-slate-100',
        rootStyle: { background: handlePreviewBackground(accent, theme) },
        headerClassName: 'ring-1 ring-white/15',
        headerStyle: {
          background: `radial-gradient(100% 140% at 100% 0%, ${accent}66 0%, rgba(15,23,42,0) 58%), #0f172a`,
          color: '#f8fafc',
        },
        amountClassName:
          'border-white/15 [&>p]:text-slate-300 [&_label_span]:text-slate-300 [&_input]:text-slate-900',
        amountStyle: { backgroundColor: '#0f172a' },
        // 文字/罫線はカード内の既存クラス (Row の text-slate-*, border-slate-*) に
        // 後勝ちする必要があるため class 一致の nested variant で明示上書きする。
        sectionClassName:
          'border-white/15 [&_.text-slate-500]:text-slate-300 [&_.text-slate-700]:text-slate-200 [&_.text-slate-900]:text-slate-50 [&_.border-slate-200]:border-white/15 [&_.border-slate-300]:border-white/25 [&_textarea]:border-white/25 [&_textarea]:bg-slate-900 [&_textarea]:text-slate-100 [&_.bg-slate-100]:bg-slate-800 [&_button.bg-white]:border-white/25 [&_button.bg-white]:bg-slate-900',
        sectionStyle: { backgroundColor: '#0f172a' },
        inactivePillClassName:
          'border-white/15 bg-slate-950 text-slate-200 hover:border-white/30',
        activePillStyle: { backgroundColor: accent, color: accentText },
        submitClassName: 'ring-1 ring-white/20',
        submitStyle: { backgroundColor: accent, color: accentText },
      };
    case 'soft':
      return {
        rootClassName: 'rounded-[2rem] bg-slate-100 p-3',
        rootStyle: { background: handlePreviewBackground(accent, theme) },
        headerClassName: 'rounded-[1.5rem] shadow-none',
        headerStyle: {
          backgroundColor: accent,
          backgroundImage: HEADER_SHEEN,
          color: accentText,
        },
        amountClassName: 'rounded-[1.5rem] border-white bg-white/90 shadow-none',
        sectionClassName: 'rounded-[1.5rem] border-white bg-white/90 shadow-none',
        inactivePillClassName:
          'rounded-2xl border-transparent bg-slate-100 text-slate-700',
        activePillStyle: { backgroundColor: accent, color: accentText },
        submitClassName: 'rounded-2xl shadow-none',
        submitStyle: { backgroundColor: accent, color: accentText },
      };
    case 'clean':
    default:
      return {
        rootClassName: 'rounded-[1.75rem] bg-white p-3 ring-1 ring-slate-200/70',
        headerClassName: 'ring-1 ring-black/5',
        headerStyle: {
          backgroundColor: accent,
          backgroundImage: HEADER_SHEEN,
          color: accentText,
        },
        amountClassName: 'bg-white',
        sectionClassName: '',
        inactivePillClassName: 'bg-white text-slate-700',
        activePillStyle: { backgroundColor: accent, color: accentText },
        submitClassName: '',
        submitStyle: { backgroundColor: accent, color: accentText },
      };
  }
}
