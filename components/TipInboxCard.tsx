'use client';

// /me の「受け取った応援・メッセージ」カード (計測・通知レイヤー裁定 2026-08-08 ①-a)。
// 既存の受信箱 (GET /api/tip-messages・SIWE) を /me から 1 タップで見えるようにし、
// 未読バッジを付ける。未読状態は端末ローカル (localStorage の lastSeen 1 値) —
// 表示専用のヒントであり、真実 (メッセージ本体) は従来どおり KV/API 側。
// サインイン前はカードだけ出し、タップで既存の受信箱 (/create?tab=tip) へ送る。

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MessageCircleHeart } from 'lucide-react';
import { formatUnits } from 'viem';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';

type TipInboxItem = {
  from: string;
  amountWei: string;
  chainId: number;
  txHash: string;
  message: string;
  ts: number;
};

function lastSeenKey(address: string): string {
  return `openpay:tip-inbox-seen:${address.toLowerCase()}`;
}

function readLastSeen(address: string): number {
  try {
    const raw = window.localStorage.getItem(lastSeenKey(address));
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    // localStorage 不可 (プライベートモード等) は「全部未読」に倒すだけで機能は保つ。
    return 0;
  }
}

function writeLastSeen(address: string, ts: number): void {
  try {
    window.localStorage.setItem(lastSeenKey(address), String(ts));
  } catch {
    // 保存失敗は次回も未読表示になるだけ (害なし)。
  }
}

async function fetchTipInbox(): Promise<TipInboxItem[]> {
  const res = await fetch('/api/tip-messages', { cache: 'no-store' });
  if (!res.ok) throw new Error(`tip_inbox_${res.status}`);
  const body = (await res.json()) as { items?: TipInboxItem[] };
  return Array.isArray(body.items) ? body.items : [];
}

function formatJpyc(amountWei: string): string {
  try {
    const value = formatUnits(BigInt(amountWei), 18);
    return `${value} JPYC`;
  } catch {
    return '';
  }
}

export function TipInboxCard() {
  if (!env.enableTipMessage) return null;
  return <EnabledTipInboxCard />;
}

function EnabledTipInboxCard() {
  const t = useTranslations('MePage');
  const locale = useLocale();
  const { isSignedIn, sessionAddress } = useSiweSession();
  const [expanded, setExpanded] = useState(false);
  const [lastSeen, setLastSeen] = useState(0);

  useEffect(() => {
    if (sessionAddress) setLastSeen(readLastSeen(sessionAddress));
  }, [sessionAddress]);

  const inbox = useQuery({
    queryKey: ['tip-inbox', sessionAddress],
    queryFn: fetchTipInbox,
    enabled: isSignedIn && !!sessionAddress,
    staleTime: 30_000,
    retry: 1,
  });

  const items = useMemo(() => inbox.data ?? [], [inbox.data]);
  const unread = useMemo(
    () => items.filter((item) => item.ts > lastSeen).length,
    [items, lastSeen],
  );

  const openList = () => {
    setExpanded((current) => {
      const next = !current;
      // 一覧を開いたら既読 (端末ローカルのヒント)。閉じる操作では動かさない。
      if (next && sessionAddress && items.length > 0) {
        const newest = Math.max(...items.map((item) => item.ts));
        writeLastSeen(sessionAddress, newest);
        setLastSeen(newest);
      }
      return next;
    });
  };

  const cardClass =
    'rounded-2xl border border-slate-200/80 bg-white shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)]';
  const headClass =
    'flex w-full items-center gap-4 px-5 py-4 text-left transition-all';

  // サインイン前: 既存の受信箱 (/create?tab=tip) への静的カード。
  if (!isSignedIn) {
    return (
      <Link
        href={`/${locale}/create?tab=tip`}
        prefetch={false}
        className={`${cardClass} ${headClass} hover:-translate-y-0.5 hover:border-brand/30`}
      >
        <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-rose-50">
          <MessageCircleHeart className="h-5 w-5 text-rose-500" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-slate-900">
            {t('tipInbox.title')}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
            {t('tipInbox.signInDesc')}
          </span>
        </span>
        <ChevronRight
          className="h-4 w-4 flex-shrink-0 text-slate-400"
          aria-hidden
        />
      </Link>
    );
  }

  return (
    <div className={cardClass}>
      <button type="button" onClick={openList} className={headClass}>
        <span className="relative grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-rose-50">
          <MessageCircleHeart className="h-5 w-5 text-rose-500" aria-hidden />
          {unread > 0 ? (
            <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white">
              {unread}
            </span>
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-slate-900">
            {t('tipInbox.title')}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
            {inbox.isError
              ? t('tipInbox.loadError')
              : items.length === 0
                ? t('tipInbox.empty')
                : unread > 0
                  ? t('tipInbox.unread', { count: unread })
                  : t('tipInbox.allRead', { count: items.length })}
          </span>
        </span>
        <ChevronRight
          className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
      </button>
      {expanded && items.length > 0 ? (
        <ul className="space-y-3 border-t border-slate-100 px-5 py-4">
          {items.slice(0, 5).map((item) => (
            <li key={`${item.txHash}:${item.ts}`} className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-bold text-slate-900">
                  {formatJpyc(item.amountWei)}
                </span>
                <span className="text-xs text-slate-400">
                  {new Date(item.ts).toLocaleDateString(locale, {
                    month: 'numeric',
                    day: 'numeric',
                  })}
                </span>
              </div>
              {item.message ? (
                <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-slate-600">
                  {item.message}
                </p>
              ) : null}
            </li>
          ))}
          <li>
            <Link
              href={`/${locale}/create?tab=tip`}
              prefetch={false}
              className="text-xs font-semibold text-brand underline-offset-2 hover:underline"
            >
              {t('tipInbox.openAll')} →
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
