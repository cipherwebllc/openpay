'use client';

// @handle 恒久リンクの取得 UI。NEXT_PUBLIC_ENABLE_HANDLES OFF では何も描画しない。
// StepCard ② の中身として描画される (枠と見出しは StepCard が提供)。
// SIWE サインイン → 取得済み一覧 (編集/削除) → handle 入力 + 空き確認 →
// 現在のプロフィール設定を publish。親 (HandleProfileBuilder) が純関数で canonical 化した
// payload (config+profile) を受け取る (受取先/方法 未確定なら payload=null)。
// 公開成功直下にも開く/コピーを表示。④ プレビュー下の共有アクションは残す。
//
// 編集モードは親が所有 (editingHandle)。「編集」でフォームに prefill + モード開始、
// バナーで対象を明示し、編集中に**別名**で公開すると同内容の複製になることを事前警告する
// (静かに複製が生まれるのが最大の混乱源だったため)。公開/更新は成功メッセージを出す。

import { resolveTipCapability } from '@/lib/url/tip';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { useAccount } from 'wagmi';
import { shortAddress } from '@/lib/format';
import { useSiweSession } from '@/hooks/useSiweSession';
import { SignInGate } from '@/components/SignInGate';
import { useOrigin } from '@/hooks/useOrigin';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { getPublicHandleUrl } from '@/lib/publicHandleUrl';
import {
  validateHandle,
  normalizeHandle,
  MAX_HANDLES_PER_WALLET,
  type HandleTipConfig,
  type HandleProfile,
} from '@/lib/handle';
import type {
  HandlePublishPayload,
  PublishedHandleSnapshot,
} from '@/lib/handlePublish';
import { MY_HANDLES_ROOT_KEY, fetchMyHandles, myHandlesQueryKey } from '@/lib/handleMine';

// 削除確認の danger モーダル。LinkQrModal と同じ a11y パターン: 開いたら確定ボタンへ
// フォーカス・Tab は背後へ抜けないようトラップ・閉じたら元の要素へ復元・ESC/背景で閉じる。
// window.confirm はブラウザ依存で文言制御もできず、削除という不可逆操作の警告に弱いため。
function ReleaseConfirmModal({
  open,
  handle,
  link,
  title,
  body,
  confirmLabel,
  cancelLabel,
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  open: boolean;
  handle: string;
  link: string;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmDisabled: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // inline arrow は毎レンダ別 identity なので effect dep にせず ref 経由で読む
  // (表示中の親再レンダで returnFocusRef がボタン自身に上書きされ復元 focus が壊れるのを防ぐ)。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // 破壊的操作の確認なので初期フォーカスは安全側 (キャンセル) に置く
    // (開いた直後の Enter 誤打で解放が確定しないように)。
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      // フォーカス可能要素は確定/キャンセルの 2 つ → Tab/Shift+Tab で 2 ボタン間を循環させ
      // 背後のページへ抜けないようトラップする。
      if (e.key === 'Tab') {
        e.preventDefault();
        const active = document.activeElement;
        if (active === confirmRef.current) cancelRef.current?.focus();
        else confirmRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      returnFocusRef.current?.focus?.();
      returnFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{body}</p>
        <p className="mt-2 break-all font-mono text-xs text-slate-500">{link}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

type Availability = { available: boolean; reason?: string };
type PublishMutationSnapshot = {
  handle: string;
  payload: HandlePublishPayload;
  expectedUpdatedAt?: number;
};

class HandlePublishError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'HandlePublishError';
  }
}

function isConflictError(error: unknown): boolean {
  return (
    error instanceof HandlePublishError &&
    error.status === 409 &&
    error.code === 'conflict'
  );
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export function HandleClaimPanel({
  payload,
  onEdit,
  publishBlockedReason,
  editingHandle = null,
  expectedUpdatedAt,
  isDirty = false,
  onStopEditing,
  onPublished,
  canAutoEdit = false,
  barSlots = [],
}: {
  payload: HandlePublishPayload | null;
  publishBlockedReason?: string;
  onEdit?: (
    handle: string,
    config: HandleTipConfig,
    profile?: HandleProfile,
    updatedAt?: number,
  ) => void;
  /** 親 (builder) が保持する編集モード。null = 新規取得モード。 */
  editingHandle?: string | null;
  /** 現在編集中 handle の読込/直近保存 baseline。新規取得・別名取得では送らない。 */
  expectedUpdatedAt?: number;
  /** 読込/送信 snapshot と現在の canonical payload が異なる。 */
  isDirty?: boolean;
  /** 編集中の handle を削除したときに編集をやめる (親の編集モードを解除)。 */
  onStopEditing?: () => void;
  /** この端末の下書きがまだ手付かず (既定のまま) なら true。持っている @handle が 1 つだけなら、サインイン時に
   *  確認なしでその編集に入る (戻ってきた人に空の編集画面を見せない・失うものが無いときだけ)。 */
  canAutoEdit?: boolean;
  /** 公開ボタンの帯を描く場所 (スマホの下部バー・PC のプレビュー下)。同じ公開処理をどこからでも押せるように。 */
  barSlots?: ReadonlyArray<HTMLElement | null>;
  /** 公開成功後、mutation 変数の送信 snapshot を親の baseline にする。 */
  onPublished?: (snapshot: PublishedHandleSnapshot) => void;
}) {
  const { isConnected, address } = useAccount();
  const t = useTranslations('HandleClaim');
  const { isSignedIn, sessionAddress } = useSiweSession();
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
  const publicHandleUrl = published
    ? getPublicHandleUrl(origin, published.handle)
    : '';
  // 削除確認モーダルの対象 handle (null = 閉)。window.confirm を置き換える danger 確認。
  const [releaseTarget, setReleaseTarget] = useState<string | null>(null);
  const config = payload?.config ?? null;

  // 親が編集モードを解除したら入力欄も新規取得モードへ戻す。
  useEffect(() => {
    if (editingHandle === null) {
      setInput('');
      setPublished(null);
    }
  }, [editingHandle]);

  // env は build 時定数なので hook 後に early-return しても hook 数は不変。
  const validation = useMemo(
    () => validateHandle(input, { allowReserved: normalizeHandle(input) === editingHandle }),
    [input, editingHandle],
  );
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
    // 取得と返り値の形は lib/handleMine.ts に 1 つ (他の画面・トップと同じ cache を共有する)。
    queryKey: myHandlesQueryKey(sessionAddress),
    enabled: env.enableHandles && isSignedIn,
    queryFn: fetchMyHandles,
  });

  const publish = useMutation({
    mutationFn: async (snapshot: PublishMutationSnapshot) => {
      // サーバの寛容な method drop を公開成功へ波及させず、全方法を保存前に検証する。
      if (publishBlockedReason) throw new Error(publishBlockedReason);
      if (snapshot.payload.config.methods.some((m) => !resolveTipCapability(m.token, m.chain).ok)) {
        throw new Error(t('unsupportedMethod'));
      }
      const { ok, status, json } = await fetchJson('/api/handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: snapshot.handle,
          ...snapshot.payload,
          expectedUpdatedAt: snapshot.expectedUpdatedAt,
        }),
      });
      if (!ok) {
        const code = typeof json.error === 'string' ? json.error : `http_${status}`;
        throw new HandlePublishError(status, code);
      }
      if (typeof json.updatedAt !== 'number' || !Number.isFinite(json.updatedAt)) {
        throw new Error('invalid_response');
      }
      return {
        status: json.status === 'created' ? ('created' as const) : ('updated' as const),
        updatedAt: json.updatedAt,
      };
    },
    onSuccess: (json, snapshot) => {
      qc.invalidateQueries({ queryKey: MY_HANDLES_ROOT_KEY });
      qc.invalidateQueries({ queryKey: ['handle-availability'] });
      // 入力は消さず「いま @handle を編集している」状態に遷移する (続けて微調整できる)。
      setPublished({
        handle: snapshot.handle,
        status: json.status,
      });
      onPublished?.({
        handle: snapshot.handle,
        payload: snapshot.payload,
        updatedAt: json.updatedAt,
      });
    },
    onError: async (error) => {
      if (!isConflictError(error)) return;
      setPublished(null);
      // editor の baseline は進めず、一覧だけ最新 record へ更新する。ユーザが明示的に
      // 「再読込」を押したときだけ未保存 draft を置換する。
      await mine.refetch();
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
    onSuccess: (_json, handle) => {
      qc.invalidateQueries({ queryKey: MY_HANDLES_ROOT_KEY });
      // 解放した handle を空き確認キャッシュからも無効化 (旧 'taken' を残さない)。
      qc.invalidateQueries({ queryKey: ['handle-availability'] });
      // 確認モーダルを閉じる (成功で消す。失敗時は開いたまま再試行できるよう残す)。
      setReleaseTarget(null);
      // 編集中の handle を解放したら編集モードを解除する (onEdit/onStopEditing と対称に)。
      // でないと「@x を編集中」バナー・input・publish ボタンが消えた handle を指し続け、
      // 1 クリックで削除したはずの handle を再作成してしまう。
      if (editingHandle === handle) {
        onStopEditing?.();
      }
    },
  });

  const reloadConflictedHandle = async () => {
    const refreshed = await mine.refetch();
    if (!refreshed.isSuccess) return;
    const conflictedHandle = publish.variables?.handle;
    const latest = refreshed.data?.handles.find(
      (ownedHandle) => ownedHandle.handle === conflictedHandle,
    );
    if (!latest || !onEdit) return;
    setInput(latest.handle);
    setPublished(null);
    onEdit(
      latest.handle,
      latest.config,
      latest.profile,
      latest.updatedAt,
    );
    publish.reset();
  };

  // 戻ってきた人: この端末がまだ手付かずで、持っている @handle が 1 つだけなら、その編集に入る (セッションごとに
  // 1 回だけ試す・再取得や下書きの変化で何度も走らせない)。2 つ以上なら一覧から選んでもらう。
  const autoEditTried = useRef<string | null>(null);
  useEffect(() => {
    // isSignedIn = セッションと接続中のウォレットが一致 (別のウォレットのセッション・キャッシュから編集に入らない)。
    if (!canAutoEdit || !onEdit || editingHandle !== null || !isSignedIn || !sessionAddress || !mine.isSuccess) return;
    if (autoEditTried.current === sessionAddress) return;
    autoEditTried.current = sessionAddress;
    // 一覧の取得を待つあいだに @handle を打ち始めた人は、新しく取ろうとしている。打った文字を上書きしない。
    if (input.trim() !== '') return;
    const handles = mine.data?.handles ?? [];
    if (handles.length !== 1) return;
    const only = handles[0];
    setInput(only.handle);
    setPublished(null);
    onEdit(only.handle, only.config, only.profile, only.updatedAt);
  }, [canAutoEdit, onEdit, editingHandle, isSignedIn, sessionAddress, mine.isSuccess, mine.data, input]);

  if (!env.enableHandles) return null;

  const max = mine.data?.max ?? MAX_HANDLES_PER_WALLET;
  const owned = mine.data?.handles ?? [];
  const ownedNames = owned.map((o) => o.handle);
  const atLimit = owned.length >= max;
  const emphasizeUpdate =
    isDirty &&
    normalized === editingHandle &&
    ownedNames.includes(normalized);
  // 取得/更新を押せるか (カードのボタンと帯のボタンで同じ条件)。
  const publishDisabled =
    !isSignedIn ||
    !!publishBlockedReason ||
    !config || // 受取先/方法 未確定では取得/更新できない
    !validation.ok ||
    publish.isPending ||
    // 他人が使用中なら不可。自分が所有する handle の更新は許可する。
    (availability.data?.available === false && !ownedNames.includes(normalized)) ||
    (atLimit && !ownedNames.includes(normalized));
  const publishLabel = publish.isPending
    ? t('claiming')
    : ownedNames.includes(normalized)
      ? t('updateButton')
      : t('claimButton');
  // 帯のボタンは短い言い方 (モバイル注文の帯と同じ「公開する / 公開を更新」・理由の文を切らない)。
  const barLabel = publish.isPending
    ? t('claiming')
    : ownedNames.includes(normalized)
      ? t('barUpdate')
      : t('barPublish');
  const onPublishClick = () =>
    normalized &&
    payload &&
    publish.mutate({
      handle: normalized,
      payload,
      expectedUpdatedAt: normalized === editingHandle ? expectedUpdatedAt : undefined,
    });
  // 帯の左: 押せない理由を 1 行 (サインイン / 受取先 / @handle)、押せるときは対象の @handle と状態。
  const barReason = !isSignedIn
    ? t('barReasonSignIn')
    : !config
      ? t('barReasonReceiver')
      : !validation.ok
        ? t('barReasonHandle')
        : null;
  const barStatus = editingHandle && normalized === editingHandle
    ? isDirty
      ? t('unpublishedChanges')
      : t('barStatusLive')
    : ownedNames.includes(normalized)
      ? t('barStatusLive')
      : t('barStatusNew');
  const bar = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {barReason ? (
          <p className="truncate text-sm font-medium text-slate-500">{barReason}</p>
        ) : (
          <>
            <p className="truncate text-[11px] text-slate-500">@{normalized}</p>
            <p className="truncate text-sm font-semibold text-slate-900">{barStatus}</p>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onPublishClick}
        disabled={publishDisabled}
        className="inline-flex shrink-0 items-center justify-center rounded-xl bg-brand px-5 py-3 text-base font-bold text-white transition-transform hover:bg-brand-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
      >
        {barLabel}
      </button>
    </div>
  );

  return (
    <div>
      <p className="text-xs text-slate-500">{t('description')}</p>

      {!isSignedIn ? (
        // サインインは config の有無に関わらず出す (既存 handle の編集/削除を受取先未設定でも到達可能に)。
        <SignInGate
          className="mt-3"
          statement={t('signInStatement')}
          cta={t('signInButton')}
          // どのウォレットで取得するかを見せる (接続済みのときだけ)。
          prompt={isConnected && address ? t('statusConnected', { address: shortAddress(address) }) : undefined}
        />
      ) : (
        <div className="mt-3 space-y-3">
          {sessionAddress && (
            <p className="text-xs text-slate-500">
              {t('statusSignedIn', { address: shortAddress(sessionAddress) })}
            </p>
          )}
          {/* 一覧の読み込み失敗は隠さない (KV 障害を「0件」と誤認させない)。 */}
          {mine.isError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <span>{t('mineError')}</span>{' '}
              <button
                type="button"
                onClick={() => void mine.refetch()}
                className="font-semibold underline hover:text-red-900"
              >
                {t('retry')}
              </button>
            </div>
          )}
          {/* 取得済み handle 一覧 (2回目以降は編集が主動線なので先頭に置く) */}
          {owned.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t('yourHandles', { count: owned.length, max })}
              </h4>
              <ul className="space-y-3">
                {owned.map((o) => {
                  const h = o.handle;
                  const isEditing = editingHandle === h;
                  return (
                    <li
                      key={h}
                      className={`rounded-lg p-3 ${
                        isEditing
                          ? 'bg-emerald-50 ring-1 ring-emerald-200'
                          : 'bg-slate-50'
                      }`}
                    >
                      {/* 1段目: ハンドル名のみ (URL 全文は詰まって読めないため出さない —
                          開く/コピー/QR は ④ プレビュー下に集約)。2段目: 操作ボタン。 */}
                      <p className="break-all font-mono text-sm font-semibold text-slate-800">
                        @{h}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                          {onEdit && (
                            <button
                              type="button"
                              onClick={() => {
                                // 入力欄を編集対象 handle に合わせる (update が正しい handle を
                                // 狙うため)。同時に親へ config/profile の prefill を通知。
                                setInput(o.handle);
                                setPublished(null);
                                onEdit(o.handle, o.config, o.profile, o.updatedAt);
                              }}
                              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
                            >
                              {t('edit')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setReleaseTarget(h)}
                            className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
                          >
                            {t('delete')}
                          </button>
                      </div>
                      {isEditing && (
                        <p className="mt-1.5 text-xs font-medium text-emerald-700">
                          {t('publishedStatus', { handle: h })}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {/* 解放失敗を無言で握りつぶさない (リンクが生きているのに消えたと誤認させない)。 */}
              {release.isError && (
                <p className="mt-2 text-xs text-red-600">
                  {t('releaseError', { error: (release.error as Error).message })}
                </p>
              )}
            </div>
          )}

          {/* 取得/更新フォーム */}
          <div className={owned.length > 0 ? 'border-t border-slate-100 pt-3' : ''}>
            {/* 編集中の表示 (公開中・更新時刻・未公開の変更・編集をやめる) は「あなたのページ」の見出しの下に 1 か所。 */}
            {!editingHandle && owned.length > 0 && (
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t('newHandleTitle')}
              </h4>
            )}
            {/* 受取先/方法 未確定なら取得は不可だが、サインイン + 取得済み一覧の編集は可能。 */}
            {!config && (
              <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {t('needReceiver')}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-slate-500">{origin || 'open-pay.jp'}/@</span>
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
            <p className="mt-1 text-xs text-slate-500">{t('formatHint')}</p>
            {/* 入力検証 + 空き状態 */}
            {input.length > 0 && !validation.ok && (
              <p className="mt-1 text-xs text-red-600">
                {validation.reason === 'reserved' ? t('reservedWord') : t('invalidFormat')}
              </p>
            )}
            {/* 自分が既に所有する handle は「使用済み」を出さない (更新フロー)。
                KV 障害 (reason:'unavailable') は「使用済み」と偽らず「確認できない」と正直に出す。 */}
            {validation.ok &&
              debounced === normalized &&
              !ownedNames.includes(normalized) && (
                <p className="mt-1 text-xs">
                  {availability.isFetching ? (
                    <span className="text-slate-500">{t('checking')}</span>
                  ) : availability.data?.available ? (
                    <span className="text-emerald-600">{t('available')}</span>
                  ) : availability.data?.reason === 'unavailable' ||
                    availability.isError ? (
                    <span className="text-amber-700">{t('availabilityUnknown')}</span>
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
              onClick={onPublishClick}
              disabled={publishDisabled}
              className={`mt-2 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40 ${
                emphasizeUpdate ? 'ring-2 ring-amber-300 ring-offset-2' : ''
              }`}
            >
              {publishLabel}
            </button>
            {/* 公開結果のフィードバック (無言で入力が消えるのは「何が起きたか」不明だった) */}
            {published && !publish.isPending && (
              <div className="mt-2">
                <p className="text-xs font-medium text-emerald-600">
                  {published.status === 'created'
                    ? t('publishedCreated', { handle: published.handle })
                    : t('publishedUpdated', { handle: published.handle })}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <a
                    href={publicHandleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
                  >
                    {t('open')}
                  </a>
                  <button
                    type="button"
                    onClick={() => void linkCopy.copy(publicHandleUrl)}
                    className="rounded-md border border-slate-900 bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700"
                  >
                    {linkCopy.copied ? t('copied') : t('copy')}
                  </button>
                </div>
              </div>
            )}
            {atLimit && (
              <p className="mt-2 text-xs text-amber-700">{t('limitReached', { max })}</p>
            )}
            {publishBlockedReason && (
              <p role="alert" className="mt-2 text-xs text-red-600">{publishBlockedReason}</p>
            )}
            {publish.isError && (
              isConflictError(publish.error) ? (
                <div className="mt-2 text-xs text-red-600">
                  <span>{t('conflictError')}</span>{' '}
                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => void reloadConflictedHandle()}
                      className="font-semibold underline hover:text-red-800"
                    >
                      {t('reload')}
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs text-red-600">
                  {publish.error instanceof HandlePublishError &&
                  publish.error.code === 'audius resolve failed'
                    ? t('audiusResolveError')
                    : t('claimError', {
                        error: (publish.error as Error).message,
                      })}
                </p>
              )
            )}
          </div>
        </div>
      )}

      {/* 公開ボタンの帯 (スマホの下部バー・PC のプレビュー下)。同じ条件・同じ公開処理。 */}
      {barSlots.map((slot, i) => (slot ? <span key={i} hidden>{createPortal(bar, slot)}</span> : null))}

      {/* 削除 (解放) 確認モーダル。不可逆操作なので window.confirm でなく danger ダイアログで明示。 */}
      <ReleaseConfirmModal
        open={releaseTarget !== null}
        handle={releaseTarget ?? ''}
        link={
          releaseTarget
            ? origin
              ? `${origin}/@${releaseTarget}`
              : `open-pay.jp/@${releaseTarget}`
            : ''
        }
        title={t('releaseModalTitle', { handle: releaseTarget ?? '' })}
        body={t('releaseModalBody', { handle: releaseTarget ?? '' })}
        confirmLabel={t('releaseModalConfirm')}
        cancelLabel={t('releaseModalCancel')}
        confirmDisabled={release.isPending}
        onConfirm={() => releaseTarget && release.mutate(releaseTarget)}
        onClose={() => setReleaseTarget(null)}
      />
    </div>
  );
}
