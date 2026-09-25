'use client';

// 出品 (登録/編集) カード。未接続 → 接続ボタン、未サインイン → サインインボタン、サインイン済み → フォーム。
// 登録が 1 件以上あれば details に畳む。状態は useDiscoveryOwner / useDiscoveryDisplay から受け取る。

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown, Plus, Wallet } from 'lucide-react';
import type { useSiweSession } from '@/hooks/useSiweSession';
import { ConnectButton } from '@/components/ConnectButton';
import { env } from '@/lib/env';
import type { DiscoveryDisplay } from './discoveryDisplay';
import type { DiscoveryOwner } from './useDiscoveryOwner';

function DiscoveryRegistrationLoading() {
  const t = useTranslations('Facilitator');
  return <p role="status" className="mt-4 text-sm text-slate-500">{t('loading')}</p>;
}

const DiscoveryRegistrationForm = dynamic(
  () => import('./DiscoveryRegistrationForm').then((m) => m.DiscoveryRegistrationForm),
  {
    // ブラウザーの接続・SIWE 認証後だけ使うフォームなので SSR しない。
    // 外枠と接続/サインインボタンはこの eager な節に残し、入口を遅延させない。
    ssr: false,
    loading: DiscoveryRegistrationLoading,
  },
);

export function DiscoveryRegistrationSection({
  owner,
  display,
  maxResourcesPerMerchant,
  address,
  isConnected,
  isSignedIn,
  signIn,
  isSigningIn,
}: {
  owner: DiscoveryOwner;
  display: DiscoveryDisplay;
  maxResourcesPerMerchant: number;
  address: string | undefined;
  isConnected: boolean;
  isSignedIn: boolean;
  signIn: ReturnType<typeof useSiweSession>['signIn'];
  isSigningIn: boolean;
}) {
  const t = useTranslations('Facilitator');
  const locale = useLocale();
  const {
    formOpen, setFormOpen, registrationRef, editId, created, notice, error, owned,
  } = owner;
  const autoOpen = owned.length === 0 || editId !== null || created !== null || notice !== null || error !== null;
  // owned>0 のときはフォーム全体を details に畳み、summary が見出しを兼ねる (内側の見出しは出さない)。
  const collapsible = owned.length > 0;
  const registrationContent = (
      <div>
        <div className="flex items-start gap-3">
          {!collapsible && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Plus className="h-5 w-5" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            {!collapsible && (
              <h3 className="text-base font-bold text-slate-900">
                {editId ? t('editTitle') : t('registerTitle')}
              </h3>
            )}
            <p className={`${collapsible ? '' : 'mt-0.5 '}text-sm leading-relaxed text-slate-500`}>
              {t('registerSubtitle')}
            </p>
            {/* 発見面の明示: USDC 併売の有無に合わせて掲載先を案内する。 */}
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              {env.enableX402DualRailUi
                ? t('listingDiscoveryNoteDualRail')
                : t('listingDiscoveryNote')}
            </p>
            {/* 出品の詳細手順+実売事例は /guide/sell が持つ (フォームは要点のみ)。 */}
            <Link
              href={`/${locale}/guide/sell`}
              prefetch={false}
              className="mt-1.5 inline-flex text-xs font-medium text-brand underline-offset-2 hover:text-brand-dark hover:underline"
            >
              {t('sellGuideCta')}
            </Link>
          </div>
        </div>

        {!isConnected ? (
          <div className="mt-4 flex flex-col gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2">
              <Wallet className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <span>{t('connectPrompt')}</span>
            </p>
            <ConnectButton />
          </div>
        ) : !isSignedIn ? (
          <button
            type="button"
            onClick={() => void signIn(t('signInStatement'))}
            disabled={isSigningIn}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0 disabled:opacity-50 disabled:hover:translate-y-0"
          >
            <Wallet className="h-4 w-4" aria-hidden />
            {isSigningIn ? t('signingIn') : t('signInCta')}
          </button>
        ) : (
          <DiscoveryRegistrationForm
            owner={owner}
            display={display}
            maxResourcesPerMerchant={maxResourcesPerMerchant}
            address={address}
          />
        )}
      </div>
  );

  return (
    <section ref={registrationRef} className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
      {collapsible ? (
        <details
          className="group/registration"
          open={formOpen ?? autoOpen}
          onToggle={(e) => setFormOpen(e.currentTarget.open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-3 text-base font-bold text-slate-900">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Plus className="h-5 w-5" aria-hidden />
            </span>
            {editId ? t('editTitle') : t('registerNewTitle')}
            <ChevronDown className="ml-auto h-4 w-4 shrink-0 transition group-open/registration:rotate-180" aria-hidden />
          </summary>
          <div className="mt-4">{registrationContent}</div>
        </details>
      ) : registrationContent}
    </section>
  );
}
