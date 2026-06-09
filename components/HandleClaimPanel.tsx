'use client';

// @handle 恒久リンクの取得 UI (dashboard)。NEXT_PUBLIC_ENABLE_HANDLES OFF では何も描画しない。
// SIWE サインイン → handle 入力 + 空き確認 → 現在のチップ設定を publish → /@handle リンク
// (コピー / QR) を提示。取得済み handle の一覧 + 解放も扱う。設定は親 (TipEmbedGenerator) から
// PublishableTipConfig として受け取る (受取先未設定なら config=null)。

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { validateHandle, type PublishableTipConfig } from '@/lib/handle';

type Availability = { available: boolean; reason?: string };
type MineResponse = { handles: string[]; max: number };

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export function HandleClaimPanel({
  config,
}: {
  config: PublishableTipConfig | null;
}) {
  const t = useTranslations('HandleClaim');
  const { isSignedIn, sessionAddress, signIn, isSigningIn, signInError } =
    useSiweSession();
  const origin = useOrigin();
  const linkCopy = useCopyToClipboard();
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');

  // env は build 時定数なので hook 後に early-return しても hook 数は不変。
  const validation = useMemo(() => validateHandle(input), [input]);
  const normalized = validation.ok ? validation.handle : '';

  // 入力の debounce (空き確認の過剰リクエスト抑制)。
  useEffect(() => {
    const id = setTimeout(() => setDebounced(normalized), 350);
    return () => clearTimeout(id);
  }, [normalized]);

  const availability = useQuery({
    queryKey: ['handle-availability', debounced],
    enabled: env.enableHandles && isSignedIn && debounced.length > 0,
    queryFn: async (): Promise<Availability> => {
      const { json } = await fetchJson(`/api/handle/${debounced}`);
      return {
        available: json.available === true,
        reason: typeof json.reason === 'string' ? json.reason : undefined,
      };
    },
  });

  const mine = useQuery({
    // wallet 切替で前 wallet の cache を流用しないよう session address でスコープする。
    queryKey: ['handle-mine', sessionAddress],
    enabled: env.enableHandles && isSignedIn,
    queryFn: async (): Promise<MineResponse> => {
      const { json } = await fetchJson('/api/handle');
      return {
        handles: Array.isArray(json.handles)
          ? (json.handles as string[])
          : [],
        max: typeof json.max === 'number' ? json.max : 3,
      };
    },
  });

  const publish = useMutation({
    mutationFn: async (handle: string) => {
      const { ok, status, json } = await fetchJson('/api/handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, config }),
      });
      if (!ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${status}`);
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['handle-mine'] });
      qc.invalidateQueries({ queryKey: ['handle-availability'] });
      setInput('');
    },
  });

  const release = useMutation({
    mutationFn: async (handle: string) => {
      const { ok, status, json } = await fetchJson(`/api/handle/${handle}`, {
        method: 'DELETE',
      });
      if (!ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${status}`);
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['handle-mine'] }),
  });

  if (!env.enableHandles) return null;

  const max = mine.data?.max ?? 3;
  const owned = mine.data?.handles ?? [];
  const atLimit = owned.length >= max;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-800">{t('title')}</h3>
      <p className="mt-1 text-xs text-slate-500">{t('description')}</p>

      {!config ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {t('needReceiver')}
        </p>
      ) : !isSignedIn ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void signIn(t('signInStatement')).catch(() => {})}
            disabled={isSigningIn}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {isSigningIn ? t('signingIn') : t('signInButton')}
          </button>
          {signInError && (
            <p className="mt-2 text-xs text-red-600">{t('signInError')}</p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {/* 取得フォーム */}
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-slate-400">{origin || 'open-pay.jp'}/@</span>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t('handlePlaceholder')}
                maxLength={30}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
              />
            </div>
            <p className="mt-1 text-xs text-slate-400">{t('formatHint')}</p>
            {/* 入力検証 + 空き状態 */}
            {input.length > 0 && !validation.ok && (
              <p className="mt-1 text-xs text-red-600">
                {validation.reason === 'reserved' ? t('reservedWord') : t('invalidFormat')}
              </p>
            )}
            {/* 自分が既に所有する handle は「使用済み」を出さない (更新フロー)。 */}
            {validation.ok &&
              debounced === normalized &&
              !owned.includes(normalized) && (
                <p className="mt-1 text-xs">
                  {availability.isFetching ? (
                    <span className="text-slate-400">{t('checking')}</span>
                  ) : availability.data?.available ? (
                    <span className="text-emerald-600">{t('available')}</span>
                  ) : availability.data ? (
                    <span className="text-red-600">{t('taken')}</span>
                  ) : null}
                </p>
              )}
          </div>

          <button
            type="button"
            onClick={() => normalized && publish.mutate(normalized)}
            disabled={
              !validation.ok ||
              publish.isPending ||
              // 他人が使用中なら不可。自分が所有する handle の更新は許可する。
              (availability.data?.available === false &&
                !owned.includes(normalized)) ||
              (atLimit && !owned.includes(normalized))
            }
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            {publish.isPending
              ? t('claiming')
              : owned.includes(normalized)
                ? t('updateButton')
                : t('claimButton')}
          </button>
          {atLimit && (
            <p className="text-xs text-amber-700">{t('limitReached', { max })}</p>
          )}
          {publish.isError && (
            <p className="text-xs text-red-600">
              {t('claimError', { error: (publish.error as Error).message })}
            </p>
          )}

          {/* 取得済み handle 一覧 */}
          {owned.length > 0 && (
            <div className="border-t border-slate-100 pt-3">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t('yourHandles', { count: owned.length, max })}
              </h4>
              <ul className="space-y-3">
                {owned.map((h) => {
                  const link = origin ? `${origin}/@${h}` : `/@${h}`;
                  return (
                    <li key={h} className="rounded-lg bg-slate-50 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="break-all font-mono text-xs text-slate-700">
                          {link}
                        </span>
                        <div className="flex flex-none gap-1.5">
                          <button
                            type="button"
                            onClick={() => linkCopy.copy(link)}
                            className="rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700"
                          >
                            {linkCopy.copied ? t('copied') : t('copy')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm(t('releaseConfirm', { handle: h }))) {
                                release.mutate(h);
                              }
                            }}
                            disabled={release.isPending}
                            className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:border-red-300 hover:text-red-600 disabled:opacity-40"
                          >
                            {t('release')}
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex justify-center rounded-md border border-slate-200 bg-white p-2">
                        <QRCodeSVG value={link} size={120} includeMargin level="M" />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
