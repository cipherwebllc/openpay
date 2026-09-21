'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, ExternalLink } from 'lucide-react';
import type { AgentPageContent } from '@/lib/agentPage';
import type { AgentActivityItem, AgentActivityResponse } from '@/lib/agent/activityTypes';
import { formatJpyc, shortAddress, sumOutgoing } from '@/lib/agent/activityView';
import { blockExplorerUrl } from '@/lib/chains';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

type Props = {
  address: `0x${string}`;
  locale: string;
  c: AgentPageContent['activity'];
  refreshKey: number;
};

export function AgentActivity(props: Props) {
  const deployment = defaultDeploymentForSymbol('jpyc');
  const address = props.address.toLowerCase() as `0x${string}`;
  // 旧アドレスの表示・更新タイマーが次のウォレットへ波及しないよう、表示状態もアドレスごとに分ける。
  return <ActivityForAddress key={`${deployment.chainId}:${address}`} {...props} address={address} chainId={deployment.chainId} tokenAddress={deployment.address} />;
}

function ActivityForAddress({ address, locale, c, refreshKey, chainId, tokenAddress }: Props & { chainId: number; tokenAddress: string }) {
  const [filter, setFilter] = useState<'all' | 'in' | 'out'>('all');
  const [visibleCount, setVisibleCount] = useState(10);
  const [refreshing, setRefreshing] = useState(false);
  const previousRefreshKey = useRef(refreshKey);
  const supported = chainId === 137;
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['agent-activity', chainId, address],
    queryFn: async ({ signal }): Promise<AgentActivityResponse> => {
      const response = await fetch(`/api/agent/activity?address=${address}`, { signal });
      try {
        return await response.json() as AgentActivityResponse;
      } catch {
        // CDN 等の非 JSON 応答が履歴欄の描画や残高・入金操作へ波及しないよう、固定の失敗状態にする。
        return { ok: false, reason: 'upstream' };
      }
    },
    enabled: supported,
    retry: 1,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    if (!supported) return;
    setRefreshing(true);
    let attempts = 0;
    const timer = window.setInterval(() => {
      void refetch();
      attempts += 1;
      if (attempts === 3) {
        window.clearInterval(timer);
        setRefreshing(false);
      }
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [refreshKey, refetch, supported]);

  const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600';
  const explorerBase = blockExplorerUrl(chainId);
  // explorer が未定義のチェーンで "undefined/tx/…" という壊れたリンクを開かせない (lib/chains.ts の txExplorerUrl と同じ方針)。
  const explorerLink = explorerBase ? <a href={`${explorerBase}/token/${tokenAddress}?a=${address}`} target="_blank" rel="noopener noreferrer" className={`underline ${focus}`}>{c.explorerLink}</a> : null;
  const result = supported && !isError && data?.ok === true && Array.isArray(data.items) ? data : undefined;
  // 想定外の形 (中継が返す {"error":…} 等) を「何も出さない」にしない: 読めなかったことを明示する。
  const failure = !supported ? 'unsupported_chain' : isError ? 'upstream' : data?.ok === false ? data.reason : !isPending && !result ? 'upstream' : undefined;
  const filtered = result?.items.filter((item) => filter === 'all' || item.direction === filter) ?? [];
  const rows = filtered.slice(0, visibleCount);
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  function date(item: AgentActivityItem) {
    // 行ごとに「取引を見る」を並べると視覚的にうるさい。日時そのものを取引へのリンクにする
    // (リンク名 = 可視テキストの日時。掟 8: 可視テキストなしの名前を付けない)。
    const time = <time dateTime={new Date(item.timestamp * 1000).toISOString()}>{formatter.format(item.timestamp * 1000)}</time>;
    if (!explorerBase) return time;
    return <a href={`${explorerBase}/tx/${item.hash}`} target="_blank" rel="noopener noreferrer" title={c.viewTx} className={`inline-flex items-center gap-1 py-1.5 text-slate-700 underline decoration-slate-400 underline-offset-2 hover:text-emerald-700 ${focus}`}>{time}<ExternalLink size={12} aria-hidden /></a>;
  }
  function direction(item: AgentActivityItem) {
    const Icon = item.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
    return <span className="inline-flex items-center gap-1 align-middle"><Icon size={16} aria-hidden />{item.direction === 'in' ? c.filterIn : c.filterOut}</span>;
  }
  function counterparty(item: AgentActivityItem) {
    return <span className="inline-flex flex-wrap items-center gap-1">{item.viaOpenPay ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{c.viaOpenPay}</span> : null}<span className="font-mono">{shortAddress(item.counterparty)}</span></span>;
  }
  function amount(item: AgentActivityItem) {
    return <span className={`break-all tabular-nums ${item.direction === 'in' ? 'text-emerald-700' : 'text-slate-900'}`}>{item.direction === 'in' ? '+' : '−'}{formatJpyc(BigInt(item.valueAtomic))} JPYC</span>;
  }

  return (
    <section className="mt-6 min-w-0 border-t border-slate-200 pt-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h3 className="text-lg font-bold text-slate-900">{c.title}</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:text-right">
          {([[c.stat24h, 86_400], [c.stat7d, 604_800]] as const).map(([label, windowSec]) => {
            const stat = result ? sumOutgoing(result.items, result.asOf, windowSec, result.truncated) : undefined;
            return <div key={label} className="min-w-0"><dt className="text-slate-500">{label}</dt><dd className="mt-0.5 break-all text-base font-semibold tabular-nums text-slate-900">{stat?.complete ? `${formatJpyc(stat.totalAtomic)} JPYC` : '—'}</dd>{stat && !stat.complete ? <dd className="mt-1 text-slate-500">{c.statsPartial}</dd> : null}</div>;
          })}
        </dl>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">{c.publicNote}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {(['all', 'in', 'out'] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} className={`min-h-9 rounded-full px-3.5 py-1.5 text-xs font-medium ${filter === value ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'} ${focus}`} onClick={() => { setFilter(value); setVisibleCount(10); }}>{value === 'all' ? c.filterAll : value === 'in' ? c.filterIn : c.filterOut}</button>)}
      </div>
      {refreshing ? <p role="status" className="mt-3 text-xs text-slate-500">{c.refreshing}</p> : null}
      {failure ? <p className="mt-4 text-sm text-slate-600">{failure === 'unsupported_chain' ? c.unsupported : failure === 'busy' || failure === 'rate_limited' ? c.busy : c.error} {explorerLink}</p> : isPending ? (
        <div aria-busy="true" className="mt-4 space-y-3"><p className="text-sm text-slate-500">{c.loading}</p>{[0, 1, 2].map((key) => <div key={key} aria-hidden className="h-12 animate-pulse rounded-lg bg-slate-100" />)}</div>
      ) : result ? (
        <>
          {rows.length === 0 ? (
            // 「取引ゼロ」と言うのは上流が本当に 0 件のときだけ。0 円の送信 (除外対象) が直近 50 件を埋めたアドレスで、
            // 押し出された本物の入出金を「ありません」と断言しない。
            <p className="mt-4 text-sm text-slate-600">{result.items.length > 0 ? c.filterEmpty : result.rawCount === 0 ? c.empty : <>{c.hiddenOnly} {explorerLink}</>}</p>
          ) : (
            <>
              <table className="mt-4 hidden w-full table-fixed text-left text-xs sm:table">
                <thead className="text-slate-500"><tr>{[c.colDate, c.colType, c.colCounterparty, c.colAmount].map((label) => <th key={label} scope="col" className={`px-2 py-2 font-medium ${label === c.colAmount ? 'text-right' : ''}`}>{label}</th>)}</tr></thead>
                <tbody>{rows.map((item) => <tr key={item.key} className="border-t border-slate-100 align-middle"><td className="break-words px-2 py-2">{date(item)}</td><td className="px-2 py-3">{direction(item)}</td><td className="break-words px-2 py-3">{counterparty(item)}</td><td className="px-2 py-3 text-right">{amount(item)}</td></tr>)}</tbody>
              </table>
              <ul className="mt-4 divide-y divide-slate-100 sm:hidden">
                {rows.map((item) => <li key={item.key} className="space-y-2 py-3 text-xs">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><span><span className="sr-only">{c.colType}: </span>{direction(item)}</span><span className="min-w-0 break-all"><span className="sr-only">{c.colAmount}: </span>{amount(item)}</span></div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-slate-600"><span><span className="sr-only">{c.colDate}: </span>{date(item)}</span><span><span className="sr-only">{c.colCounterparty}: </span>{counterparty(item)}</span></div>
                </li>)}
              </ul>
            </>
          )}
          {filtered.length > visibleCount ? <button type="button" className={`mt-3 min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm ${focus}`} onClick={() => setVisibleCount((count) => count + 10)}>{c.more}</button> : null}
          {result.truncated ? <p className="mt-3 text-xs text-slate-500">{c.truncatedNote} {explorerLink}</p> : null}
        </>
      ) : null}
    </section>
  );
}
