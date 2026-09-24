'use client';

// 出品者の「あなたの登録」一覧 (SIWE 済みかつ 1 件以上のときだけ描画)。編集・削除 (確認つき)・
// スニペット再表示・hidden (要対応) の案内。状態は useDiscoveryOwner / useDiscoveryDisplay から受け取る。

import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Code2, Copy, Pencil, Trash2 } from 'lucide-react';
import { REVERIFY_AUTH_HIDE_THRESHOLD } from '@/lib/x402/reverifyThresholds';
import { isHttpsUrl, type DiscoveryDisplay } from './discoveryDisplay';
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
  const {
    owned, snippetOpenId, setSnippetOpenId, confirmDeleteId, setConfirmDeleteId, deleteMutation,
    onEdit, setNotice,
  } = owner;
  const { cardHead, expandedKeys, copiedKey, copyText } = display;
  const resourceActionCls =
    'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-brand hover:text-brand-dark';

  return isSignedIn && owned.length > 0 ? (
      <>
        {/* あなたの登録 (owner のみ・編集/削除) */}
        <section>
          <h3 className="text-base font-bold text-slate-900">{t('yourResourcesTitle')}</h3>
          <p className="mt-1 text-sm text-slate-500">{t('yourResourcesSubtitle')}</p>
          <ul className="mt-4 space-y-3">
            {owned.map((r) => (
              <li
                key={r.id}
                className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70"
              >
                {cardHead({
                  category: r.category,
                  priceNode: (
                    <span className="shrink-0 text-right text-sm font-bold text-slate-900">
                      {r.priceJpyc} JPYC
                      {r.usdc && (
                        <span className="block text-[11px] font-semibold text-sky-700">
                          {t('usdcFaceMeta', { price: r.usdc.priceUsd })}
                        </span>
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
                })}
                {(Boolean(r.license && expandedKeys.has(`owned-${r.id}`)) || Boolean(r.docsUrl && isHttpsUrl(r.docsUrl))) && (
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-relaxed text-slate-500">
                    {r.docsUrl && isHttpsUrl(r.docsUrl) && (
                      <a
                        href={r.docsUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="shrink-0 font-medium text-brand hover:text-brand-dark hover:underline"
                      >
                        {t('docsLink')}
                      </a>
                    )}
                    {r.license && expandedKeys.has(`owned-${r.id}`) && (
                      <span className="min-w-0">
                        {t('licenseMeta', { license: r.license })}
                      </span>
                    )}
                  </div>
                )}
                {r.hidden === true && (isAuthBlockedHide(r) || r.paywallSnippet) ? (
                  <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                    <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-200 px-2.5 py-1 text-xs font-bold text-amber-900">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      {t('requiresActionBadge')}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-amber-900">
                      {isAuthBlockedHide(r)
                        ? t('requiresActionAuthBody')
                        : t('requiresActionBody')}
                    </p>
                    {/* 締め出しが理由のときはゲートのスニペットを出しても直らない。 */}
                    {!isAuthBlockedHide(r) && r.paywallSnippet ? (
                      <PaywallSnippet
                        snippet={r.paywallSnippet}
                        copyKey={`repair-snippet-${r.id}`}
                        copied={copiedKey === `repair-snippet-${r.id}`}
                        onCopy={copyText}
                        title={t('snippetTitle')}
                        copyLabel={t('copy')}
                        copiedLabel={t('copied')}
                      />
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
                  <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      onClick={() => setSnippetOpenId(snippetOpenId === r.id ? null : r.id)}
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
                      className={`${resourceActionCls} border-red-200 text-red-600 hover:border-red-400 hover:text-red-700`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {t('deleteCta')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      </>
    ) : null;
}
