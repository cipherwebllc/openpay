'use client';

// オーナー (受取ウォレットで SIWE 済み) が「受注閲覧トークン」を発行/再発行/取消するパネル。
// 発行したトークンを /orders/{kitchen,hall,pickup}?t=<token> リンクとして店員端末に配る。トークンは
// 閲覧+進捗操作のみで送金不可 (資金鍵なし) → 店員に売上を抜かれない。enableOrderToken 時のみ表示。
// 設計: plans/restaurant-pos-roadmap.md Phase 5。

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { env } from '@/lib/env';

async function fetchToken(): Promise<string | null> {
  const res = await fetch('/api/order/token');
  if (!res.ok) throw new Error(`http_${res.status}`);
  const json = (await res.json()) as { token?: unknown };
  return typeof json.token === 'string' ? json.token : null;
}

export function OrderOperatorTokenPanel({
  sessionAddress,
}: {
  sessionAddress: string | null | undefined;
}) {
  const t = useTranslations('OrderToken');
  const locale = useLocale();
  const qc = useQueryClient();
  const key = ['order-token', sessionAddress] as const;
  const [copied, setCopied] = useState<string | null>(null);

  const tokenQ = useQuery({ queryKey: key, enabled: Boolean(sessionAddress), queryFn: fetchToken });
  const issue = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/order/token', { method: 'POST' });
      if (!res.ok) throw new Error(`http_${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const revoke = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/order/token', { method: 'DELETE' });
      if (!res.ok) throw new Error(`http_${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const token = tokenQ.data ?? null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const pickupEnabled =
    env.enableOrderFulfillment && env.enableOrderRelay && env.enableOrderPickup;
  const linkModes: Array<'kitchen' | 'hall' | 'pickup'> = ['kitchen', 'hall'];
  if (pickupEnabled) linkModes.push('pickup');
  const linkFor = (mode: 'kitchen' | 'hall' | 'pickup') =>
    `${origin}/${locale}/orders/${mode}?t=${token ?? ''}`;
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard 不可 (権限/非セキュアコンテキスト) は無視 — 入力欄から手動コピー可 */
    }
  };

  return (
    <details className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-slate-700">
        <KeyRound className="h-4 w-4" aria-hidden /> {t('heading')}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-slate-500">{t('description')}</p>
        {tokenQ.isError && <p className="text-xs text-red-600">{t('loadError')}</p>}

        {token ? (
          <>
            <div className="flex flex-col gap-1.5">
              {linkModes.map((m) => (
                <div key={m}>
                  <div className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-xs text-slate-500">{t(m)}</span>
                    <input
                      readOnly
                      value={linkFor(m)}
                      aria-label={t(m)}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
                    />
                    <button
                      type="button"
                      onClick={() => copy(m, linkFor(m))}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-brand px-2 py-1 text-xs font-semibold text-white hover:bg-brand-dark"
                    >
                      {copied === m ? (
                        <Check className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {t('copy')}
                    </button>
                  </div>
                  {m === 'pickup' ? (
                    <p className="ml-24 mt-1 pl-2 text-[11px] text-slate-500">
                      {t('pickupDescription')}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-amber-700">{t('shareWarning')}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => issue.mutate()}
                disabled={issue.isPending}
                className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t('rotate')}
              </button>
              <button
                type="button"
                onClick={() => revoke.mutate()}
                disabled={revoke.isPending}
                className="flex items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> {t('revoke')}
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => issue.mutate()}
            disabled={issue.isPending || tokenQ.isLoading}
            className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            <KeyRound className="h-3.5 w-3.5" aria-hidden /> {issue.isPending ? t('issuing') : t('issue')}
          </button>
        )}
        {(issue.isError || revoke.isError) && <p className="text-xs text-red-600">{t('opError')}</p>}
      </div>
    </details>
  );
}
