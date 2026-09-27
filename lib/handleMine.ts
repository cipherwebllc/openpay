// サインイン中の wallet が持つ @handle の一覧 (GET /api/handle・SIWE 必須)。
// ⚠️ queryKey `['handle-mine', sessionAddress]` と返り値の形 `{handles, max}` は HandleClaimPanel・
// StorefrontPublishPanel・OrderFeedPanel と共有する (同じ endpoint・同じ cache)。形を変えると、先に cache を埋めた
// 側と食い違って handles.find が落ちる (実際に起きたクラッシュ)。3 つの panel はまだ各自の fetcher を持つので、
// 形を変えるときは全部そろえる。
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';

export type OwnedHandle = {
  handle: string;
  config: HandleTipConfig;
  profile?: HandleProfile;
  storefront?: unknown;
  updatedAt?: number;
};
export type MineResponse = { handles: OwnedHandle[]; max: number };

export const myHandlesQueryKey = (sessionAddress: string | null) => ['handle-mine', sessionAddress] as const;

export async function fetchMyHandles(): Promise<MineResponse> {
  const res = await fetch('/api/handle');
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // KV 障害 (502 等) を「handle 0 件」と偽装しない (呼び出し側は isError で扱う)。
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${res.status}`);
  const list = Array.isArray(json.handles)
    ? (json.handles as unknown[]).filter(
        (h): h is OwnedHandle =>
          !!h && typeof h === 'object' && typeof (h as OwnedHandle).handle === 'string' && !!(h as OwnedHandle).config,
      )
    : [];
  return { handles: list, max: typeof json.max === 'number' ? json.max : list.length };
}
