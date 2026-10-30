'use client';

// 受け取った応援メッセージの受信箱 (flag ON のときだけ親の TipEmbedGenerator が mount する)。取得と削除の
// query / mutation はこの component が持つ (分割前から別 component の局所 state)。

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useAccount } from 'wagmi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useSiweSession } from '@/hooks/useSiweSession';
import { SignInGate } from '@/components/SignInGate';
import { shortAddress } from '@/lib/format';

type TipMessageItem = {
  from: string;
  amountWei: string;
  chainId: number;
  txHash: string;
  message: string;
  ts: number;
};

async function fetchTipMessages(): Promise<TipMessageItem[]> {
  const res = await fetch('/api/tip-messages', { cache: 'no-store' });
  if (!res.ok) throw new Error(`tip_messages_http_${res.status}`);
  const json = (await res.json()) as { items?: unknown };
  if (!Array.isArray(json.items)) throw new Error('tip_messages_invalid_response');
  return json.items as TipMessageItem[];
}

async function deleteTipMessages(): Promise<void> {
  const res = await fetch('/api/tip-messages', {
    method: 'DELETE',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`tip_messages_delete_http_${res.status}`);
}

export function TipMessageInbox() {
  const t = useTranslations('TipEmbedGenerator');
  const tNav = useTranslations('Nav');
  const locale = useLocale();
  const { address } = useAccount();
  const { isSignedIn } = useSiweSession();
  const queryClient = useQueryClient();
  const queryKey = ['tip-messages', address] as const;
  const inbox = useQuery({
    queryKey,
    enabled: isSignedIn && address !== undefined,
    queryFn: fetchTipMessages,
  });
  const clearInbox = useMutation({
    mutationFn: deleteTipMessages,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );
  const items = inbox.data ?? [];

  return (
    // 見た目は上のカード (SectionCard) に揃える。data-testid を付けるため section は自前で書く。
    <section
      data-testid="tip-message-inbox"
      aria-labelledby="tip-inbox-heading"
      className="rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            id="tip-inbox-heading"
            className="flex items-center gap-2 text-sm font-semibold text-slate-700"
          >
            <Inbox className="h-4 w-4 text-slate-400" aria-hidden />
            {t('tipInboxTitle')}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {t('tipInboxDescription')}
          </p>
        </div>
        {isSignedIn && items.length > 0 ? (
          <button
            type="button"
            disabled={clearInbox.isPending}
            onClick={() => clearInbox.mutate()}
            className="shrink-0 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {clearInbox.isPending
              ? t('tipInboxDeleting')
              : t('tipInboxDeleteAll')}
          </button>
        ) : null}
      </div>

      {!isSignedIn ? (
        <SignInGate
          className="mt-3"
          statement={tNav('siweStatement')}
          // 何のためのサインインかは上の説明 (tipInboxDescription) が言っているので、案内の文は重ねない。
          cta={t('tipInboxSignInCta')}
        />
      ) : inbox.isLoading ? (
        <p className="mt-4 text-center text-sm text-slate-500">
          {t('tipInboxLoading')}
        </p>
      ) : inbox.isError ? (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>{t('tipInboxError')}</span>{' '}
          <button
            type="button"
            onClick={() => void inbox.refetch()}
            className="font-semibold underline hover:text-amber-950"
          >
            {t('tipInboxRetry')}
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="mt-3 rounded-xl bg-slate-50 px-4 py-4 text-center text-sm text-slate-500">
          {t('tipInboxEmpty')}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((item) => (
            <li
              key={`${item.chainId}:${item.txHash}`}
              className="rounded-xl border border-slate-200 bg-slate-50 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-slate-500">
                <span className="font-semibold text-slate-700">
                  {t('tipInboxAmount', {
                    amount: `${formatUnits(BigInt(item.amountWei), 18)} JPYC`,
                  })}
                </span>
                <time dateTime={new Date(item.ts).toISOString()}>
                  {dateFormatter.format(new Date(item.ts))}
                </time>
              </div>
              <p className="mt-1 font-mono text-xs text-slate-500">
                {t('tipInboxFrom', { address: shortAddress(item.from) })}
              </p>
              {/* 非公開本文は HTML として解釈せず、React text node のみで描画する。 */}
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
                {item.message}
              </p>
            </li>
          ))}
        </ul>
      )}

      {clearInbox.isError ? (
        <p className="mt-3 text-xs text-red-600">
          {t('tipInboxDeleteError')}
        </p>
      ) : null}
    </section>
  );
}
