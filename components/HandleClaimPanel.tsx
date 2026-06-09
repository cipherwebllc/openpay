'use client';

// @handle 恒久リンクの取得 UI。NEXT_PUBLIC_ENABLE_HANDLES OFF では何も描画しない。
// SIWE サインイン → 取得済み一覧 (編集/開く/コピー/解放) → handle 入力 + 空き確認 →
// 現在のプロフィール設定 (config+profile) を publish。設定は親 (HandleProfileBuilder) から
// HandleTipConfig + HandleProfile として受け取る (受取先/方法 未確定なら config=null)。
//
// 編集モードは親が所有 (editingHandle)。「編集」でフォームに prefill + モード開始、
// バナーで対象を明示し、編集中に**別名**で公開すると同内容の複製になることを事前警告する
// (静かに複製が生まれるのが最大の混乱源だったため)。公開/更新は成功メッセージを出す。

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import {
  validateHandle,
  type HandleTipConfig,
  type HandleProfile,
} from '@/lib/handle';

type Availability = { available: boolean; reason?: string };
type OwnedHandle = {
  handle: string;
  config: HandleTipConfig;
  profile?: HandleProfile;
  updatedAt?: number;
};
type MineResponse = { handles: OwnedHandle[]; max: number };

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export function HandleClaimPanel({
  config,
  profile,
  onEdit,
  editingHandle = null,
  onStopEditing,
  onPublished,
}: {
  config: HandleTipConfig | null;
  profile?: HandleProfile;
  onEdit?: (
    handle: string,
    config: HandleTipConfig,
    profile?: HandleProfile,
  ) => void;
  /** 親 (builder) が保持する編集モード。null = 新規取得モード。 */
  editingHandle?: string | null;
  onStopEditing?: () => void;
  /** 公開成功 (created/updated) 後に親へ通知 — 以後その handle の編集モードに入る。 */
  onPublished?: (handle: string) => void;
}) {
  const t = useTranslations('HandleClaim');
  const { isSignedIn, sessionAddress, signIn, isSigningIn, signInError } =
    useSiweSession();
  const origin = useOrigin();
  const linkCopy = useCopyToClipboard();
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');
  // 直近の公開結果 (成功メッセージ用)。入力を変えたらクリア。
  const [published, setPublished] = useState<{
    handle: string;
    status: 'created' | 'updated';
  } | null>(null);

  // 親が編集モードを解除したら入力欄も新規取得モードへ戻す。
  useEffect(() => {
    if (editingHandle === null) {
      setInput('');
      setPublished(null);
    }
  }, [editingHandle]);

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
      const handles = Array.isArray(json.handles)
        ? (json.handles as unknown[]).filter(
            (h): h is OwnedHandle =>
              !!h &&
              typeof h === 'object' &&
              typeof (h as OwnedHandle).handle === 'string' &&
              !!(h as OwnedHandle).config,
          )
        : [];
      return { handles, max: typeof json.max === 'number' ? json.max : 3 };
    },
  });

  const publish = useMutation({
    mutationFn: async (handle: string) => {
      const { ok, status, json } = await fetchJson('/api/handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, config, profile }),
      });
      if (!ok) throw new Error(typeof json.error === 'string' ? json.error : `http_${status}`);
      return json;
    },
    onSuccess: (json, handle) => {
      qc.invalidateQueries({ queryKey: ['handle-mine'] });
      qc.invalidateQueries({ queryKey: ['handle-availability'] });
      // 入力は消さず「いま @handle を編集している」状態に遷移する (続けて微調整できる)。
      setPublished({
        handle,
        status: json.status === 'created' ? 'created' : 'updated',
      });
      onPublished?.(handle);
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
  const ownedNames = owned.map((o) => o.handle);
  const atLimit = owned.length >= max;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-800">{t('title')}</h3>
      <p className="mt-1 text-xs text-slate-500">{t('description')}</p>

      {!isSignedIn ? (
        // サインインは config の有無に関わらず出す (既存 handle の編集/解放を受取先未設定でも到達可能に)。
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
          {/* 取得済み handle 一覧 (2回目以降は編集が主動線なので先頭に置く) */}
          {owned.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t('yourHandles', { count: owned.length, max })}
              </h4>
              <ul className="space-y-3">
                {owned.map((o) => {
                  const h = o.handle;
                  const link = origin ? `${origin}/@${h}` : `/@${h}`;
                  const isEditing = editingHandle === h;
                  return (
                    <li
                      key={h}
                      className={`rounded-lg p-3 ${
                        isEditing ? 'bg-amber-50 ring-1 ring-amber-300' : 'bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="break-all font-mono text-xs text-slate-700">
                          {link}
                        </span>
                        <div className="flex flex-none gap-1.5">
                          {onEdit && (
                            <button
                              type="button"
                              onClick={() => {
                                // 入力欄を編集対象 handle に合わせる (update が正しい handle を
                                // 狙うため)。同時に親へ config/profile の prefill を通知。
                                setInput(o.handle);
                                setPublished(null);
                                onEdit(o.handle, o.config, o.profile);
                              }}
                              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
                            >
                              {t('edit')}
                            </button>
                          )}
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
                          >
                            {t('open')}
                          </a>
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

          {/* 取得/更新フォーム */}
          <div className={owned.length > 0 ? 'border-t border-slate-100 pt-3' : ''}>
            {editingHandle ? (
              // 編集モードを明示 (黙ってフォームが書き換わるのが最大の混乱源)。
              <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2">
                <span className="text-xs font-medium text-amber-800">
                  {t('editingBanner', { handle: editingHandle })}
                </span>
                {onStopEditing && (
                  <button
                    type="button"
                    onClick={onStopEditing}
                    className="flex-none text-xs font-semibold text-amber-700 underline hover:text-amber-900"
                  >
                    {t('stopEditing')}
                  </button>
                )}
              </div>
            ) : (
              owned.length > 0 && (
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {t('newHandleTitle')}
                </h4>
              )
            )}
            {/* 受取先/方法 未確定なら取得は不可だが、サインイン + 取得済み一覧の編集は可能。 */}
            {!config && (
              <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {t('needReceiver')}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-slate-400">{origin || 'open-pay.jp'}/@</span>
              <input
                type="text"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setPublished(null);
                }}
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
              !ownedNames.includes(normalized) && (
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
            {/* 編集中に別名を入れた場合: 同内容の複製になることを事前警告。 */}
            {editingHandle &&
              validation.ok &&
              normalized !== editingHandle && (
                <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {t('copyAsNewHint', { editing: editingHandle, name: normalized })}
                </p>
              )}

            <button
              type="button"
              onClick={() => normalized && config && publish.mutate(normalized)}
              disabled={
                !config || // 受取先/方法 未確定では取得/更新できない
                !validation.ok ||
                publish.isPending ||
                // 他人が使用中なら不可。自分が所有する handle の更新は許可する。
                (availability.data?.available === false &&
                  !ownedNames.includes(normalized)) ||
                (atLimit && !ownedNames.includes(normalized))
              }
              className="mt-2 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {publish.isPending
                ? t('claiming')
                : ownedNames.includes(normalized)
                  ? t('updateButton')
                  : t('claimButton')}
            </button>
            {/* 公開結果のフィードバック (無言で入力が消えるのは「何が起きたか」不明だった) */}
            {published && !publish.isPending && (
              <p className="mt-2 text-xs font-medium text-emerald-600">
                {published.status === 'created'
                  ? t('publishedCreated', { handle: published.handle })
                  : t('publishedUpdated', { handle: published.handle })}
              </p>
            )}
            {atLimit && (
              <p className="mt-2 text-xs text-amber-700">{t('limitReached', { max })}</p>
            )}
            {publish.isError && (
              <p className="mt-2 text-xs text-red-600">
                {t('claimError', { error: (publish.error as Error).message })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
