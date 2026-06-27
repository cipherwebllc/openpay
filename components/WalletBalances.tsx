'use client';

// 接続ウォレットの JPYC / USDC 保有残高を、保有 (非ゼロ) のあるチェーンだけ
// 1 行ずつ表示する。/scan ページの「ウォレットの状態」内に置き、支払い前に
// 「どのトークンを・どのチェーンに・いくら持っているか」を一目で把握できるようにする。
//
// 各行は「トークンアイコン (主役) + チェーンを右下に小バッジで重ね + チェーン名 +
// 金額 (大きく主役) + トークン記号」。金額を視覚の主役に据え、接続後に「いくら払えるか」が
// すぐ分かるようにする。並びは JPYC 先頭 → USDC (日本のホームトークン JPYC を上に)、
// 各トークン内は残高降順。
//
// 取得失敗 (RPC timeout 等) の chain は表示から除外し (非ブロッキング)、1 件でも
// 失敗があれば控えめな注記を出す。読み込み中はスケルトン (シマー) でアプリ的に。
//
// データ取得 (useWalletTokenBalances) と描画 (WalletBalancesView) を分離し、View は
// 純粋にデータを受け取って描く (プレビュー/テストから mock データで単体描画できる)。

import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useWalletTokenBalances } from '@/hooks/useWalletTokenBalances';
import { chainNameForId } from '@/lib/chains';
import { TokenOnChainBadge } from '@/components/AssetLogo';
import type { TokenChainBalance } from '@/lib/walletBalances';
import type { TokenSymbol } from '@/lib/tokens';

// 並び順 (JPYC を先頭、USDC を後)。日本のホームトークン JPYC を上に出す。
const TOKEN_ORDER: readonly TokenSymbol[] = ['jpyc', 'usdc'];

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
  const { data, isLoading } = useWalletTokenBalances();
  return <WalletBalancesView data={data} isLoading={isLoading} />;
}

// 純描画 (data を受け取るだけ)。プレビュー/テストで mock データから直接描ける。
export function WalletBalancesView({
  data,
  isLoading,
}: {
  data: TokenChainBalance[] | undefined;
  isLoading: boolean;
}) {
  const t = useTranslations('Scan');

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label={t('balancesLoading')}
        className="mt-3 space-y-2.5"
      >
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2.5">
              <span className="h-7 w-7 animate-pulse rounded-full bg-slate-200" />
              <span className="h-3 w-16 animate-pulse rounded bg-slate-200" />
            </span>
            <span className="h-4 w-20 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>
    );
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

  // フラット表示: JPYC 先頭 → USDC、各トークン内は残高降順。各行が
  // トークンアイコン + 記号で自己完結するため、トークン別グループ見出しは置かない。
  const rows = [...nonZero].sort((a, b) => {
    const oa = TOKEN_ORDER.indexOf(a.deployment.symbol);
    const ob = TOKEN_ORDER.indexOf(b.deployment.symbol);
    if (oa !== ob) return oa - ob;
    return a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0;
  });

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-semibold text-slate-700">{t('balancesTitle')}</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <BalanceRow
            key={`${row.deployment.symbol}-${row.deployment.chainId}`}
            row={row}
          />
        ))}
      </ul>
      {hadError && (
        <p className="text-[11px] text-amber-700">{t('balancesPartialError')}</p>
      )}
    </div>
  );
}

function BalanceRow({ row }: { row: TokenChainBalance }) {
  const { symbol, displaySymbol, chainId, decimals } = row.deployment;
  const chainName = chainNameForId(chainId) ?? `chain ${chainId}`;
  return (
    <li className="flex items-center justify-between gap-2 rounded-xl px-1 py-1.5">
      <span className="flex items-center gap-2.5 text-slate-500">
        <TokenOnChainBadge symbol={symbol} chainId={chainId} size={28} />
        <span className="text-sm">{chainName}</span>
      </span>
      <span className="tabular-nums">
        {/* 金額を主役に (大きく太字)。記号は小さく添える。 */}
        <span className="text-lg font-bold leading-none text-slate-900">
          {formatBalance(row.balance, decimals)}
        </span>{' '}
        <span className="text-xs font-semibold text-slate-400">{displaySymbol}</span>
      </span>
    </li>
  );
}
