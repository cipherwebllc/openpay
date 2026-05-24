'use client';

// CrossChainSourceChooser — buyer が「どの chain の USDC で支払うか」を
// 明示選択する UI。直前まで CrossChainHint が auto-decision の 1 経路だけ
// 提示していたが、buyer が複数 chain に USDC を持つケース (例: Polygon と
// Avalanche の両方) で「能動的に source を選びたい」需要に対応する。
//
// データソース:
// - useCrossChainPayment hook の `pathOptions` (enumeratePathOptions 経由)
// - 各 PathOption に kind / sourceChainId / sourceBalanceAtomic / serviceFeeAtomic /
//   estimatedGasUnits / gasOnChainId / etaSeconds を含む
//
// 表示要素 (option ごと):
// - chain 名 (chainNameForId、Avalanche/Unichain 等の buyer-only も解決可能)
// - balance (USDC)
// - path badge (direct / gateway / cctp-v2) + ETA
// - 手数料内訳: USDC service fee + native gas (token symbol で表示、USD 換算なし)
//
// 注: native gas を JPY/USD 換算するとレート source の運用負担が増えるため、
// MVP では gas units + token symbol で表示。実機運用後に簡易換算 (env で
// approximate rate を設定) を加える余地は残す。

import NextImage from 'next/image';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import type { PathOption, PathKind } from '@/lib/crossChain/pathEnumerator';
import {
  chainLogoPathForId,
  chainNameForId,
  nativeSymbolForChainId,
} from '@/lib/chains';

export interface CrossChainSourceChooserProps {
  /** enumeratePathOptions 結果。空 = balance なし、UI は出ない */
  options: PathOption[];
  /** 現在選択中の option key (= PathOption.key)。null = 未選択 (default を初期に
   *  caller 側で options[0]?.key と同期する想定) */
  selectedKey: string | null;
  onSelect: (option: PathOption) => void;
  /** 必要 USDC 額 (atomic、6 decimals) */
  requiredAtomic: bigint;
  /** USDC decimals (常に 6) */
  displayDecimals: number;
}

export function CrossChainSourceChooser(props: CrossChainSourceChooserProps) {
  const t = useTranslations('CrossChainSourceChooser');

  if (props.options.length === 0) return null;

  return (
    <div className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm">
      <p className="font-semibold text-sky-900">{t('title')}</p>
      <p className="text-xs text-sky-700">
        {t('subtitle', {
          required: formatUnits(props.requiredAtomic, props.displayDecimals),
        })}
      </p>
      <ul className="space-y-2">
        {props.options.map((option) => {
          const isSelected = props.selectedKey === option.key;
          return (
            <li key={option.key}>
              <button
                type="button"
                onClick={() => props.onSelect(option)}
                aria-pressed={isSelected}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                  isSelected
                    ? 'border-sky-500 bg-white ring-2 ring-sky-200'
                    : 'border-slate-200 bg-white hover:border-sky-300'
                }`}
              >
                <OptionRow
                  option={option}
                  displayDecimals={props.displayDecimals}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OptionRow({
  option,
  displayDecimals,
}: {
  option: PathOption;
  displayDecimals: number;
}) {
  const t = useTranslations('CrossChainSourceChooser');
  const chainName =
    chainNameForId(option.sourceChainId) ?? `chain ${option.sourceChainId}`;
  // logo は supportedChains 全 8 chain で解決可 (merchant + buyer-only)。
  // 万一未対応 chainId なら logo 描画を skip (caller が chain 名 fallback で表示)。
  const logoPath = chainLogoPathForId(option.sourceChainId);
  const gasSymbol =
    nativeSymbolForChainId(option.gasOnChainId) ?? '';
  const balanceStr = formatUnits(option.sourceBalanceAtomic, displayDecimals);
  const feeStr = formatUnits(option.serviceFeeAtomic, displayDecimals);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold text-slate-900">
          {logoPath && (
            <NextImage
              src={logoPath}
              alt=""
              width={20}
              height={20}
              className="h-5 w-5 shrink-0"
              aria-hidden
            />
          )}
          <span>{chainName}</span>
        </span>
        <PathBadge kind={option.kind} />
      </div>
      <div className="mt-0.5 text-xs text-slate-600">
        {t('balance', { balance: balanceStr })}
      </div>
      <div className="mt-0.5 text-[11px] text-slate-500">
        {option.kind === 'direct'
          ? t('feeBreakdownDirect', { gasSymbol })
          : t('feeBreakdownCrossChain', {
              fee: feeStr,
              gasSymbol,
              eta: option.etaSeconds,
            })}
      </div>
    </div>
  );
}

function PathBadge({ kind }: { kind: PathKind }) {
  const t = useTranslations('CrossChainSourceChooser');
  // direct = 緑 (no fee、同 chain)、gateway = sky (高速)、cctp-v2 = amber (通常 cross-chain)
  const classes: Record<PathKind, string> = {
    direct: 'bg-emerald-100 text-emerald-700',
    gateway: 'bg-sky-100 text-sky-700',
    'cctp-v2': 'bg-amber-100 text-amber-700',
  };
  const labelKey: Record<PathKind, string> = {
    direct: 'pathBadgeDirect',
    gateway: 'pathBadgeGateway',
    'cctp-v2': 'pathBadgeCctpV2',
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${classes[kind]}`}
    >
      {t(labelKey[kind])}
    </span>
  );
}
