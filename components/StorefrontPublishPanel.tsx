'use client';

// モバイルオーダーのメニューを @handle に公開し、open-pay.jp/@handle を固定店舗 URL にする。
// 店舗固有部分 (chain/mode/feePayer/menu) のみ送り、identity (受取先/店名/アイコン/SNS) は
// @handle プロフィールの設定が使われる (lib/handle.handleStorefrontConfig が合成)。SIWE 必須・
// 所有者のみ (既存 /api/handle を流用)。NEXT_PUBLIC_ENABLE_HANDLES OFF では何も描画しない。
//
// react-query を使うため、親 (MobileOrderBuilder) は env.enableHandles でこのパネルの**マウント自体**
// をゲートする (handles OFF の単体テストで QueryClient を要求しないため)。

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import type { HandleTipConfig } from '@/lib/handle';
import type { StorefrontParts } from '@/lib/mobileOrder';

// GET /api/handle が返す所有 handle (storefront 公開済みかの判定に storefront も読む)。
type OwnedHandle = {
  handle: string;
  config: HandleTipConfig;
  storefront?: StorefrontParts;
};

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export function StorefrontPublishPanel({
  storefront,
  onGetHandle,
}: {
  /** 公開する店舗固有部分。メニュー未充足など公開不可なら null (公開ボタンを無効化)。 */
  storefront: StorefrontParts | null;
  /** 「@handle を取得」導線 (create が profile タブへ切替)。 */
  onGetHandle?: () => void;
}) {
  const t = useTranslations('MobileOrder');
  const { isSignedIn, sessionAddress, signIn, isSigningIn, signInError } = useSiweSession();
  const origin = useOrigin();
  const linkCopy = useCopyToClipboard();
  const qc = useQueryClient();
  const [selected, setSelected] = useState('');

  const mine = useQuery({
    // wallet 切替で前 wallet の cache を流用しないよう session address でスコープ (HandleClaim と同流儀)。
    queryKey: ['handle-mine', sessionAddress],
    enabled: env.enableHandles && isSignedIn,
    queryFn: async (): Promise<OwnedHandle[]> => {
      const { ok, status, json } = await fetchJson('/api/handle');
      // KV 障害 (502 等) を「handle 0 件」と偽装しない (isError でエラー表示 + 再試行)。
      if (!ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${status}`);
      return Array.isArray(json.handles)
        ? (json.handles as unknown[]).filter(
            (h): h is OwnedHandle =>
              !!h &&
              typeof h === 'object' &&
              typeof (h as OwnedHandle).handle === 'string' &&
              !!(h as OwnedHandle).config,
          )
        : [];
    },
  });

  const handles = useMemo(() => mine.data ?? [], [mine.data]);
  // 公開先を **派生** で決める (useEffect の 1 レンダ遅延を避け、初回描画で確定させる):
  // ユーザが選択済みでそれが一覧に在ればそれ、無ければ「店舗公開済み handle → 先頭」を既定に。
  const effectiveSelected =
    selected && handles.some((hh) => hh.handle === selected)
      ? selected
      : (handles.find((hh) => hh.storefront)?.handle ?? handles[0]?.handle ?? '');
  const selectedHandle = handles.find((hh) => hh.handle === effectiveSelected) ?? null;

  const publish = useMutation({
    mutationFn: async () => {
      if (!selectedHandle || !storefront) throw new Error('not_ready');
      // config は GET 由来の既存値をそのまま再送 (API は config 必須・round-trip で再検証される)。
      // identity は handle 側を使うため storefront には載せない。
      const { ok, status, json } = await fetchJson('/api/handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: selectedHandle.handle,
          config: selectedHandle.config,
          storefront,
        }),
      });
      if (!ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${status}`);
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['handle-mine'] });
    },
  });

  if (!env.enableHandles) return null;

  const shopUrl = origin && effectiveSelected ? `${origin}/@${effectiveSelected}` : '';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-800">{t('publishHeading')}</h3>
      <p className="mt-1 text-xs text-slate-500">{t('publishIntro')}</p>

      {!isSignedIn ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void signIn(t('publishSignInStatement')).catch(() => {})}
            disabled={isSigningIn}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {isSigningIn ? t('publishSigningIn') : t('publishSignIn')}
          </button>
          {signInError && <p className="mt-2 text-xs text-red-600">{t('publishSignInError')}</p>}
        </div>
      ) : mine.isLoading ? (
        <p className="mt-3 text-xs text-slate-400">{t('publishLoading')}</p>
      ) : mine.isError ? (
        <p className="mt-3 text-xs text-red-600">{t('publishLoadError')}</p>
      ) : handles.length === 0 ? (
        <div className="mt-3 text-xs text-slate-600">
          <p>{t('publishNoHandle')}</p>
          {onGetHandle && (
            <button
              type="button"
              onClick={onGetHandle}
              className="mt-1 font-medium text-brand hover:underline"
            >
              {t('publishGetHandle')}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {handles.length > 1 ? (
            <label className="block text-xs text-slate-600">
              {t('publishSelectHandle')}
              <select
                value={effectiveSelected}
                onChange={(e) => setSelected(e.target.value)}
                aria-label={t('publishSelectHandle')}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {handles.map((h) => (
                  <option key={h.handle} value={h.handle}>
                    @{h.handle}
                    {h.storefront ? ` ${t('publishAlready')}` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-xs text-slate-600">
              @{handles[0].handle}
              {selectedHandle?.storefront ? ` ${t('publishAlready')}` : ''}
            </p>
          )}

          <button
            type="button"
            disabled={!storefront || !selectedHandle || publish.isPending}
            onClick={() => publish.mutate()}
            className="w-full rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {publish.isPending
              ? t('publishing')
              : selectedHandle?.storefront
                ? t('publishUpdateButton')
                : t('publishButton')}
          </button>
          {!storefront && <p className="text-xs text-amber-700">{t('publishNeedMenu')}</p>}
          {publish.isError && <p className="text-xs text-red-600">{t('publishError')}</p>}
          {publish.isSuccess && shopUrl && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <p className="font-semibold">{t('published')}</p>
              <p className="mt-1 break-all">{shopUrl}</p>
              <div className="mt-1 flex gap-3">
                <button
                  type="button"
                  onClick={() => void linkCopy.copy(shopUrl)}
                  className="font-medium text-emerald-700 hover:underline"
                >
                  {linkCopy.copied ? t('copied') : t('copy')}
                </button>
                <a
                  href={shopUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-emerald-700 hover:underline"
                >
                  {t('openShop')}
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
