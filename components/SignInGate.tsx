'use client';

// サインインの入口 (受注・モバイル注文の公開・@handle・質問箱・デジタル商品で共通・2026-10 磨き上げ P1)。
// 未接続なら接続ボタン、接続済みならサインインボタン、失敗したら赤の 1 行。見た目と言葉を全タブで揃える。
// 署名される文面 (statement) は呼び出し側のまま受け取る (SIWE の流れと署名内容は変えない)。

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@/components/ConnectButton';
import { useSiweSession } from '@/hooks/useSiweSession';

export function SignInGate({
  statement,
  cta,
  prompt,
  className = '',
}: {
  /** 署名される SIWE メッセージの文面 (呼び出し側の i18n をそのまま)。 */
  statement: string;
  /** サインインで何ができるかを言うボタンの文言 (例「サインインして公開」)。 */
  cta: string;
  /** 何のためにサインインするかの 1 行 (任意・見出しや説明が既にあれば省く)。 */
  prompt?: ReactNode;
  className?: string;
}) {
  const t = useTranslations('SignInGate');
  const { isConnected, address } = useAccount();
  const { signIn, isSigningIn, signInError } = useSiweSession();
  // 未接続のときもボタンは 1 つ (押すとウォレットの一覧を開く)。同じページに入口が 2 つあっても一覧を並べない。
  const [showWallets, setShowWallets] = useState(false);
  return (
    <div className={className}>
      {prompt ? <p className="text-sm text-slate-600">{prompt}</p> : null}
      {isConnected && address ? (
        <>
          <button
            type="button"
            // 拒否理由は hook の signInError で表示し、click handler の未処理 rejection だけを断つ。
            onClick={() => void signIn(statement).catch(() => undefined)}
            disabled={isSigningIn}
            className={`${prompt ? 'mt-3 ' : ''}inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-transform hover:bg-brand-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {isSigningIn ? t('signing') : cta}
          </button>
          {signInError ? <p className="mt-2 text-xs text-red-600">{t('error')}</p> : null}
        </>
      ) : (
        // 未接続では signIn が wallet_not_connected で失敗するだけなので、先に接続へ誘導する
        // (ConnectButton はウォレットの数だけボタンを並べるので、押したときだけ開く)。
        <div className={prompt ? 'mt-3' : ''}>
          {showWallets ? (
            <ConnectButton variant="secondary" />
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowWallets(true)}
                className="inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-transform hover:bg-brand-dark active:scale-[0.98]"
              >
                {t('connect')}
              </button>
              <p className="mt-2 text-xs text-slate-500">{t('connectFirst')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
