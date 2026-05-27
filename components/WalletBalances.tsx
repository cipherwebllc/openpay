'use client';

// 接続ウォレットの JPYC / USDC 保有残高を、保有 (非ゼロ) のあるチェーンだけ
// トークン別グループで表示する。/scan ページの「ウォレットの状態」内に置き、
// 支払い前に「どのチェーンに何を持っているか」を把握できるようにする。
//
// 取得失敗 (RPC timeout 等) の chain は表示から除外し (非ブロッキング)、1 件でも
// 失敗があれば控えめな注記を出す。残高表示は CrossChainSourceChooser の行表示を踏襲。

import NextImage from 'next/image';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useWalletTokenBalances } from '@/hooks/useWalletTokenBalances';
import { chainLogoPathForId, chainNameForId } from '@/lib/chains';
import type { TokenChainBalance } from '@/lib/walletBalances';
import type { TokenSymbol } from '@/lib/tokens';

// グループ表示順 (USDC を先頭、JPYC を後)。
const TOKEN_ORDER: readonly TokenSymbol[] = ['usdc', 'jpyc'];

// atomic 残高を表示用文字列に整形する。USDC (6 decimals) は小数 2 桁固定、
// JPYC (18 decimals) は整数 (yen)。Number 変換の精度欠落を避けるため formatUnits の
// 文字列を直接加工し、整数部は桁区切りする。
function formatBalance(raw: bigint, decimals: number): string {
  const [intPart, fracPart = ''] = formatUnits(raw, decimals).split('.');
  const grouped = BigInt(intPart).toLocaleString('en-US');
  const maxFrac = decimals <= 6 ? 2 : 0;
  if (maxFrac === 0) return grouped;
  return `${grouped}.${(fracPart + '00').slice(0, maxFrac)}`;
}

export function WalletBalances() {
  const t = useTranslations('Scan');
  const { data, isLoading } = useWalletTokenBalances();

  if (isLoading) {
    return <p className="mt-3 text-xs text-slate-500">{t('balancesLoading')}</p>;
  }
  if (!data) return null;

  const nonZero = data.filter((b) => b.status === 'ok' && b.balance > 0n);
  const hadError = data.some((b) => b.status === 'error');

  if (nonZero.length === 0) {
    return (
      <div className="mt-3 space-y-1">
        <p className="text-xs text-slate-500">{t('balancesEmpty')}</p>
        {hadError && (
          <p className="text-[11px] text-amber-700">
            {t('balancesPartialError')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs font-semibold text-slate-700">{t('balancesTitle')}</p>
      {TOKEN_ORDER.map((symbol) => {
        const rows = nonZero
          .filter((b) => b.deployment.symbol === symbol)
          .sort((a, b) =>
            a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0,
          );
        if (rows.length === 0) return null;
        return (
          <div key={symbol} className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {rows[0].deployment.displaySymbol}
            </p>
            <ul className="space-y-1">
              {rows.map((row) => (
                <BalanceRow key={row.deployment.chainId} row={row} />
              ))}
            </ul>
          </div>
        );
      })}
      {hadError && (
        <p className="text-[11px] text-amber-700">{t('balancesPartialError')}</p>
      )}
    </div>
  );
}

function BalanceRow({ row }: { row: TokenChainBalance }) {
  const chainName =
    chainNameForId(row.deployment.chainId) ?? `chain ${row.deployment.chainId}`;
  // logo は未整備 chain (World Chain / Sonic / Sei / HyperEVM) で undefined。
  // その場合は chain 名のみで描画する (CrossChainSourceChooser と同挙動)。
  const logoPath = chainLogoPathForId(row.deployment.chainId);
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="flex items-center gap-2 text-slate-600">
        {logoPath && (
          <NextImage
            src={logoPath}
            alt=""
            width={18}
            height={18}
            className="h-[18px] w-[18px] shrink-0"
            aria-hidden
          />
        )}
        <span>{chainName}</span>
      </span>
      <span className="font-medium tabular-nums text-slate-900">
        {formatBalance(row.balance, row.deployment.decimals)}
      </span>
    </li>
  );
}
