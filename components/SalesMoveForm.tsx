'use client';

// 「売上をほかのウォレットへ移す」の画面 (plans/store-sales-move.md §2.3・P2a)。/create の「受け取った通貨を換金」の折りたたみの中、
// ガス代の案内 (gasHint) の直後に置く。/create の First Load JS に載せないよう、page から next/dynamic で遅延読み込みする。
// flag (NEXT_PUBLIC_ENABLE_SALES_MOVE) OFF では何も描かない (完全 inert・hook も動かさない)。
//
// 流れ: 送り先と移す額を入れる → 確認 (届く額・利用料・ウォレットから出る合計。送り先が contract ならチェックを挟む) →
// 1 回署名 (hooks/useSalesMove) → 結果 (移した・送信済みで確定待ち・成立しなかった)。送信済みかもしれない間は入力に戻さない
// (再署名させない)。移した (成立が確定した) 表示にだけ「もう一度移す」を出し、空の入力に戻して次の移動を始められるようにする。開き直したときは hook が保存した枠を照会して結果を出す。送信済みで確定待ちの間は、同じ画面でも hook が
// 照会して結果へ進める。照会を打ち切った後は「もう一度確かめる」(照会だけ・署名のボタンは出さない) を出す。
//
// 文字の色は小さい文字で slate-500 以上 (WCAG AA・tests/components/SalesMoveForm.test.tsx が tests/_helpers/tailwindContrast で
// 計算する)。押せるものは 44px。赤はエラーだけ。a11y の名前は見えている文字から (aria-label を単独で付けない・掟 8)。

import { useEffect, useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { erc20Abi, formatUnits, type Address } from 'viem';
import { useAccount, usePublicClient, useReadContract } from 'wagmi';
import { env } from '@/lib/env';
import { chainForSlug, txExplorerUrl } from '@/lib/chains';
import { resolveDeployment, type TokenDeployment } from '@/lib/tokens';
import { isSalesMoveChain } from '@/lib/relay/salesMove';
import { jpycForwarderFor, relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { isRelayResponseUnknownError } from '@/lib/relay/relayResponseError';
import { formatJpycWei } from '@/lib/pricingMath';
import {
  checkDestination,
  checkMoveAmount,
  moveAllWei,
  salesMoveErrorKey,
  salesMoveLimits,
  salesMoveRetrySeconds,
} from '@/lib/salesMoveForm';
import { useSwitchChainWithFeedback } from '@/hooks/useSwitchChainWithFeedback';
import { useSalesMove } from '@/hooks/useSalesMove';

const PRIMARY_BTN =
  'inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50';
const SECONDARY_BTN =
  'inline-flex min-h-11 items-center justify-center rounded-lg bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-slate-500 hover:bg-slate-100 disabled:opacity-50';
const INPUT =
  'block min-h-11 w-full rounded-lg bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-500';

/** flag OFF では hook を呼ぶ前に何も描かずに返す (完全 inert)。 */
export function SalesMoveForm() {
  if (!env.enableSalesMove) return null;
  return <SalesMoveSection />;
}

function SalesMoveSection() {
  const t = useTranslations('Create.salesMove');
  // 本番は Polygon・testnet は Amoy (同じ slug が NETWORK_ENV で切り替わる)。route が受け付けるチェーンだけ。
  const chain = chainForSlug('polygon');
  const deployment = resolveDeployment('jpyc', chain.id);
  const forwarder = jpycForwarderFor(chain.id);
  const usable = deployment !== undefined && isSalesMoveChain(chain.id) && env.enableJpycEip3009 && forwarder !== null;
  const fee = relayGasFeeValue(chain.id);
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="mt-4 rounded-2xl bg-white p-4 text-sm text-slate-700 ring-1 ring-slate-200"
      data-testid="sales-move"
    >
      <h3 id={headingId} className="text-sm font-semibold text-slate-900">
        {t('title')}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        {t('intro', { chain: chain.name, fee: formatJpycWei(fee) })}
      </p>
      {usable ? (
        <SalesMoveBody
          deployment={deployment}
          forwarder={forwarder}
          chainName={chain.name}
          fee={fee}
        />
      ) : (
        // relay・forwarder が無い構成では route が 503 を返すので、入力させずに先に知らせる。
        <p className="mt-3 text-xs text-slate-600">{t('errors.unavailable')}</p>
      )}
    </section>
  );
}

type Review = {
  from: Address;
  destination: Address;
  amount: bigint;
};

type CodeState = 'checking' | 'eoa' | 'contract' | 'error';

function SalesMoveBody({
  deployment,
  forwarder,
  chainName,
  fee,
}: {
  deployment: TokenDeployment;
  forwarder: Address;
  chainName: string;
  fee: bigint;
}) {
  const t = useTranslations('Create.salesMove');
  const locale = useLocale();
  const ids = useId();
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const onChain = isConnected && walletChainId === deployment.chainId;
  const publicClient = usePublicClient({ chainId: deployment.chainId });
  const switcher = useSwitchChainWithFeedback('sales-move');
  const move = useSalesMove(deployment, {
    delivered: t('confirmDelivered'),
    fee: t('confirmFee'),
    locale,
  });
  const balanceEnabled = onChain && Boolean(address);
  const balance = useReadContract({
    address: deployment.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: deployment.chainId,
    query: { enabled: balanceEnabled },
  });

  const [destination, setDestination] = useState('');
  const [amountText, setAmountText] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [code, setCode] = useState<CodeState>('checking');
  const [contractConfirmed, setContractConfirmed] = useState(false);

  const limits = salesMoveLimits(fee);
  const amounts = {
    fee: formatJpycWei(fee),
    min: formatJpycWei(limits.minWallet),
    maxMove: formatJpycWei(limits.maxMove),
    maxTotal: formatJpycWei(limits.maxTotal),
  };

  // 確認の段で、送り先が contract (スマートアカウント・7702 で委任した EOA を含む) かを読む。読めないときは署名させない。
  const reviewDestination = review?.destination;
  useEffect(() => {
    if (!reviewDestination) return;
    let active = true;
    setCode('checking');
    setContractConfirmed(false);
    if (!publicClient) {
      setCode('error');
      return;
    }
    publicClient
      .getCode({ address: reviewDestination })
      .then((bytecode) => {
        if (active) setCode(bytecode && bytecode !== '0x' ? 'contract' : 'eoa');
      })
      .catch(() => {
        if (active) setCode('error');
      });
    return () => {
      active = false;
    };
  }, [reviewDestination, publicClient]);

  // 確認の後にウォレットを切り替えたら、確認をやり直させる (確認した送り元と違う送り元で署名させない)。
  const reviewFrom = review?.from;
  const held = move.held;
  useEffect(() => {
    if (reviewFrom && held === null && address?.toLowerCase() !== reviewFrom.toLowerCase()) setReview(null);
  }, [address, reviewFrom, held]);

  const result = move.result;
  // 移した (成立)。開き直した後の照会の結果も同じ。
  if (result?.success) {
    const url = result.txHash ? txExplorerUrl(deployment.chainId, result.txHash) : undefined;
    return (
      <div role="status" className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900">
        <p>{t('success')}</p>
        {url && <ExplorerLink href={url} label={t('viewTx')} />}
        {/* 成立が確定した表示にだけ出す (送信済み・確定待ちの表示には出さない)。hook の側も、返している result が success の
            ときだけ入力へ戻す。次の移動は、送り先と額を入れ直し、確認をやり直してから、新しい署名で送る。 */}
        <div className="mt-2">
          <button
            type="button"
            onClick={() => {
              move.resetAfterSuccess();
              // 前の移動の確認と入力を持ち越さない (確認を残すと、前と同じ送り先・額の「署名して移す」がそのまま出る)。送り先が
              // contract のときのチェックは、次の確認に入るときに上の effect が外す (確認の送り先が無し → あり に変わる)。
              setReview(null);
              setDestination('');
              setAmountText('');
              // 入力に出す「ウォレットにある JPYC」は、移す前に読んだ値のまま残っている。読み直して、「全部移す」が古い額を
              // 入れないようにする (読めなければ今までどおり balance.isError の文言が出る・署名の前の読み直しは hook が別にする)。
              if (balanceEnabled) void balance.refetch();
            }}
            className={SECONDARY_BTN}
          >
            {t('moveAgain')}
          </button>
        </div>
      </div>
    );
  }
  // 送信済みかもしれない (未確定・応答不明・照会中)。もう一度署名させない。
  if (result?.pending || held === 'ambiguous' || move.isRecovering) {
    const url = result?.txHash ? txExplorerUrl(deployment.chainId, result.txHash) : undefined;
    return (
      <div role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
        <p>{t('pending')}</p>
        {url && <ExplorerLink href={url} label={t('viewTx')} />}
        {/* 照会を打ち切った後だけ出す。押しても status を読むだけで、署名も送信もしない (hook の recheck)。 */}
        {held === 'ambiguous' && !move.isRecovering && (
          <div className="mt-2">
            <button type="button" onClick={move.recheck} className={SECONDARY_BTN}>
              {t('recheck')}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!isConnected || !address) {
    return <p className="mt-3 text-xs text-slate-600">{t('notConnected')}</p>;
  }
  if (!onChain) {
    return (
      <div className="mt-3 space-y-2">
        <p className="text-xs text-slate-600">{t('wrongChain', { chain: chainName })}</p>
        <button
          type="button"
          onClick={() => switcher.switchChain({ chainId: deployment.chainId })}
          disabled={switcher.isPending}
          className={SECONDARY_BTN}
        >
          {t('switchButton', { chain: chainName })}
        </button>
        {switcher.failed && (
          <p role="alert" className="text-xs leading-relaxed text-red-700">
            {t('switchFailed', { chain: chainName })}
          </p>
        )}
      </div>
    );
  }

  const wallet = balance.data;
  const tooLittle = wallet !== undefined && wallet < limits.minWallet;
  const all = wallet !== undefined ? moveAllWei(wallet, fee) : null;
  const destinationCheck = checkDestination(destination, {
    from: address,
    forbidden: [forwarder, env.feeReceiver as Address, deployment.address],
  });
  const amountCheck =
    wallet !== undefined ? checkMoveAmount(amountText, { fee, balance: wallet }) : null;
  const destinationError = destination.trim() !== '' && !destinationCheck.ok ? destinationCheck.error : null;
  const amountError = amountText.trim() !== '' && amountCheck && !amountCheck.ok ? amountCheck.error : null;
  const canReview = !tooLittle && destinationCheck.ok && amountCheck?.ok === true;

  if (review) {
    const total = review.amount + fee;
    const reverted = result !== undefined && !result.success && !result.pending;
    const error = move.error && !isRelayResponseUnknownError(move.error) ? move.error : null;
    const errorKey = error ? salesMoveErrorKey(error) : null;
    const signDisabled =
      move.isPending ||
      code === 'checking' ||
      code === 'error' ||
      (code === 'contract' && !contractConfirmed);
    return (
      <div className="mt-3 space-y-3">
        <dl className="space-y-2 rounded-xl bg-slate-50 p-3 text-xs">
          <div>
            <dt className="text-slate-600">{t('destinationLabel')}</dt>
            <dd className="mt-0.5 break-all font-mono text-slate-900">{review.destination}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-slate-600">{t('confirmDelivered')}</dt>
            <dd className="font-mono text-slate-900">{formatJpycWei(review.amount)} JPYC</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-slate-600">{t('confirmFee')}</dt>
            <dd className="font-mono text-slate-900">{formatJpycWei(fee)} JPYC</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2 text-sm font-semibold text-slate-900">
            <dt>{t('confirmTotal')}</dt>
            <dd className="font-mono">{formatJpycWei(total)} JPYC</dd>
          </div>
        </dl>
        {code === 'contract' && (
          <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
            <p>{t('contractWarning')}</p>
            <label className="flex min-h-11 items-center gap-2 font-semibold">
              <input
                type="checkbox"
                checked={contractConfirmed}
                onChange={(e) => setContractConfirmed(e.target.checked)}
                disabled={move.isPending}
                className="h-5 w-5 flex-none"
              />
              {t('contractConfirm')}
            </label>
          </div>
        )}
        {code === 'error' && (
          <p role="alert" className="text-xs leading-relaxed text-red-700">
            {t('errors.unavailable')}
          </p>
        )}
        {reverted && !move.isPending && (
          <p role="alert" className="text-xs leading-relaxed text-red-700">
            {t('reverted')}
          </p>
        )}
        {errorKey && !move.isPending && (
          <p role="alert" className="text-xs leading-relaxed text-red-700">
            {errorKey === 'rateLimited'
              ? t('errors.rateLimited', { seconds: salesMoveRetrySeconds(error) })
              : t(`errors.${errorKey}`, { fee: amounts.fee, maxMove: amounts.maxMove })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              move.reset();
              setReview(null);
            }}
            // IP 制限で保持した署名済みの payload は、この確認の内容のまま再送する (戻って額を変えさせない)。
            disabled={move.isPending || held !== null}
            className={SECONDARY_BTN}
          >
            {t('backButton')}
          </button>
          <button
            type="button"
            onClick={() => move.move({ destination: review.destination, amount: review.amount })}
            disabled={signDisabled}
            className={PRIMARY_BTN}
          >
            {t('signButton')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {wallet !== undefined && (
        <p className="text-xs text-slate-700">{t('walletJpyc', { amount: formatJpycWei(wallet) })}</p>
      )}
      {balance.isError && (
        <p role="alert" className="text-xs leading-relaxed text-red-700">
          {t('errors.unavailable')}
        </p>
      )}
      {tooLittle && (
        <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          {t('tooLittle', { min: amounts.min, fee: amounts.fee })}
        </p>
      )}
      <div>
        <label htmlFor={`${ids}-destination`} className="text-xs font-semibold text-slate-700">
          {t('destinationLabel')}
        </label>
        <input
          id={`${ids}-destination`}
          type="text"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          aria-invalid={destinationError !== null}
          aria-describedby={destinationError ? `${ids}-destination-error` : undefined}
          className={`${INPUT} mt-1 font-mono`}
        />
        {destinationError && (
          <p id={`${ids}-destination-error`} className="mt-1 text-xs text-red-700">
            {t(`errors.${destinationError}`)}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={`${ids}-amount`} className="text-xs font-semibold text-slate-700">
          {t('amountLabel')}
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id={`${ids}-amount`}
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            autoComplete="off"
            aria-invalid={amountError !== null}
            aria-describedby={amountError ? `${ids}-amount-error` : `${ids}-max`}
            className={`${INPUT} min-w-0 flex-1 font-mono`}
          />
          <button
            type="button"
            // 入力欄には区切りの無い 10 進 (小数は末尾の 0 を落とす) を入れる。
            onClick={() => all !== null && setAmountText(formatUnits(all, 18))}
            disabled={all === null}
            className={`${SECONDARY_BTN} flex-none`}
          >
            {t('moveAll')}
          </button>
        </div>
        {amountError && (
          <p id={`${ids}-amount-error`} className="mt-1 text-xs text-red-700">
            {t(`errors.${amountError}`, { fee: amounts.fee, maxMove: amounts.maxMove })}
          </p>
        )}
        <p id={`${ids}-max`} className="mt-1 text-xs text-slate-600">
          {t('maxNote', { maxMove: amounts.maxMove, maxTotal: amounts.maxTotal })}
        </p>
      </div>
      <div className="rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
        <p className="font-semibold text-slate-900">{t('notesTitle')}</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>{t('note1')}</li>
          <li>{t('note2')}</li>
          <li>{t('note3')}</li>
          <li>{t('note4', { fee: amounts.fee })}</li>
        </ul>
      </div>
      <button
        type="button"
        onClick={() => {
          if (!canReview || !destinationCheck.ok || amountCheck?.ok !== true) return;
          setReview({ from: address, destination: destinationCheck.address, amount: amountCheck.wei });
        }}
        disabled={!canReview || move.isPending}
        className={PRIMARY_BTN}
      >
        {t('reviewButton')}
      </button>
    </div>
  );
}

function ExplorerLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2"
    >
      {label} ↗
    </a>
  );
}
