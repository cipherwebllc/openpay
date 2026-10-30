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
