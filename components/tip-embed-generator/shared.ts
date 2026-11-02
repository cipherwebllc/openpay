// TipEmbedGenerator とその節の component が共有する型と定数。設定 (useTipSettings) の持ち主は親の
// TipEmbedGenerator で、節は settings と setSettings を props で受け取る。

import type { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import type { useTipSettings } from '@/hooks/useTipSettings';

export type TipSettings = ReturnType<typeof useTipSettings>['settings'];
export type SetTipSettings = ReturnType<typeof useTipSettings>['setSettings'];
export type CopyState = ReturnType<typeof useCopyToClipboard>;

export type PublishMode = 'share' | 'embed';
export type EmbedFormat = 'iframe' | 'button';

// color 入力が不正 (COLOR_PATTERN 不一致) のときのプレビュー/プレースホルダ既定色。
export const DEFAULT_PREVIEW_COLOR = '#2563eb';

// 入力欄の見た目 (受取欄の AddressInput と同じ基準)。スマホは 16px (16px 未満だと iOS が入力時に画面を拡大する)、
// 高さ 44px で押しやすく、placeholder は白地で AA (slate-500 ≈ 4.8:1・既定の灰色は 2.5:1)。
export const TIP_INPUT_CLASS =
  'h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm';
export const TIP_TEXTAREA_CLASS =
  'w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-base placeholder:text-slate-500 focus:border-brand focus:outline-none sm:text-sm';
