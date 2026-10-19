// Store の普通の商品の「利用条件」(出品者が選ぶ表示専用メタ・購入 snapshot 非対象)。
// 利用ライセンス NFT 商品は専用の利用条件 (lib/license) を使うので、この欄は持たない。
// 選ばなかった項目は保存しない = 画面では「記載なし」(Terms 第 13 条 (6) の既定 = 私的利用・再配布不可)。

export const USAGE_PERMISSION_KEYS = ['commercial', 'modify', 'redistribute'] as const;
export type UsagePermissionKey = (typeof USAGE_PERMISSION_KEYS)[number];
export type UsagePermission = 'allowed' | 'not_allowed';

export type StoreUsageTerms = Partial<Record<UsagePermissionKey, UsagePermission>> & {
  /** 補足 (1 行・制御文字除去済み)。 */
  note?: string;
};

export const MAX_USAGE_NOTE_LEN = 200;

export function isUsagePermission(value: unknown): value is UsagePermission {
  return value === 'allowed' || value === 'not_allowed';
}
