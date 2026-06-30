// /create のタブ deep-link 解決 (純関数・React/env 非依存ゆえ単体テスト可能)。
// ランディングのモバイルオーダーバナー等から `/create?tab=mobileOrder` で該当タブに直着するため、
// `?tab=` の生値を「表示中のタブ集合」に照らして安全に解決する。flag 付きタブ (mobileOrder /
// orders / profile) は対応 flag が ON のときだけ採用し、未知値・flag OFF・空は既定 'qr' に落とす。

export type CreateTab =
  | 'qr'
  | 'register'
  | 'tip'
  | 'profile'
  | 'mobileOrder'
  | 'orders';

// flag 付きタブの可視条件 (page.tsx のタブバー構築と同一の真偽)。
export type CreateTabFlags = {
  readonly mobileOrder: boolean; // env.enableMobileOrder
  readonly ordersFeed: boolean; // env.enableOrderRelay || env.enableShopLive
  readonly handles: boolean; // env.enableHandles
};

// flag に依存せず常設のタブ。
const ALWAYS_VISIBLE: ReadonlySet<string> = new Set(['qr', 'register', 'tip']);

/**
 * `?tab=` の生値を初期タブへ解決。常設タブは無条件採用、flag 付きタブは対応 flag ON のときだけ
 * 採用。未知・無効・flag OFF・空/未指定はすべて既定 'qr'。
 */
export function resolveCreateTab(
  rawTab: string | null | undefined,
  flags: CreateTabFlags,
): CreateTab {
  if (!rawTab) return 'qr';
  if (ALWAYS_VISIBLE.has(rawTab)) return rawTab as CreateTab;
  if (rawTab === 'mobileOrder' && flags.mobileOrder) return 'mobileOrder';
  if (rawTab === 'orders' && flags.ordersFeed) return 'orders';
  if (rawTab === 'profile' && flags.handles) return 'profile';
  return 'qr';
}
