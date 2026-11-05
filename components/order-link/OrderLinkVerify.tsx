'use client';

// 入金を確かめる: お客様から届いた文 (Tx Hash だけでもよい) で、受取ウォレットに届いた額と、払ったウォレットの
// 確認の署名をチェーンから確かめる。
// 注文の画面を閉じた後の注文も確かめられるよう、いつも出す。OpenPay のサーバーには送らない (lib/orderLinkVerify.ts)。

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { Address } from 'viem';
import { groupAmountDigits } from '@/lib/amount';
import { chainForSlug, txExplorerUrl, type ChainSlug } from '@/lib/chains';
import { shortAddress } from '@/lib/format';
import {
  checkOrderLinkPaymentOnChains,
  extractTxHash,
  isReceivedPayment,
  rememberCheckedPayment,
  type CheckedBefore,
  type OrderConfirmationCheck,
  type OrderLinkPaymentCheck,
  type ReceivedPayment,
} from '@/lib/orderLinkVerify';
import { ORDER_LINK_INPUT_CLASS } from './OrderLinkAmountField';

type Done = {
  result: OrderLinkPaymentCheck;
  hash: string | null;
  /** 取引が見つかったチェーン (見つからなければ探したチェーンの先頭)。 */
  chain: ChainSlug;
  /** 探したチェーン (複数なら全部を探した)。 */
  chains: readonly ChainSlug[];
  /** 問い合わせできなかったチェーン。 */
  unreachable: ChainSlug[];
  receiver: Address;
  /**
   * 同じ支払いを前に確かめた時刻 (ms・この端末の記録)。2 つの注文に使い回されていないかを知らせる。
   * 'unavailable' = この端末では記録を読めない・残せない。届いていて確定した支払い (paid) のときだけ見る。
   */
  checkedBefore: CheckedBefore;
};

export function OrderLinkVerify({
  chains,
  receiver,
}: {
  /**
   * 探すチェーン。全部を探し、見つかったチェーンで判定する。今の設定の受取チェーンだけでなく、注文リンクで受け付けうる
   * JPYC のチェーンを全部渡す (受取チェーンを変えた後に、前のチェーンで払われた注文を確かめられるように・第 9 回レビュー D-4)。
   */
  chains: readonly ChainSlug[];
  receiver: Address | null;
}) {
  const t = useTranslations('OrderLinkBuilder');
  const locale = useLocale();
  const inputId = useId();
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  // 確かめている間に欄・受取ウォレット・チェーンが変わったら、遅れて届いた応答は今の入力の結果ではない。それを出すと、
  // 別のお客様の (払っていない) Tx Hash に書き換えた欄の下に前の「届いています」が出て、払っていない注文を発送させてしまう
  // (第 9 回レビュー G-2)。確かめるたびと、入力が変わるたび・この欄が消えるたびに通し番号を進め、応答は自分の番号が
  // 今の番号のときだけ出す。
  const chainsKey = chains.join(',');
  const requestSeq = useRef(0);
  // 入力が変わったとき・この欄が消えたとき (注文リンクのタブを離れる等) の片付けで番号を進める。描画の確定と同時に
  // (layout effect) 進めるので、変わった後の画面に前の結果が出ず、この後に届く前の応答は番号で捨てる。
  // 確かめている途中の応答も捨てるので、すぐに新しい入力を確かめられるよう「確かめています」も戻す。
  // チェーンは中身で見る (同じ内容の配列で描き直されても結果を消さない)。
  useLayoutEffect(() => {
    setDone(null);
    setChecking(false);
    return () => {
      requestSeq.current += 1;
    };
  }, [text, receiver, chainsKey]);

  const check = async () => {
    if (!receiver || checking) return;
    requestSeq.current += 1;
    const requestId = requestSeq.current;
    setChecking(true);
    const found = await checkOrderLinkPaymentOnChains({ chains, receiver, text });
    // 捨てた応答は、この端末の記録 (rememberCheckedPayment) にも残さない (見せていない結果を「前にも確かめた」にしない)。
    if (requestId !== requestSeq.current) return;
    const chain = found.chain ?? chains[0];
    const { result } = found;
    const hash = extractTxHash(text);
    const checkedBefore =
      result.status === 'paid' && hash ? rememberCheckedPayment({ chain, receiver, hash, now: Date.now() }) : null;
    setDone({ result, hash, chain, chains, unreachable: found.unreachable, receiver, checkedBefore });
    setChecking(false);
  };

  const explorerUrl = done?.hash ? txExplorerUrl(chainForSlug(done.chain).id, done.hash) : undefined;

  return (
    <section
      aria-labelledby="order-link-verify-heading"
      className="min-w-0 rounded-2xl bg-white px-5 py-4 shadow-card ring-1 ring-slate-200/70 lg:col-start-1"
    >
      <h2 id="order-link-verify-heading" className="text-sm font-semibold text-slate-800">
        {t('verifyTitle')}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('verifyLead')}</p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {t('verifyLabel')}
        </label>
        <input
          id={inputId}
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('verifyPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          className={`${ORDER_LINK_INPUT_CLASS} min-w-0 font-mono sm:flex-1`}
        />
        <button
          type="submit"
          disabled={!receiver || text.trim() === '' || checking}
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? t('verifyChecking') : t('verifyButton')}
        </button>
      </form>

      {/* 結果は読み上げる (注文リンクの画面の role="status" は送ったかどうかの 1 つに残す)。 */}
      <div aria-live="polite" className="mt-3 empty:hidden">
        {done && <VerifyResult done={done} locale={locale} />}
      </div>
      {done && explorerUrl && (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-dark"
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
          {t('verifyExplorer')}
        </a>
      )}
    </section>
  );
}

// 結果のカードの配色とアイコン。緑とチェックは「発送してよい」と読まれるので、確定した支払いで、払ったウォレットの確認の
// 署名が確かめられたときだけに使う (第 9 回レビュー E-5: 他人の Tx Hash を署名なしで貼られても、大きな緑のチェックの下の
// 小さな注意を見落とさないように・D-3: 確定する前の取引は消えることがある)。黄 = 確かめてから発送・赤系 = 発送を止めて
// 確かめる (カードの中の注意の段落と同じ意味)。
type VerifyTone = 'ok' | 'caution' | 'danger';

const TONE_STYLE: Record<VerifyTone, { card: string; Icon: LucideIcon; icon: string }> = {
  ok: { card: 'bg-emerald-50 text-emerald-900 ring-emerald-200', Icon: CheckCircle2, icon: 'text-emerald-600' },
  caution: { card: 'bg-amber-50 text-amber-900 ring-amber-200', Icon: AlertTriangle, icon: 'text-amber-600' },
  danger: { card: 'bg-rose-50 text-rose-900 ring-rose-200', Icon: ShieldAlert, icon: 'text-rose-600' },
};

/** 確認の署名の照合 (lib/orderLinkVerify) の色。確かめられなかった (unchecked) は他人の署名と言わず黄にする。 */
function confirmationTone(confirmation: OrderConfirmationCheck): VerifyTone {
  switch (confirmation) {
    case 'verified':
      return 'ok';
    case 'unsigned':
    case 'unchecked':
      return 'caution';
    case 'mismatch':
    case 'unverifiable':
      return 'danger';
  }
}

/** 届いた支払いのカードの色。確定していない・確定を確かめられないときは、署名が確かめられても緑にしない。 */
function receivedTone(result: Extract<OrderLinkPaymentCheck, ReceivedPayment>): VerifyTone {
  const tone = confirmationTone(result.confirmation);
  return result.status === 'paid' || tone === 'danger' ? tone : 'caution';
}

function ResultCard({ tone, children }: { tone: VerifyTone; children: ReactNode }) {
  const { card, Icon, icon } = TONE_STYLE[tone];
  return (
    <div className={`flex gap-2 rounded-xl px-3 py-2.5 ring-1 ${card}`}>
      <Icon className={`mt-0.5 h-4 w-4 flex-none ${icon}`} aria-hidden />
      {children}
    </div>
  );
}

const NOTE_CAUTION = 'mt-2 rounded-lg bg-amber-100 px-2 py-1.5 text-xs font-semibold leading-relaxed text-amber-900';
const NOTE_DANGER = 'mt-2 rounded-lg bg-rose-100 px-2 py-1.5 text-xs font-semibold leading-relaxed text-rose-900';

function VerifyResult({ done, locale }: { done: Done; locale: string }) {
  const t = useTranslations('OrderLinkBuilder');
  const { result } = done;
  if (isReceivedPayment(result)) {
    const format = (ms: number) =>
      new Date(ms).toLocaleString(locale === 'en' ? 'en-US' : 'ja-JP', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    const time = format(result.timestamp * 1000);
    const amount = groupAmountDigits(result.received);
    const tone = receivedTone(result);
    return (
      <ResultCard tone={tone}>
        <div className="min-w-0 text-sm">
          {/* 「届いています」は確定した取引だけ (lib/jpyc/finality)。確定する前・確定を確かめられないときはそう言う。 */}
          <p className="font-semibold">
            {result.status === 'paid'
              ? t('verifyPaid', { amount })
              : result.status === 'pending'
                ? t('verifyPending', { amount })
                : t('verifyFinalityUnchecked', { amount })}
          </p>
          {/* 確定していない支払いは「払われています」と言わず、見つかったチェーンとだけ言う。 */}
          {done.chains.length > 1 && (
            <p className="mt-0.5 text-xs font-semibold">
              {t(result.status === 'paid' ? 'verifyPaidChain' : 'verifyFoundChain', { chain: chainForSlug(done.chain).name })}
            </p>
          )}
          <p className="mt-0.5 text-xs">{t('verifyPaidMeta', { time, block: result.blockNumber.toString() })}</p>
          {result.status !== 'paid' && (
            <p className={NOTE_CAUTION}>
              {t(result.status === 'pending' ? 'verifyPendingNote' : 'verifyFinalityUncheckedNote')}
            </p>
          )}
          <p className="mt-1 text-xs leading-relaxed">{t('verifyPaidNote')}</p>
          {/* 確認の署名: 文を送った人が、この支払いをしたウォレットの持ち主か (Tx Hash は誰でも見られる)。 */}
          {result.confirmation === 'verified' ? (
            <p className="mt-2 inline-flex items-start gap-1 text-xs font-semibold leading-relaxed">
              {/* 確定していないカードでは緑を使わない (署名が確かめられても、まだ発送してよいとは読ませない)。 */}
              <ShieldCheck className={`mt-px h-3.5 w-3.5 flex-none ${tone === 'ok' ? 'text-emerald-600' : ''}`} aria-hidden />
              {t('verifyConfirmed', { payer: result.payer ? shortAddress(result.payer) : '' })}
            </p>
          ) : result.confirmation === 'mismatch' || result.confirmation === 'unverifiable' ? (
            <p className={NOTE_DANGER}>
              {t(result.confirmation === 'mismatch' ? 'verifyMismatch' : 'verifyUnverifiable')}
            </p>
          ) : (
            <p className={NOTE_CAUTION}>
              {t(result.confirmation === 'unchecked' ? 'verifyConfirmationUnchecked' : 'verifyUnsigned')}
            </p>
          )}
          {/* 使い回しはこの端末の記録だけで見ている (第 9 回レビュー E-6)。記録したのは確定した支払いだけ。 */}
          {result.status === 'paid' &&
            (done.checkedBefore === 'unavailable' ? (
              <p className={NOTE_CAUTION}>{t('verifyCheckedUnavailable')}</p>
            ) : (
              <>
                {done.checkedBefore !== null && (
                  <p className={NOTE_CAUTION}>{t('verifyCheckedBefore', { time: format(done.checkedBefore) })}</p>
                )}
                <p className="mt-1 text-xs leading-relaxed">{t('verifyCheckedLocal')}</p>
              </>
            ))}
        </div>
      </ResultCard>
    );
  }
  const names = (chains: readonly ChainSlug[]) => chains.map((chain) => chainForSlug(chain).name).join(' / ');
  const message =
    result.status === 'notToReceiver'
      ? t('verifyNotToReceiver', { receiver: shortAddress(done.receiver) })
      : result.status === 'notFound'
        ? t('verifyNotFound', { chain: names(done.chains) })
        : result.status === 'error' && done.chains.length > 1 && done.unreachable.length > 0
          ? t('verifyUnreachable', { chains: names(done.unreachable) })
          : t(`verify.${result.status}`);
  return (
    <ResultCard tone="caution">
      <p className="min-w-0 text-sm">{message}</p>
    </ResultCard>
  );
}
