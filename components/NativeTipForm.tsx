'use client';

// ネイティブトークン (POL / KAIA) の応援 (Tip) フォーム。
//
// ERC20 の TipForm とは別系統で意図的に最小限: ネイティブ送金は approval / relay /
// smart account / gasless / 手数料分割が一切なく、送り手が自分のガスを払って value を
// 送るだけ。OpenPay は徴収も負担もしない (受領アドレスへ素の transfer)。
// 送金は wagmi useSendTransaction、確定待ちは useWaitForTransactionReceipt。
// payerReceipt は asset:TokenSymbol を要求し native は対象外のため保存しない
// (成功パネル + エクスプローラリンクで控えとする)。

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import {
  useAccount,
  useBalance,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { ResultRow } from './ResultRow';
import { SignReassurance } from './SignReassurance';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { logger } from '@/lib/logger';
import { type NativeTipParams } from '@/lib/url';
import { useTipAmount } from '@/hooks/useTipAmount';

const DEFAULT_THEME_COLOR = '#2563eb';
// POL / KAIA とも 18 桁のネイティブトークン。
const NATIVE_DECIMALS = 18;

// ネイティブ送金は gas も同一残高から払うため、予約なしだと満額プリセットが必ずウォレット
// 拒否で終わる。0.001 (= 10^15 wei) は 21k gas × 数十 gwei を桁余裕で賄い、かつ実用上の
// チップ額を阻害しない (POL/KAIA とも transfer gas を十分カバー)。
const NATIVE_GAS_RESERVE_WEI = 10n ** 15n;

// 変動するネイティブトークン建ての控えめなプリセット (任意の応援額)。厳密な円価値では
// なく「気軽に押せる額」を意図。custom 入力で任意額も可。
const NATIVE_TIP_PRESETS: Record<NativeTipParams['chain'], string[]> = {
  polygon: ['1', '5', '10'],
  kaia: ['5', '25', '100'],
  // AVAX は単価が高い (~$15-40) ので小さめの「気軽額」。custom 入力で任意額も可。
  avalanche: ['0.05', '0.2', '0.5'],
  // ETH は単価が最も高い (~$3-4k) ので最小の「気軽額」(~$3-40)。チッパーが ETH ガスを負担。
  ethereum: ['0.001', '0.005', '0.01'],
};

// user reject (署名拒否) は握りつぶしてエラー表示しない。それ以外は表示する。
function isUserRejection(err: { message?: string } | null): boolean {
  const msg = err?.message?.toLowerCase() ?? '';
  return (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request')
  );
}

// 残高/送金額の表示整形 (full precision は冗長なので最大 4 桁に丸める)。
function fmtNative(value: bigint): string {
  const n = Number(formatUnits(value, NATIVE_DECIMALS));
  if (!Number.isFinite(n)) return formatUnits(value, NATIVE_DECIMALS);
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function NativeTipForm({ params }: { params: NativeTipParams }) {
  const t = useTranslations('NativeTipForm');
  const requiredChain = chainForSlug(params.chain);
  const nativeSymbol = requiredChain.nativeCurrency.symbol;
  const presets =
    params.presets && params.presets.length > 0
      ? params.presets
      : NATIVE_TIP_PRESETS[params.chain];
  const themeColor = params.color ?? DEFAULT_THEME_COLOR;
  const creatorName = params.name ?? '';
  const creatorMessage = params.message ?? '';

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: balance } = useBalance({
    address,
    chainId: requiredChain.id,
  });
  const {
    sendTransaction,
    data: txHash,
    isPending: isSending,
    error: sendError,
  } = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: requiredChain.id,
  });

  // プリセット + カスタム金額の選択ステートマシン (ERC20 版 TipForm と共有・挙動不変)。
  // parseEther(x) は定義上 parseUnits(x, 18) と同一で NATIVE_DECIMALS === 18 のため、
  // hook に decimals=NATIVE_DECIMALS を渡すと amountWei は従来の parseEther 経路と byte 一致。
  // 18 桁超の小数入力は amountWei が 0n に落ち、ボタンが btnSelectAmount のまま理由不明に
  // なる。amountPrecisionError は DECIMAL_PATTERN は通るが桁超過のケースを明示する (hook 内)。
  const {
    selectedPreset,
    customAmount,
    customSelected,
    amountStr,
    amountWei,
    amountPrecisionError,
    selectPreset,
    selectCustom,
    changeCustomAmount,
  } = useTipAmount({ presets, decimals: NATIVE_DECIMALS });

  const wrongChain = isConnected && chainId !== requiredChain.id;
  // ネイティブ送金は gas も同一残高から払うため、amountWei + gas 予約分が残高を超えるなら
  // 送れない (予約なしだと満額プリセットが必ずウォレット拒否で終わる)。残るウォレット側の
  // 厳密な gas 不足チェックは送信時に行われ、その error を下に表示する。
  const insufficientBalance =
    balance !== undefined &&
    amountWei > 0n &&
    amountWei + NATIVE_GAS_RESERVE_WEI > balance.value;

  const confirmed = receipt.isSuccess && receipt.data?.status === 'success';
  const reverted = receipt.data?.status === 'reverted';
  const isMining = !!txHash && receipt.isLoading;

  // 送信中・確定済 (成功) は再送金を禁止し二重チップを防ぐ。ただし revert (チェーン上で失敗)
  // 後は再送を許す: txHash が残るが結果は失敗なので、リロードせずに金額調整→再試行できる。
  // 未接続時に最下部 CTA からウォレット選択セクションへ誘導するためのアンカー。
  const walletSectionRef = useRef<HTMLElement | null>(null);

  const canSubmit =
    isConnected &&
    !wrongChain &&
    amountWei > 0n &&
    !insufficientBalance &&
    !isSending &&
    (txHash === undefined || reverted);

  const error =
    sendError && !isUserRejection(sendError)
      ? sendError.message
      : reverted
        ? t('errorReverted')
        : amountPrecisionError
          ? t('errorAmountPrecision', { decimals: NATIVE_DECIMALS })
          : null;

  // 成功は txHash ごとに 1 回だけログ。送信時の入力額を固定して live state drift を避ける。
  const submittedAmountRef = useRef<string>('');
  const notifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!confirmed || !txHash) return;
    if (notifiedRef.current === txHash) return;
    notifiedRef.current = txHash;
    logger.info('tip.native.success', {
      txHash,
      chain: params.chain,
      chainId: requiredChain.id,
      to: params.to,
      amount: submittedAmountRef.current || amountStr,
      symbol: nativeSymbol,
    });
  }, [
    confirmed,
    txHash,
    params.chain,
    params.to,
    requiredChain.id,
    amountStr,
    nativeSymbol,
  ]);

  function onSubmit() {
    if (!canSubmit) return;
    submittedAmountRef.current = amountStr;
    sendTransaction({
      to: params.to,
      value: amountWei,
      chainId: requiredChain.id,
    });
  }

  const explorerBase = blockExplorerUrl(requiredChain.id);
  const explorerTxUrl =
    explorerBase && txHash ? `${explorerBase}/tx/${txHash}` : undefined;

  return (
    <div className="space-y-4">
      <header
        className="rounded-2xl p-5 text-white shadow-sm"
        style={{ backgroundColor: themeColor }}
      >
        <p className="text-xs uppercase tracking-wider opacity-80">
          {t('header')}
        </p>
        <p className="mt-2 text-xl font-bold leading-tight">
          {creatorName
            ? t('headerNamed', { name: creatorName })
            : t('headerGeneric')}
        </p>
        {creatorMessage && (
          <p className="mt-2 whitespace-pre-wrap text-sm opacity-90">
            {creatorMessage}
          </p>
        )}
        <p className="mt-3 text-xs opacity-70">
          {requiredChain.name} · {nativeSymbol}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('amountTitle')}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {presets.map((p) => {
            const active = !customSelected && selectedPreset === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => selectPreset(p)}
                disabled={isSending || isMining}
                className={`rounded-xl border px-2 py-3 text-center text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? 'border-transparent text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                }`}
                style={active ? { backgroundColor: themeColor } : undefined}
              >
                {p} {nativeSymbol}
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t('amountCustom')}
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={customAmount}
              disabled={isSending || isMining}
              onFocus={selectCustom}
              onChange={(e) => changeCustomAmount(e.target.value)}
              placeholder={t('amountCustomPlaceholder')}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-lg font-semibold focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: customSelected ? themeColor : undefined }}
            />
          </label>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {t('gasNote', { symbol: nativeSymbol })}
        </p>
      </section>

      <section
          ref={walletSectionRef}
          className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('walletSection')}
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
              ? t('switchingChain')
              : t('switchChain', { chainName: requiredChain.name })}
          </button>
        )}

        {isConnected && !wrongChain && balance !== undefined && (
          <p className="text-xs text-slate-500">
            {t('balanceLabel')}{' '}
            <span className="font-mono">
              {fmtNative(balance.value)} {nativeSymbol}
            </span>
          </p>
        )}

        {insufficientBalance && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {t('insufficientBalance', { symbol: nativeSymbol })}
          </div>
        )}
      </section>

      {/* 署名安心ヒント (送信ボタン直上)。ネイティブ送金は通常の送金確認 1 行のみ (計画 §3.3)。
          表示専用で決済ロジックには触れない。 */}
      {!confirmed && <SignReassurance kind="native" />}

      <button
        type="button"
        // 未接続時: 押せない「ウォレットを接続」を解消し、タップでウォレット選択へ
        // スクロール (#266 CheckoutForm と同型・送信不変)。
        onClick={
          !isConnected
            ? () =>
                  walletSectionRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                  })
            : onSubmit
        }
        disabled={isConnected && !canSubmit}
        className="w-full rounded-xl px-4 py-3 text-base font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50"
        style={{ backgroundColor: themeColor }}
      >
        {isSending
          ? t('btnSending')
          : isMining
            ? t('btnMining')
            : !isConnected
              ? t('btnConnect')
              : wrongChain
                ? t('btnSwitchChain')
                : amountWei === 0n
                  ? t('btnSelectAmount')
                  : t('btnSend', { amount: amountStr, symbol: nativeSymbol })}
      </button>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <p className="font-semibold">{t('errorTitle')}</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      )}

      {confirmed && txHash && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
          <p className="font-semibold">{t('successTitle')}</p>
          <dl className="mt-3 space-y-1">
            <ResultRow label={t('successTx')} value={txHash} copyable />
          </dl>
          {explorerTxUrl && (
            <a
              href={explorerTxUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-block underline hover:text-emerald-900"
            >
              {t('viewOnExplorer')} ↗
            </a>
          )}
        </div>
      )}

      <p className="pt-2 text-center text-[10px] text-slate-500">
        {t('poweredBy')}{' '}
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
