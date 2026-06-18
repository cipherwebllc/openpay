'use client';

// 店舗のライブ運用 (売り切れ / 受付一時停止) を店主が操作するパネル。公開済み @handle に紐づく。
// /api/shop/live を GET (現在状態) + PATCH (単一操作) する。SIWE は cookie セッション (publish 済前提)。
// 親 (StorefrontPublishPanel) が env.enableShopLive + 公開済みのときだけマウントする。

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MenuItem } from '@/lib/mobileOrder';
import type { ShopLiveState, ShopLivePatch } from '@/lib/shopLive';

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

export function ShopLivePanel({
  handle,
  menu,
  hideHeading,
}: {
  handle: string;
  menu: MenuItem[];
  /** 親 (受注の details 等) が見出しを担うとき内部 h4 を省く (重複回避)。 */
  hideHeading?: boolean;
}) {
  const t = useTranslations('ShopLive');
  const qc = useQueryClient();

  const live = useQuery({
    queryKey: ['shop-live', handle],
    enabled: handle.length > 0,
    queryFn: async (): Promise<ShopLiveState> => {
      const { ok, json } = await fetchJson(`/api/shop/live?h=${encodeURIComponent(handle)}`);
      if (!ok || !json.live) throw new Error('load_failed');
      return json.live as ShopLiveState;
    },
  });

  const patch = useMutation({
    mutationFn: async (body: ShopLivePatch): Promise<ShopLiveState> => {
      const { ok, json } = await fetchJson(`/api/shop/live?h=${encodeURIComponent(handle)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!ok || !json.live) throw new Error('patch_failed');
      return json.live as ShopLiveState;
    },
    // サーバが返す確定状態で cache を更新 (CAS 後の正本)。
    onSuccess: (state) => qc.setQueryData(['shop-live', handle], state),
  });

  const state = live.data;
  const soldOut = new Set(state?.soldOut ?? []);
  const paused = state?.paused ?? false;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      {!hideHeading && <h4 className="text-xs font-semibold text-slate-700">{t('heading')}</h4>}
      <p className="mt-0.5 text-[11px] text-slate-500">{t('intro')}</p>
      {live.isLoading ? (
        <p className="mt-2 text-xs text-slate-400">{t('loading')}</p>
      ) : live.isError ? (
        <p className="mt-2 text-xs text-red-600">{t('loadError')}</p>
      ) : (
        <div className="mt-2 space-y-3">
          {/* 受付一時停止トグル (頼まれすぎ防止 — 公開ページの決済導線を止める) */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700">
              {paused ? t('pausedOn') : t('pausedOff')}
            </span>
            <button
              type="button"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ op: 'paused', value: !paused })}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
                paused ? 'bg-amber-500 text-white' : 'bg-slate-200 text-slate-700'
              }`}
            >
              {paused ? t('resume') : t('pause')}
            </button>
          </div>

          {/* 売り切れトグル (公開メニュー各品)。顧客メニューで非活性表示になる。 */}
          {menu.length > 0 && (
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-700">{t('soldOutHeading')}</span>
                {soldOut.size > 0 && (
                  <button
                    type="button"
                    disabled={patch.isPending}
                    onClick={() => patch.mutate({ op: 'clearSoldOut' })}
                    className="text-[11px] font-medium text-brand hover:underline disabled:opacity-50"
                  >
                    {t('clearSoldOut')}
                  </button>
                )}
              </div>
              <ul className="mt-1 space-y-1">
                {menu.map((m) => {
                  const out = soldOut.has(m.id);
                  return (
                    <li key={m.id} className="flex items-center justify-between gap-2">
                      <span
                        className={`min-w-0 flex-1 truncate text-xs ${
                          out ? 'text-slate-400 line-through' : 'text-slate-700'
                        }`}
                      >
                        {m.name}
                      </span>
                      <button
                        type="button"
                        disabled={patch.isPending}
                        onClick={() => patch.mutate({ op: 'soldOut', itemId: m.id, value: !out })}
                        aria-pressed={out}
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50 ${
                          out
                            ? 'border-red-300 bg-red-50 text-red-600'
                            : 'border-slate-300 text-slate-600 hover:border-brand'
                        }`}
                      >
                        {out ? t('markAvailable') : t('markSoldOut')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {patch.isError && <p className="text-xs text-red-600">{t('patchError')}</p>}
        </div>
      )}
    </div>
  );
}
