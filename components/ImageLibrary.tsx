'use client';

// マイページの「アップロードした画像」(/{locale}/me/images)。本人がアップロードした画像を一覧 (サムネ・用途・日付・使っている所)
// し、使っていない画像を消せる (上限 200 枚に届いた人が自分で空けるため)。
// - 出すかは /api/auth/siwe/me の imageUpload (ヘッダが既に読む GET・呼び出しは増えない)。サインイン前は imageUploadSignIn の
//   ときだけサインインの入口を出す。どちらでもなければ短い文だけ (段階 off では一覧の GET を送らない)。
// - ウォレット (セッションの本人) が替わったら、一覧を key で作り直す (前のウォレットのサムネ・確認・失敗の文を残さない)。
// - 一覧は世代 (generation) で古い GET を捨てる: 消した後の読み直しが始まったら、その前の「もっと見る」の結果は入れない。
// - 二重の削除は同期の ref で止める (state の反映を待たない)。
// - 消した (204) ら行を外して先頭から読み直す。409 (使っている) は行に使っている所を出す。結果が分からない (通信・503) ときは
//   読み直す。
// - 使っている所は server が本人の商品・公開プロフィール・店舗の記録から分かる範囲だけ。この端末のレジの商品・下書き・
//   配った注文リンクや QR は分からないので、消す前の確認で伝える。

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { ImagePreview } from '@/components/ImageField';
import { SignInGate } from '@/components/SignInGate';
import { useSiweSession } from '@/hooks/useSiweSession';
import type { ImageLibraryItem, ImageUse } from '@/lib/images/library';
import {
  deleteLibraryImage,
  fetchImageLibraryPage,
  type ImageLibraryFailure,
} from '@/lib/images/libraryClient';
import { IMAGE_OWNER_MAX_IMAGES } from '@/lib/images/purpose';

/** 失敗の code ごとの文 (ImageLibrary.errors の key)。code を足すと typecheck が落ちる (文のない code を出さない)。 */
const ERROR_KEYS: Record<ImageLibraryFailure, string> = {
  not_found: 'notAvailable',
  forbidden: 'notAvailable',
  not_configured: 'notAvailable',
  cross_site_request: 'notAvailable',
  unauthenticated: 'unauthenticated',
  session_mismatch: 'unauthenticated',
  rate_limited: 'rateLimited',
  image_in_use: 'inUse',
  session_storage_unavailable: 'unavailable',
  storage_unavailable: 'unavailable',
  network: 'network',
  invalid_wallet: 'unknown',
  invalid_cursor: 'unknown',
  invalid_body: 'unknown',
  payload_too_large: 'unknown',
  unsupported_media_type: 'unknown',
  unknown: 'unknown',
};

// 削除の結果が分からない失敗 (届いたか・消えたかを確かめられない)。行には出さず、一覧を読み直して今の状態を見せる。
const UNKNOWN_RESULT: ReadonlySet<ImageLibraryFailure> = new Set(['network', 'storage_unavailable', 'unknown']);

const buttonClass =
  'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400';
const dangerButtonClass =
  'inline-flex min-h-11 items-center justify-center rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50';

function itemKey(item: Pick<ImageLibraryItem, 'purpose' | 'id' | 'ext'>): string {
  return `${item.purpose}/${item.id}.${item.ext}`;
}

function usageMessageKey(use: ImageUse): string {
  if (use.kind === 'product') return use.field === 'cover' ? 'uses.productCover' : 'uses.productGallery';
  if (use.kind === 'profile') {
    return use.field === 'avatar' ? 'uses.profileAvatar' : use.field === 'cover' ? 'uses.profileCover' : 'uses.profileLink';
  }
  return use.field === 'avatar' ? 'uses.storefrontAvatar' : use.field === 'cover' ? 'uses.storefrontCover' : 'uses.storefrontMenu';
}

export function ImageLibrary() {
  const t = useTranslations('ImageLibrary');
  const tNav = useTranslations('Nav');
  const locale = useLocale();
  const { address } = useAccount();
  const { isSignedIn, isLoading, imageUpload, imageUploadSignIn } = useSiweSession();

  let body;
  if (isLoading) {
    body = (
      <p role="status" className="mt-6 text-sm text-slate-500">
        {t('loading')}
      </p>
    );
  } else if (isSignedIn && imageUpload && address) {
    body = <ImageLibraryList key={address.toLowerCase()} wallet={address} />;
  } else if (!isSignedIn && imageUploadSignIn) {
    body = (
      <SignInGate className="mt-6" statement={tNav('siweStatement')} cta={t('signIn')} prompt={t('signInPrompt')} />
    );
  } else {
    body = <p className="mt-6 text-sm text-slate-600">{t('notAvailable')}</p>;
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link href={`/${locale}/me`} prefetch={false} className="inline-flex min-h-11 items-center text-sm font-medium text-brand underline underline-offset-2">
        {t('back')}
      </Link>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">{t('title')}</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{t('intro', { max: IMAGE_OWNER_MAX_IMAGES })}</p>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('usageNote')}</p>
      {body}
    </div>
  );
}

type RowError = { error: ImageLibraryFailure };

function ImageLibraryList({ wallet }: { wallet: string }) {
  const t = useTranslations('ImageLibrary');
  const locale = useLocale();
  const [rows, setRows] = useState<ImageLibraryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<ImageLibraryFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ImageLibraryFailure | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, RowError>>>({});
  const [unknownResult, setUnknownResult] = useState(false);

  // 一覧の世代。読み直すたびに進め、届いた GET の世代が今と違えば捨てる (古い GET・前の「もっと見る」)。
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  // 送っている削除 (行の key)。state の反映より先に、同じ行の 2 回目を止める。
  const deletingRef = useRef(new Set<string>());
  // unmount の後に届いた削除の結果で、読み直しを始めない (ウォレットが替わった後の古い画面)。
  const alive = useRef(false);
  // 確認を開いたら「やめる」へ、閉じたらその行の「消す」へ focus を移す (押したボタンが消えて body に落ちないように)。
  const confirmCancel = useRef<HTMLButtonElement>(null);
  const focusReturn = useRef<string | null>(null);
  useEffect(() => {
    if (confirming !== null) confirmCancel.current?.focus();
  }, [confirming]);

  const reload = useCallback(() => {
    generation.current += 1;
    const current = generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    loadingMoreRef.current = false;
    setLoading(true);
    setListError(null);
    setLoadingMore(false);
    setMoreError(null);
    void fetchImageLibraryPage(wallet, null, request.signal).then((result) => {
      if (current !== generation.current) return;
      setLoading(false);
      if (result.ok) {
        setRows(result.images);
        setNextCursor(result.nextCursor);
      } else {
        setListError(result.error);
      }
    });
  }, [wallet]);

  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
      generation.current += 1;
      controller.current?.abort();
    };
  }, [reload]);

  const loadMore = () => {
    if (nextCursor === null || loadingMoreRef.current) return;
    const current = generation.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    void fetchImageLibraryPage(wallet, nextCursor, controller.current?.signal).then((result) => {
      if (current !== generation.current) return;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      if (result.ok) {
        setRows((previous) => {
          const seen = new Set(previous.map(itemKey));
          return [...previous, ...result.images.filter((item) => !seen.has(itemKey(item)))];
        });
        setNextCursor(result.nextCursor);
      } else {
        setMoreError(result.error);
      }
    });
  };

  const clearRowError = (key: string) =>
    setRowErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });

  const remove = (item: ImageLibraryItem) => {
    const key = itemKey(item);
    if (deletingRef.current.has(key)) return;
    deletingRef.current.add(key);
    setDeleting(new Set(deletingRef.current));
    setConfirming(null);
    setUnknownResult(false);
    clearRowError(key);
    void deleteLibraryImage(wallet, { purpose: item.purpose, id: item.id, ext: item.ext }).then((result) => {
      deletingRef.current.delete(key);
      if (!alive.current) return;
      setDeleting(new Set(deletingRef.current));
      if (result.ok) {
        setRows((previous) => previous.filter((row) => itemKey(row) !== key));
        reload();
        return;
      }
      if (result.error === 'image_in_use' && result.usedIn) {
        const usedIn = result.usedIn;
        setRows((previous) => previous.map((row) => (itemKey(row) === key ? { ...row, usedIn } : row)));
      }
      if (UNKNOWN_RESULT.has(result.error)) {
        setUnknownResult(true);
        reload();
        return;
      }
      setRowErrors((previous) => ({ ...previous, [key]: { error: result.error } }));
    });
  };

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  if (loading && rows.length === 0) {
    return (
      <p role="status" className="mt-6 text-sm text-slate-500">
        {t('loading')}
      </p>
    );
  }

  return (
    <div className="mt-6">
      {listError ? (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p>{t(`errors.${ERROR_KEYS[listError]}`)}</p>
          <button type="button" onClick={reload} className={`mt-2 ${buttonClass}`}>
            {t('retry')}
          </button>
        </div>
      ) : null}
      {unknownResult ? (
        <p role="status" className="mb-3 text-sm text-slate-600">
          {t('errors.deleteUnknown')}
        </p>
      ) : null}
      {!listError && !loading && rows.length === 0 && nextCursor === null ? (
        <p className="text-sm text-slate-600">{t('empty')}</p>
      ) : null}
      <ul className="space-y-3">
        {rows.map((item) => {
          const key = itemKey(item);
          const busy = deleting.has(key);
          const rowError = rowErrors[key];
          const date = new Date(item.uploadedAt);
          return (
            <li key={key} className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]">
              <div className="flex gap-3">
                <ImagePreview url={item.url} className="h-16 w-16 flex-shrink-0 rounded-lg ring-1 ring-slate-200" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-slate-900">{t(`purposes.${item.purpose}`)}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{t('uploadedAt', { date: dateFormat.format(date) })}</p>
                  {item.usedIn.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">{t('notUsed')}</p>
                  ) : (
                    <div className="mt-1 text-xs text-slate-700">
                      <p className="font-medium">{t('usedInLabel')}</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                        {item.usedIn.map((use) => (
                          <li key={JSON.stringify(use)} className="break-words">
                            {use.kind === 'product'
                              ? t(usageMessageKey(use), { title: use.title })
                              : t(usageMessageKey(use), { handle: use.handle })}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
              {confirming === key && !busy ? (
                <div role="group" aria-labelledby={`${key}-confirm`} className="mt-3 rounded-lg bg-slate-50 p-3">
                  <p id={`${key}-confirm`} className="text-sm font-bold text-slate-900">
                    {t('confirmTitle')}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('confirmBody')}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => remove(item)} className={dangerButtonClass}>
                      {t('confirmDelete')}
                    </button>
                    <button
                      type="button"
                      ref={confirmCancel}
                      onClick={() => {
                        focusReturn.current = key;
                        setConfirming(null);
                      }}
                      className={buttonClass}
                    >
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    ref={(element) => {
                      if (element && focusReturn.current === key) {
                        focusReturn.current = null;
                        element.focus();
                      }
                    }}
                    onClick={() => {
                      clearRowError(key);
                      setConfirming(key);
                    }}
                    className={buttonClass}
                  >
                    {busy ? t('deleting') : t('delete')}
                  </button>
                </div>
              )}
              {rowError ? (
                <p role="alert" className="mt-2 text-xs leading-relaxed text-red-700">
                  {t(`errors.${ERROR_KEYS[rowError.error]}`)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {nextCursor !== null ? (
        <div className="mt-4">
          <button type="button" onClick={loadMore} disabled={loadingMore || loading} className={buttonClass}>
            {loadingMore ? t('loadingMore') : t('loadMore')}
          </button>
          {moreError ? (
            <p role="alert" className="mt-2 text-xs text-red-700">
              {t(`errors.${ERROR_KEYS[moreError]}`)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
