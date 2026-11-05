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
  rememberCheckedPayment,
  type OrderConfirmationCheck,
  type OrderLinkPaymentCheck,
} from '@/lib/orderLinkVerify';
import { ORDER_LINK_INPUT_CLASS } from './OrderLinkAmountField';

type Done = {
  result: OrderLinkPaymentCheck;
  hash: string | null;
  /** 取引が見つかったチェーン (見つからなければ受け付けるチェーンの先頭)。 */
  chain: ChainSlug;
  /** 受け付けるチェーン (複数なら全部を探した)。 */
  chains: readonly ChainSlug[];
  /** 問い合わせできなかったチェーン。 */
  unreachable: ChainSlug[];
  receiver: Address;
  /** 同じ支払いを前に確かめた時刻 (ms・この端末)。2 つの注文に使い回されていないかを知らせる。 */
  checkedBefore: number | null;
};

export function OrderLinkVerify({
  chains,
  receiver,
}: {
  /** 受け付けるチェーン (先頭が主)。全部を探し、見つかったチェーンで判定する。 */
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
  // (第 9 回レビュー G-2)。確かめるたびと入力が変わるたびに通し番号を進め、応答は自分の番号が今の番号で、確かめた入力が
  // 今の入力のままのときだけ出す。
  const chainsKey = chains.join(',');
  const requestSeq = useRef(0);
  const latestInput = useRef({ text, receiver, chainsKey });
  // 描画の確定と同時に (layout effect) 進めるので、変わった後の画面に前の結果が出ず、この後に届く前の応答は番号で捨てる。
  // 確かめている途中の応答も捨てるので、すぐに新しい入力を確かめられるよう「確かめています」も戻す。
  // チェーンは中身で見る (同じ内容の配列で描き直されても結果を消さない)。
  useLayoutEffect(() => {
    latestInput.current = { text, receiver, chainsKey };
    requestSeq.current += 1;
    setDone(null);
    setChecking(false);
  }, [text, receiver, chainsKey]);

  const check = async () => {
    if (!receiver || checking) return;
    requestSeq.current += 1;
    const request = { id: requestSeq.current, text, receiver, chainsKey };
    setChecking(true);
    const found = await checkOrderLinkPaymentOnChains({ chains, receiver, text });
    // 番号に加えて入力も比べる: 発送を決める表示なので、番号を進める所が今後の変更で漏れても、確かめた入力と違う欄の下に
    // 結果を出さない二重の止めにする。捨てた応答はこの端末の記録 (rememberCheckedPayment) にも残さない。
    const latest = latestInput.current;
    if (
      request.id !== requestSeq.current ||
      request.text !== latest.text ||
      request.receiver !== latest.receiver ||
      request.chainsKey !== latest.chainsKey
    ) {
      return;
    }
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

// 結果のカードの配色とアイコン。緑とチェックは「発送してよい」と読まれるので、払ったウォレットの確認の署名が確かめられた
// 支払いだけに使う (第 9 回レビュー E-5: 他人の Tx Hash を署名なしで貼られても、大きな緑のチェックの下の小さな注意を
// 見落とさないように)。黄 = お客様に確かめてから発送・赤系 = 発送を止めて確かめる (カードの中の注意の段落と同じ意味)。
type VerifyTone = 'ok' | 'caution' | 'danger';

const TONE_STYLE: Record<VerifyTone, { card: string; Icon: LucideIcon; icon: string }> = {
  ok: { card: 'bg-emerald-50 text-emerald-900 ring-emerald-200', Icon: CheckCircle2, icon: 'text-emerald-600' },
  caution: { card: 'bg-amber-50 text-amber-900 ring-amber-200', Icon: AlertTriangle, icon: 'text-amber-600' },
  danger: { card: 'bg-rose-50 text-rose-900 ring-rose-200', Icon: ShieldAlert, icon: 'text-rose-600' },
};

/** 届いた支払いのカードの色。確認の署名の照合 (lib/orderLinkVerify) で決める。 */
function paidTone(confirmation: OrderConfirmationCheck): VerifyTone {
  switch (confirmation) {
    case 'verified':
      return 'ok';
    case 'unsigned':
      return 'caution';
    case 'mismatch':
    case 'unverifiable':
      return 'danger';
  }
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

function VerifyResult({ done, locale }: { done: Done; locale: string }) {
  const t = useTranslations('OrderLinkBuilder');
  const { result } = done;
  if (result.status === 'paid') {
    const format = (ms: number) =>
      new Date(ms).toLocaleString(locale === 'en' ? 'en-US' : 'ja-JP', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    const time = format(result.timestamp * 1000);
    return (
      <ResultCard tone={paidTone(result.confirmation)}>
        <div className="min-w-0 text-sm">
          <p className="font-semibold">{t('verifyPaid', { amount: groupAmountDigits(result.received) })}</p>
          {done.chains.length > 1 && (
            <p className="mt-0.5 text-xs font-semibold">{t('verifyPaidChain', { chain: chainForSlug(done.chain).name })}</p>
          )}
          <p className="mt-0.5 text-xs">{t('verifyPaidMeta', { time, block: result.blockNumber.toString() })}</p>
          <p className="mt-1 text-xs leading-relaxed">{t('verifyPaidNote')}</p>
          {/* 確認の署名: 文を送った人が、この支払いをしたウォレットの持ち主か (Tx Hash は誰でも見られる)。 */}
          {result.confirmation === 'verified' ? (
            <p className="mt-2 inline-flex items-start gap-1 text-xs font-semibold leading-relaxed">
              <ShieldCheck className="mt-px h-3.5 w-3.5 flex-none text-emerald-600" aria-hidden />
              {t('verifyConfirmed', { payer: result.payer ? shortAddress(result.payer) : '' })}
            </p>
          ) : result.confirmation === 'mismatch' || result.confirmation === 'unverifiable' ? (
            <p className="mt-2 rounded-lg bg-rose-100 px-2 py-1.5 text-xs font-semibold leading-relaxed text-rose-900">
              {t(result.confirmation === 'mismatch' ? 'verifyMismatch' : 'verifyUnverifiable')}
            </p>
          ) : (
            <p className="mt-2 rounded-lg bg-amber-100 px-2 py-1.5 text-xs font-semibold leading-relaxed text-amber-900">
              {t('verifyUnsigned')}
            </p>
          )}
          {done.checkedBefore !== null && (
            <p className="mt-2 rounded-lg bg-amber-100 px-2 py-1.5 text-xs font-semibold leading-relaxed text-amber-900">
              {t('verifyCheckedBefore', { time: format(done.checkedBefore) })}
            </p>
          )}
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
