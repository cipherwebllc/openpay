// サインイン中の wallet が持つ @handle の一覧 (GET /api/handle・SIWE 必須)。
// queryKey `['handle-mine', sessionAddress]` と返り値の形 `{handles, max}` を、HandleClaimPanel・
// StorefrontPublishPanel・OrderFeedPanel・RegisterMode・トップの「あなたの OpenPay」が共有する (同じ endpoint・同じ cache)。
// 以前は各画面が自前の fetcher を持ち、形がずれると先に cache を埋めた側と食い違って handles.find が落ちた
// (実際に起きたクラッシュ)。取得と形はここだけで決める。
// 型だけを import する: '@/lib/handle' の実行時コードはトップ (「あなたの OpenPay」) の bundle を重くする
// (MAX_HANDLES_PER_WALLET を読んだだけで /[locale] が +35 kB になった・2026-09-28 実測)。
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';
import type { StorefrontParts } from '@/lib/mobileOrder';

export type OwnedHandle = {
  handle: string;
  config: HandleTipConfig;
  profile?: HandleProfile;
  storefront?: StorefrontParts;
  updatedAt?: number;
};
// max は API が常に返す (app/api/handle/route.ts)。欠けたら未定義のまま渡し、使う側の既定 (HandleClaimPanel は上限) に任せる。
export type MineResponse = { handles: OwnedHandle[]; max?: number };

/** 保存・解除の後に全 wallet 分をまとめて invalidate する接頭辞。 */
export const MY_HANDLES_ROOT_KEY = ['handle-mine'] as const;

/** wallet 切替で前 wallet の cache を流用しないよう、セッションのアドレスでスコープする。 */
export const myHandlesQueryKey = (sessionAddress: string | null) => [...MY_HANDLES_ROOT_KEY, sessionAddress] as const;

export async function fetchMyHandles(): Promise<MineResponse> {
  const res = await fetch('/api/handle');
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // KV 障害 (502 等) を「handle 0 件」と偽装しない (呼び出し側は isError でエラー表示・再試行)。
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${res.status}`);
  const handles = Array.isArray(json.handles)
    ? (json.handles as unknown[]).filter(
        (h): h is OwnedHandle =>
          !!h && typeof h === 'object' && typeof (h as OwnedHandle).handle === 'string' && !!(h as OwnedHandle).config,
      )
    : [];
  return { handles, max: typeof json.max === 'number' ? json.max : undefined };
}
