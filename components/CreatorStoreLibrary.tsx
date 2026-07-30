'use client';

// SIWE で束縛された購入済みライブラリ。購入一覧と content の query key には必ず
// sessionAddress を含め、別 wallet の購入情報を React Query cache から再利用しない。

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ExternalLink,
  FileText,
  LibraryBig,
  Loader2,
  PackageOpen,
  RefreshCw,
} from 'lucide-react';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useStoreCacheScope } from '@/hooks/useStoreCacheScope';

type LibraryRevision = {
  title: string;
  desc?: string;
  emoji?: string;
  priceJpyc: string;
  contentKind: 'url' | 'text';
  label: 'download' | 'pdf' | 'zip' | 'prompt' | 'api' | 'external';
  purchasedAt: number;
  contentRevision: number;
};

type LibraryItem = LibraryRevision & {
  resourceId: string;
  revisions: LibraryRevision[];
};

type LibraryPage = {
  ok: true;
  items: LibraryItem[];
  nextCursor: string | null;
};

type ReadyContent = {
  ok: true;
  state: 'ready';
  resourceId: string;
  title: string;
  contentRevision: number;
  intentSalt: string;
  kind: 'url' | 'text';
  value: string;
};

type EndedContent = {
  ok: true;
  state: 'provided-ended';
  resourceId: string;
  title: string;
  contentRevision: number;
  intentSalt: string;
};

type StoreContent = ReadyContent | EndedContent;

class StoreLibraryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'StoreLibraryRequestError';
  }
}

async function requestStoreJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  // Proxy/障害時の非 JSON body が HTTP status を隠す波及だけを断ち、ok:true は必須にする。
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string }
    | null;
  if (!response.ok || body?.ok !== true) {
    throw new StoreLibraryRequestError(
      response.status,
      typeof body?.error === 'string' ? body.error : `http_${response.status}`,
    );
  }
  return body as T;
}

async function fetchLibraryPage(cursor: string | null): Promise<LibraryPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestStoreJson<LibraryPage>(`/api/store/library${query}`);
}

async function fetchOwnedContent(
  resourceId: string,
  contentRevision: number,
): Promise<StoreContent> {
  return requestStoreJson<StoreContent>(
    `/api/store/content/${encodeURIComponent(resourceId)}?revision=${contentRevision}`,
  );
}

export function CreatorStoreLibrary() {
  if (!env.enableCreatorStoreUi) return null;
  return <EnabledCreatorStoreLibrary />;
}

function EnabledCreatorStoreLibrary() {
  const t = useTranslations('CreatorStoreLibrary');
  const locale = useLocale();
  const {
    isSignedIn,
    mismatch,
    isLoading: isSessionLoading,
    sessionAddress,
    signIn,
    isSigningIn,
    signInError,
  } = useSiweSession();
  useStoreCacheScope(sessionAddress);
  const [selectedContent, setSelectedContent] = useState<{
    resourceId: string;
    contentRevision: number;
  } | null>(null);
  const selectedResourceId = selectedContent?.resourceId ?? null;
  const selectedRevision = selectedContent?.contentRevision ?? null;
  const purchaseDate = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  const library = useInfiniteQuery({
    queryKey: ['store', 'library', sessionAddress],
    queryFn: ({ pageParam }) => fetchLibraryPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: isSignedIn && !!sessionAddress,
    retry: 1,
  });

  const content = useQuery({
    queryKey: [
      'store',
      'content',
      sessionAddress,
      selectedResourceId,
      selectedRevision,
    ],
    queryFn: () =>
      fetchOwnedContent(
        selectedResourceId as string,
        selectedRevision as number,
      ),
    enabled:
      isSignedIn &&
      !!sessionAddress &&
      selectedResourceId !== null &&
      selectedRevision !== null,
    retry: false,
  });

  if (isSessionLoading) {
    return (
      <div
        role="status"
        className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-600"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {t('checkingSession')}
      </div>
    );
  }

  if (!isSignedIn || !sessionAddress) {
    return (
      <section
        aria-labelledby="creator-store-library-sign-in-heading"
        className="rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-card"
      >
        <LibraryBig className="mx-auto h-9 w-9 text-brand" aria-hidden />
        <h1
          id="creator-store-library-sign-in-heading"
          className="mt-3 text-xl font-bold text-slate-900"
        >
          {t('heading')}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">
          {t('signInPrompt')}
        </p>
        <button
          type="button"
          disabled={isSigningIn}
          onClick={() => {
            // rejection は signInError とボタン状態で表示し、unhandled rejection を親画面へ波及させない。
            void signIn(t('signInStatement')).catch(() => undefined);
          }}
          className="mt-5 min-h-11 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSigningIn
            ? t('signingIn')
            : mismatch
              ? t('reSignIn')
              : t('signIn')}
        </button>
        {signInError ? (
          <p className="mt-2 text-xs text-red-600">{t('signInError')}</p>
        ) : null}
      </section>
    );
  }

  const items = library.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="creator-store-library-heading">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-blue-50 via-white to-amber-50 px-5 py-6 shadow-card sm:px-7">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-brand">
          <LibraryBig className="h-4 w-4" aria-hidden />
          {t('eyebrow')}
        </p>
        <h1
          id="creator-store-library-heading"
          className="mt-2 text-2xl font-black text-slate-900"
        >
          {t('heading')}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {t('intro')}
        </p>
      </div>

      {library.isPending ? (
        <div
          role="status"
          className="mt-4 flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-600"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t('loading')}
        </div>
      ) : library.isError ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-5 text-red-900">
          <p className="text-sm font-semibold">{t('loadError')}</p>
          <button
            type="button"
            onClick={() => void library.refetch()}
            className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-red-300 px-3 py-2 text-sm font-bold"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t('retry')}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <PackageOpen className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
          <p className="mt-3 font-semibold text-slate-800">{t('empty')}</p>
          <p className="mt-1 text-sm text-slate-500">{t('emptyHint')}</p>
        </div>
      ) : (
        <>
          <ul className="mt-4 space-y-3">
            {items.map((item) => (
              <li
                key={`${item.resourceId}:${item.contentRevision}`}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xl"
                  >
                    {item.emoji ?? '✦'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h2 className="min-w-0 flex-1 font-bold text-slate-900">
                        {item.title}
                      </h2>
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700">
                        {item.priceJpyc} JPYC
                      </span>
                    </div>
                    {item.desc ? (
                      <p className="mt-1 text-sm leading-relaxed text-slate-600">
                        {item.desc}
                      </p>
                    ) : null}
                    <p className="mt-3 text-xs text-slate-500">
                      {t(`labels.${item.label}`)}
                    </p>
                    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-600">
                        {t('revisionsHeading')}
                      </p>
                      <ul className="mt-2 space-y-2">
                        {item.revisions.map((revision) => (
                          <li
                            key={revision.contentRevision}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-3 py-2"
                          >
                            <div className="min-w-0 text-xs text-slate-600">
                              <p className="font-bold text-slate-800">
                                {t('revisionLabel', {
                                  revision: revision.contentRevision,
                                })}
                              </p>
                              {revision.title !== item.title ? (
                                <p className="mt-0.5 truncate">
                                  {revision.title}
                                </p>
                              ) : null}
                              <p className="mt-0.5">
                                {revision.priceJpyc} JPYC ·{' '}
                                {t(`labels.${revision.label}`)}
                              </p>
                              <p className="mt-0.5">
                                {t('purchasedAt')}{' '}
                                <time
                                  dateTime={new Date(
                                    revision.purchasedAt,
                                  ).toISOString()}
                                >
                                  {purchaseDate.format(
                                    revision.purchasedAt,
                                  )}
                                </time>
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                if (
                                  selectedResourceId === item.resourceId &&
                                  selectedRevision ===
                                    revision.contentRevision
                                ) {
                                  void content.refetch();
                                } else {
                                  setSelectedContent({
                                    resourceId: item.resourceId,
                                    contentRevision:
                                      revision.contentRevision,
                                  });
                                }
                              }}
                              className="min-h-10 rounded-lg bg-brand px-3 py-2 text-sm font-bold text-white hover:bg-brand-dark"
                            >
                              {t('showRevision', {
                                revision: revision.contentRevision,
                              })}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {library.hasNextPage ? (
            <div className="mt-4 text-center">
              <button
                type="button"
                disabled={library.isFetchingNextPage}
                onClick={() => void library.fetchNextPage()}
                className="min-h-11 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {library.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
              </button>
            </div>
          ) : null}
        </>
      )}

      {selectedResourceId ? (
        <section
          aria-labelledby="creator-store-owned-content-heading"
          className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-card sm:p-7"
        >
          <h2
            id="creator-store-owned-content-heading"
            className="flex items-center gap-2 text-lg font-bold text-slate-900"
          >
            <FileText className="h-5 w-5 text-brand" aria-hidden />
            {t('contentHeading')}
          </h2>
          {content.isPending || content.isFetching ? (
            <p
              role="status"
              className="mt-4 flex items-center gap-2 text-sm text-slate-600"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('contentLoading')}
            </p>
          ) : content.isError ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <p className="font-semibold">{t('contentError')}</p>
              <button
                type="button"
                onClick={() => void content.refetch()}
                className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-red-300 px-3 py-2 font-bold"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                {t('retry')}
              </button>
            </div>
          ) : content.data?.state === 'provided-ended' ? (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
              <p className="font-bold">{t('providedEnded')}</p>
              <p className="mt-1 text-sm leading-relaxed">
                {t('providedEndedBody')}
              </p>
            </div>
          ) : content.data?.state === 'ready' ? (
            <>
              <p className="mt-3 font-bold text-slate-900">
                {content.data.title}
              </p>
              {content.data.kind === 'url' ? (
                <a
                  href={content.data.value}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-brand-dark"
                >
                  {t('openContent')}
                  <ExternalLink className="h-4 w-4" aria-hidden />
                </a>
              ) : (
                <pre className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-4 text-sm leading-relaxed text-slate-100">
                  {content.data.value}
                </pre>
              )}
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
