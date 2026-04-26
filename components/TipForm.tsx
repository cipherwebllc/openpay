'use client';

import { useEffect, useMemo, useState } from 'react';
import { erc20Abi, formatUnits, parseUnits } from 'viem';
import { useAccount, useReadContract, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { calcBreakdown } from '@/lib/fee';
import { chainForToken } from '@/lib/chains';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getToken } from '@/lib/tokens';
import { DEFAULT_TIP_PRESETS, type TipParams } from '@/lib/url';

const DEFAULT_THEME_COLOR = '#2563eb';
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

export function TipForm({ params }: { params: TipParams }) {
  const token = getToken(params.token);
  const requiredChain = chainForToken(params.token);
  const presets =
    params.presets && params.presets.length > 0
      ? params.presets
      : DEFAULT_TIP_PRESETS[params.token];
  const themeColor = params.color ?? DEFAULT_THEME_COLOR;
  const creatorName = params.name ?? '';
  const creatorMessage = params.message ?? '';

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: saData, error: saError } = useSmartAccount(true);
  const gasless = useBatchPayment();

  const [selectedPreset, setSelectedPreset] = useState<string | null>(
    presets[0] ?? null,
  );
  const [customAmount, setCustomAmount] = useState('');
  const customSelected = selectedPreset === null;

  const amountStr = customSelected ? customAmount : (selectedPreset ?? '');
  const amountWei = useMemo(() => {
    if (!amountStr || !AMOUNT_PATTERN.test(amountStr)) return 0n;
    return parseUnits(amountStr, token.decimals);
  }, [amountStr, token.decimals]);

  // tip は外税固定: 受取人 (= クリエイター) は preset 額をそのまま受け取り、
  // tipper が 1% (or MIN_FEE) を上乗せして支払う。
  const breakdown = useMemo(
    () => calcBreakdown(amountWei, 'exclude', params.token),
    [amountWei, params.token],
  );

  const fmt = (wei: bigint) =>
    `${formatUnits(wei, token.decimals)} ${token.displaySymbol}`;

  const balanceQuery = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: token.chainId,
    query: { enabled: !!address && isConnected },
  });

  const insufficientBalance =
    balanceQuery.data !== undefined &&
    breakdown.customerPays > 0n &&
    balanceQuery.data < breakdown.customerPays;

  const wrongChain = isConnected && chainId !== requiredChain.id;
  const canSubmit =
    isConnected &&
    !wrongChain &&
    !!saData &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !gasless.isPending;

  const error =
    gasless.error?.message ?? (saError ? saError.message : null);

  useEffect(() => {
    if (gasless.error) logger.error('tip.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (saError) logger.error('tip.smart-account.init-failed', { error: saError });
  }, [saError]);

  useEffect(() => {
    if (gasless.data && gasless.data.success) {
      logger.info('tip.success', {
        userOpHash: gasless.data.userOpHash,
        txHash: gasless.data.txHash,
        creator: params.to,
        amount: amountStr,
        token: params.token,
      });
    }
  }, [gasless.data, params.to, params.token, amountStr]);

  function selectPreset(preset: string) {
    setSelectedPreset(preset);
    setCustomAmount('');
  }

  function selectCustom() {
    setSelectedPreset(null);
  }

  function onSubmit() {
    if (!canSubmit) return;
    gasless.mutate({
      tokenAddress: token.address,
      merchant: params.to,
      merchantAmount: breakdown.merchantReceives,
      feeReceiver: env.feeReceiver,
      feeAmount: breakdown.feeAmount,
    });
  }

  return (
    <div className="space-y-4">
      <header
        className="rounded-2xl p-5 text-white shadow-sm"
        style={{ backgroundColor: themeColor }}
      >
        <p className="text-xs uppercase tracking-wider opacity-80">
          OpenPay Tip
        </p>
        {creatorName && (
          <p className="mt-2 text-xl font-bold leading-tight">
            {creatorName} さんへチップを送る
          </p>
        )}
        {!creatorName && (
          <p className="mt-2 text-xl font-bold leading-tight">
            クリエイターへチップを送る
          </p>
        )}
        {creatorMessage && (
          <p className="mt-2 whitespace-pre-wrap text-sm opacity-90">
            {creatorMessage}
          </p>
        )}
        <p className="mt-3 text-xs opacity-70">
          {requiredChain.name} · {token.displaySymbol}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          金額を選択
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {presets.map((p) => {
            const active = !customSelected && selectedPreset === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => selectPreset(p)}
                className={`rounded-xl border px-2 py-3 text-center text-sm font-semibold transition ${
                  active
                    ? 'border-transparent text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                }`}
                style={active ? { backgroundColor: themeColor } : undefined}
              >
                {p} {token.displaySymbol}
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              またはカスタム金額
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={customAmount}
              onFocus={selectCustom}
              onChange={(e) => {
                setSelectedPreset(null);
                setCustomAmount(e.target.value.replace(/[^\d.]/g, ''));
              }}
              placeholder={
                params.token === 'jpyc' ? '例: 2500' : '例: 7.50'
              }
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-lg font-semibold focus:outline-none"
              style={{ borderColor: customSelected ? themeColor : undefined }}
            />
          </label>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          明細
        </p>
        <dl className="mt-2 space-y-1.5">
          <Row label="クリエイター受取" value={fmt(breakdown.merchantReceives)} />
          <Row label="運営手数料 (1.0%)" value={fmt(breakdown.feeAmount)} />
          <div className="my-1 border-t border-slate-200" />
          <Row
            label="あなたの支払額"
            value={fmt(breakdown.customerPays)}
            strong
          />
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          ガス代は OpenPay が肩代わりします (Pimlico Sponsorship Paymaster 経由)。
          ネイティブトークン (MATIC / ETH) の保有は不要です。
        </p>
      </section>

      <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          ウォレット
        </p>
        <ConnectButton />

        {isConnected && wrongChain && (
          <button
            type="button"
            onClick={() => switchChain({ chainId: requiredChain.id })}
            disabled={isSwitching}
            className="w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {isSwitching
              ? 'チェーン切替中…'
              : `${requiredChain.name} へ切り替え`}
          </button>
        )}

        {isConnected && !wrongChain && balanceQuery.data !== undefined && (
          <p className="text-xs text-slate-500">
            残高: <span className="font-mono">{fmt(balanceQuery.data)}</span>
          </p>
        )}

        {insufficientBalance && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            残高が不足しています ({fmt(breakdown.customerPays)} 必要)
          </p>
        )}
      </section>

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="w-full rounded-xl px-4 py-3 text-base font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50"
        style={{ backgroundColor: themeColor }}
      >
        {gasless.isPending
          ? '送信中…'
          : !isConnected
            ? 'ウォレットを接続してください'
            : wrongChain
              ? 'ネットワークを切替えてください'
              : !saData
                ? 'Smart Account 初期化中…'
                : breakdown.customerPays === 0n
                  ? '金額を選択してください'
                  : `${fmt(breakdown.customerPays)} を送る`}
      </button>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <p className="font-semibold">エラー</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      )}

      {gasless.data && gasless.data.success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
          <p className="font-semibold">チップを送信しました</p>
          <dl className="mt-2 space-y-1">
            <ResultRow label="UserOp" value={gasless.data.userOpHash} />
            <ResultRow label="Tx" value={gasless.data.txHash} />
            <ResultRow label="ブロック" value={gasless.data.blockNumber.toString()} />
          </dl>
        </div>
      )}

      <p className="pt-2 text-center text-[10px] text-slate-400">
        powered by{' '}
        <a
          href="https://github.com/cipherwebllc/openpay"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-slate-600"
        >
          OpenPay
        </a>
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className={strong ? 'text-slate-700' : 'text-slate-500'}>{label}</dt>
      <dd
        className={`text-right font-mono ${strong ? 'font-semibold text-slate-900' : 'text-slate-700'}`}
      >
        {value}
      </dd>
    </div>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="opacity-70">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </div>
  );
}
