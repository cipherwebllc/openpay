'use client';

// 出品者の「あなたの登録」一覧 (SIWE 済みかつ 1 件以上のときだけ描画)。編集・削除 (確認つき)・
// スニペット再表示・hidden (要対応) の案内。状態は useDiscoveryOwner / useDiscoveryDisplay から受け取る。

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Check, ChevronDown, Code2, Copy, Pencil, Trash2 } from 'lucide-react';
import { env } from '@/lib/env';
import { REVERIFY_AUTH_HIDE_THRESHOLD } from '@/lib/x402/reverifyThresholds';
import { isHttpsUrl } from '@/lib/typeGuards';
import type { DiscoveryDisplay } from './discoveryDisplay';
import type { OwnedResource } from './discoveryTypes';
import { PaywallSnippet } from './PaywallSnippet';
import type { DiscoveryOwner } from './useDiscoveryOwner';

// hidden の理由が「ゲートを確認できなかった」ではなく「再検証を締め出された」ケース。
// ゲートのスニペットを見せても直らない (出品側が probe を通す必要がある) ので文面を分ける。
function isAuthBlockedHide(resource: OwnedResource): boolean {
  return (
    (resource.verification?.authFailures ?? 0) >= REVERIFY_AUTH_HIDE_THRESHOLD
  );
}

export function DiscoveryOwnedResources({
  owner,
  display,
  isSignedIn,
}: {
  owner: DiscoveryOwner;
  display: DiscoveryDisplay;
  isSignedIn: boolean;
}) {
  const t = useTranslations('Facilitator');
  const locale = useLocale();
  const {
    owned, snippetOpenId, setSnippetOpenId, confirmDeleteId, setConfirmDeleteId, deleteMutation,
    onEdit, setNotice,
  } = owner;
  const { cardHead, copiedKey, copyText } = display;
  const resourceActionCls =
    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900';
  const hiddenCount = owned.filter((r) => r.hidden === true).length;
  const liveCount = owned.length - hiddenCount;

  return isSignedIn && owned.length > 0 ? (
      <>
        {/* あなたの登録 (owner のみ・編集/削除)。見出しの横に公開中 / 非表示の件数を出し、
            要対応の有無を一目でわかるようにする (2026-10-21 磨き上げ)。 */}
        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-base font-bold text-slate-900">{t('yourResourcesTitle')}</h3>
            <p className="flex items-center gap-3 text-xs font-semibold tabular-nums">
              <span className="inline-flex items-center gap-1.5 text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                {t('ownedLiveCount', { count: liveCount })}
              </span>
              {hiddenCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-amber-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                  {t('ownedHiddenCount', { count: hiddenCount })}
                </span>
              )}
            </p>
          </div>
          {/* Arc に同意した出品があれば、Arc の売上 (受取アドレスの Gateway 残高) を受け取るページへ。 */}
          {env.enableArcPayoutUi && owned.some((r) => r.usdc?.arc === true) && (
            <Link
              href={`/${locale}/discovery/arc-payout`}
              prefetch={false}
              className="mt-1.5 inline-flex text-xs font-semibold text-brand underline-offset-2 hover:text-brand-dark hover:underline"
            >
              {t('arcPayoutCta')}
            </Link>
          )}
          <ul className="mt-3 space-y-3">
            {owned.map((r) => {
              const hidden = r.hidden === true;
              const authBlocked = isAuthBlockedHide(r);
              return (
              <li
                key={r.id}
                className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70"
              >
                {cardHead({
                  category: r.category,
                  priceNode: (
                    <span className="shrink-0 text-right text-[15px] font-bold tabular-nums text-slate-900">
                      {r.priceJpyc} JPYC
                      {r.usdc && (
                        <>
                          <span className="mt-0.5 block text-[11px] font-semibold text-sky-700">
                            {t('usdcAltMeta', { price: r.usdc.priceUsd })}
                          </span>
                          <span className="block text-[11px] font-normal text-slate-500">
                            {t('usdcNoFee')}
                          </span>
                        </>
                      )}
                    </span>
                  ),
                  title: r.title,
                  trigger: r.trigger,
                  description: r.description,
                  usdc: r.usdc,
                  license: r.license,
                  url: r.url,
                  copyKey: `owned-${r.id}`,
                  docsUrl: r.docsUrl && isHttpsUrl(r.docsUrl) ? r.docsUrl : null,
                  badge: (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
                        hidden ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-700'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${hidden ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        aria-hidden
                      />
                      {hidden ? t('ownedStatusHidden') : t('ownedStatusLive')}
                    </span>
                  ),
                })}
                {/* 非表示の理由は 1 文。直し方 (ゲートのスニペット) は開いたときだけ。締め出しが理由のときは
                    スニペットを出しても直らない (出品側が再検証のアクセスを許可する必要がある)。 */}
                {hidden && (authBlocked || r.paywallSnippet) ? (
                  <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 ring-1 ring-inset ring-amber-200">
                    <p className="flex items-start gap-2 text-[13px] leading-relaxed text-amber-900">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      <span>{authBlocked ? t('requiresActionAuthBody') : t('requiresActionBody')}</span>
                    </p>
                    {!authBlocked && r.paywallSnippet ? (
                      <details className="group mt-1.5 pl-6">
                        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-amber-900 hover:underline">
                          {t('fixHowTo')}
                          <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" aria-hidden />
                        </summary>
                        <PaywallSnippet
                          snippet={r.paywallSnippet}
                          copyKey={`repair-snippet-${r.id}`}
                          copied={copiedKey === `repair-snippet-${r.id}`}
                          onCopy={copyText}
                          title={t('snippetTitle')}
                          copyLabel={t('copy')}
                          copiedLabel={t('copied')}
                        />
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {snippetOpenId === r.id && r.paywallSnippet ? (
                  <div className="relative mt-3 border-t border-slate-100 pt-3">
                    <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 pr-24 text-xs leading-relaxed text-slate-100">
                      {r.paywallSnippet}
                    </pre>
                    <button
                      type="button"
                      onClick={() => copyText(`owned-snippet-${r.id}`, r.paywallSnippet ?? '')}
                      className="absolute right-2 top-5 inline-flex items-center gap-1.5 rounded-md bg-slate-700 px-2 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600"
                    >
                      {copiedKey === `owned-snippet-${r.id}` ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden />
                      )}
                      <span>
                        {copiedKey === `owned-snippet-${r.id}` ? t('copied') : t('copy')}
                      </span>
                    </button>
                  </div>
                ) : null}
                {confirmDeleteId === r.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
                    <span className="text-sm text-slate-600">{t('deleteConfirm')}</span>
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(r.id)}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                    >
                      {t('deleteConfirmCta')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-xs font-medium text-slate-500 hover:underline"
                    >
                      {t('keepCta')}
                    </button>
                  </div>
                ) : (
                  <div className="-mx-1.5 mt-3 flex items-center gap-1 border-t border-slate-100 pt-2">
                    <button
                      type="button"
                      onClick={() => setSnippetOpenId(snippetOpenId === r.id ? null : r.id)}
                      aria-expanded={snippetOpenId === r.id}
                      className={resourceActionCls}
                    >
                      <Code2 className="h-3.5 w-3.5" aria-hidden />
                      {t('showSnippet')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(r)}
                      className={resourceActionCls}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      {t('editCta')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(r.id);
                        setNotice(null);
                      }}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {t('deleteCta')}
                    </button>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        </section>
      </>
    ) : null;
}
