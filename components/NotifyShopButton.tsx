'use client';

// 遠隔の注文 (注文リンクなど) の支払いの後、お客様が自分の LINE やメールで注文や「払いました」をお店に送る文を用意する。
// 文はこのブラウザの中で作り、お店の LINE 公式アカウント / メールを開くリンク・スマホの共有・コピーで渡すだけ。
// OpenPay のサーバーには送らない (注文の内容やお客様の情報を OpenPay が受け取らない・2026-11-03 裁定)。
// お名前とお届け先は、お客様が自分の LINE やメールの中で書き足す (この画面に入力欄を置かない)。
//
// 送る前に、払ったウォレットで決まった文に署名してもらう (お金は動かない・lib/orderConfirmation.ts)。お店は
// 「入金を確かめる」で、文を送った人がその支払いをした人かを確かめられる (他人の Tx Hash を貼った注文を見分ける)。
// 支払いの署名はチェーンに載って誰でも写せるので、この証明には使えない (支払いの後の 2 つ目の署名が要る)。
// 2 段に分けるのは、共有・コピー・別のアプリを開く操作が「押した直後」でないと拒まれるため (署名の待ちを挟めない)。
// 払えたウォレットは署名もできる。断った・読み直しで接続が切れたときだけ「署名せずに送る」を出す
// (お店の画面に「署名なし」と出る・注文を送れずに困らせない)。署名の要求が返らない (WalletConnect の要求が
// ウォレットに届かない等) まま SIGN_SLOW_MS 待ったときも出す (第 9 回レビュー D-6)。

import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { useAccount, usePublicClient, useSignMessage } from 'wagmi';
import { isAddressEqual, recoverMessageAddress, type Address } from 'viem';
import { Check, Copy, Mail, MessageCircle, PenLine, Send } from 'lucide-react';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import { chainForSlug, type ChainSlug } from '@/lib/chains';
import { shortAddress } from '@/lib/format';
import {
  orderConfirmationMessage,
  recoverableSignature,
  storeConfirmationSignature,
  storedConfirmationSignature,
  subscribeConfirmationSignatures,
} from '@/lib/orderConfirmation';
import { lineMessageUrl, mailtoUrl, shopContactLabel, type ShopContact } from '@/lib/shopContact';

type Tone = 'overlay' | 'panel';

const PRIMARY: Record<Tone, string> = {
  overlay:
    'inline-flex min-h-12 w-full max-w-md items-center justify-center gap-2 rounded-xl bg-white px-5 text-base font-bold text-emerald-700 shadow-lg hover:bg-emerald-50 disabled:opacity-70',
  panel:
    'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 text-base font-bold text-white hover:bg-brand-dark disabled:opacity-70',
};
// 完了画面 (SuccessOverlay の bg-emerald-500) の上の白文字は 2.54:1 で AA に届かないので、濃い緑の地に白文字にする
// (白 / emerald-800 = 7.68:1・地と背景の境目 3.03:1)。
const SECONDARY: Record<Tone, string> = {
  overlay:
    'inline-flex min-h-11 items-center gap-1.5 rounded-full bg-emerald-800 px-4 text-sm font-medium text-white hover:bg-emerald-900',
  panel: 'inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-dark',
};
const NOTE: Record<Tone, string> = {
  overlay: 'text-center text-xs text-white/90',
  panel: 'text-center text-xs text-slate-600',
};

/**
 * 署名の要求がこの時間返らなければ、「署名せずに送る」も出す。signMessageAsync には時間切れが無く、要求が
 * ウォレットに届かないと resolve も reject もしないため (主ボタンは署名の間押せない)。要求は取り消さない:
 * 後から署名が返れば、そのまま署名の入った文になる。
 */
const SIGN_SLOW_MS = 20_000;

/**
 * 遠隔の注文の会計か (注文を送る / お店に知らせるボタンを出すか)。受付番号があるか「何度でも使える」リンク
 * (ship=ask) で、店頭のモバイル注文 (@handle・利用料の種類) とお店の端末で送る会計ではないとき。
 */
export function isRemoteOrderCheckout(params: {
  orderId?: string;
  ship?: 'ask';
  storeHandle?: string;
  feeKind?: string;
  submit?: 'store';
}): boolean {
  return (
    (Boolean(params.orderId) || params.ship === 'ask') &&
    !params.storeHandle &&
    !params.feeKind &&
    params.submit !== 'store'
  );
}

/**
 * お店に送る文。頭の一文・(お届け先を聞くときは) お名前とお届け先の空欄・商品・金額・Tx Hash・Explorer のリンク・
 * 確認の署名の順。空欄は書き足しやすいよう頭に置き、長い署名は途中で切れても本文が残るよう最後に置く。
 */
export function notifyShopMessage(input: {
  intro: string;
  fields?: readonly string[];
  itemsLine?: string;
  amountLine: string;
  txHash: string;
  explorerTxUrl?: string;
  signatureLine?: string;
}): string {
  const fields = input.fields ?? [];
  const body = [
    input.itemsLine,
    input.amountLine,
    `Tx Hash: ${input.txHash}`,
    input.explorerTxUrl,
    input.signatureLine,
  ].filter((line): line is string => Boolean(line));
  return [input.intro, ...fields, ...(fields.length > 0 ? [''] : []), ...body].join('\n');
}

/** 完了画面が送る注文の中身 (大きな完了画面と下の欄で同じものを渡す)。 */
export type NotifyShopData = {
  /** 受付番号 (番号つきのリンク)。何度でも使えるリンクでは無い。 */
  orderNo?: string;
  /** 支払いの後にお名前とお届け先を聞く (ship=ask)。 */
  askShipping: boolean;
  storeName?: string;
  items: readonly { name: string; qty: number }[];
  amountDisplay: string;
  txHash: string;
  explorerTxUrl?: string;
  chain: ChainSlug;
  /** お店の受取ウォレット (確認の署名の文に入る)。 */
  shop: Address;
  /** 払ったウォレット (支払いを送った時点の接続先)。署名はこのウォレットでしてもらう。 */
  payer?: Address;
  /**
   * 確認の署名を求めるか。お店が確かめられる支払い (注文リンクの「入金を確かめる」が読む JPYC) だけ。
   * false なら署名の段を出さずに送る。
   */
  confirm: boolean;
  contact?: ShopContact;
};

export function NotifyShopButton({
  orderNo,
  askShipping,
  storeName,
  items,
  amountDisplay,
  txHash,
  explorerTxUrl,
  chain,
  shop,
  payer,
  confirm,
  contact,
  tone,
}: NotifyShopData & { tone: Tone }) {
  const t = useTranslations('SuccessOverlay');
  const textId = useId();
  const copier = useCopyToClipboard();
  const canCopy = useHydrationSafeAvailable(copier.available);
  const canShare = useHydrationSafeAvailable(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  const { address } = useAccount();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const client = usePublicClient({ chainId: chainForSlug(chain).id });
  // 署名はタブに残し、大きな完了画面と下の欄・読み直した画面で共有する。
  const signed = { chain, shop, txHash };
  const signature = useSyncExternalStore(
    subscribeConfirmationSignatures,
    () => storedConfirmationSignature(signed),
    () => null,
  );
  // 払った後に別のウォレットへ切り替えている: その署名はお店の確認で合わないので、署名させずに案内する。
  const otherWallet = confirm && Boolean(payer && address && !isAddressEqual(payer, address));
  const [skipped, setSkipped] = useState(false);
  const [signFailed, setSignFailed] = useState(false);
  // 署名の要求が SIGN_SLOW_MS 返っていない (この回の署名の間だけ数える・押し直すと数え直す)。
  const [signSlow, setSignSlow] = useState(false);
  useEffect(() => {
    if (!signing) return;
    const timer = window.setTimeout(() => setSignSlow(true), SIGN_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [signing]);
  const [status, setStatus] = useState<'idle' | 'shared' | 'copied' | 'failed'>('idle');
  const ready = !confirm || signature !== null || skipped;

  const intro = orderNo
    ? t('notifyShopMessage', { id: orderNo })
    : storeName
      ? t('orderMessageIntro', { store: storeName })
      : t('orderMessageIntroNoStore');
  const text = notifyShopMessage({
    intro,
    fields: askShipping ? [t('orderFieldName'), t('orderFieldAddress')] : undefined,
    itemsLine: askShipping
      ? `${t('orderItemsLabel')}: ${items.map((item) => `${item.name} × ${item.qty}`).join(' / ')}`
      : undefined,
    amountLine: `${t('amountLabel')}: ${amountDisplay}`,
    txHash,
    explorerTxUrl,
    signatureLine: signature ? `${t('signatureLabel')}: ${signature}` : undefined,
  });

  const sign = async () => {
    setSignFailed(false);
    setSignSlow(false);
    const message = orderConfirmationMessage(signed);
    try {
      const result = await signMessageAsync({ message, ...(payer ? { account: payer } : {}) });
      // 払ったウォレットの署名かを、ここでも確かめてから残す (違えばお店の確認で合わず、残すと署名し直せない)。
      // ecrecover で合わなければ、払ったウォレットをコントラクトのウォレット (ERC-1271) として確かめる (持ち主の署名を
      // 返すウォレットがある)。確かめられない (RPC が無い・失敗) ときは残す: お店の側でもう一度確かめる。
      if (payer) {
        const signer = await recoverMessageAddress({ message, signature: recoverableSignature(result) }).catch(
          () => null,
        );
        if (!signer || !isAddressEqual(signer, payer)) {
          const valid = await client?.verifyMessage({ address: payer, message, signature: result }).catch(() => null);
          if (valid === false) {
            setSignFailed(true);
            return;
          }
        }
      }
      storeConfirmationSignature(signed, result);
    } catch {
      // 断った・つながっていない・ウォレットが対応していない: 署名せずに送る道を案内する (掟 13)。
      setSignFailed(true);
    }
  };
  const copy = async () => {
    setStatus((await copier.copy(text)) ? 'copied' : 'failed');
  };
  const share = async () => {
    if (!canShare) {
      await copy();
      return;
    }
    try {
      await navigator.share({ text });
      setStatus('shared');
    } catch {
      // 取り消しは正常系。共有できなくても「文をコピー」が残る (掟 13)。
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-1">
      {contact && <p className={NOTE[tone]}>{t('sendTo', { dest: shopContactLabel(contact) })}</p>}
      {!ready ? (
        <>
          <button type="button" disabled={signing || otherWallet} onClick={() => void sign()} className={PRIMARY[tone]}>
            <PenLine className="h-5 w-5" aria-hidden />
            {signing ? t('signing') : t(askShipping ? 'sendOrder' : 'notifyShop')}
          </button>
          <p className={NOTE[tone]}>{t('signHint')}</p>
          {/* 払えたウォレットは署名もできるので、署名せずに送る道は失敗したとき (断った・読み直しで接続が切れた) と、
              別のウォレットに切り替えているときだけ見せる。 */}
          {(signFailed || otherWallet) && (
            <>
              <p role="status" className={NOTE[tone]}>
                {otherWallet && payer ? t('signSwitchWallet', { payer: shortAddress(payer) }) : t('signFailed')}
              </p>
              <button type="button" onClick={() => setSkipped(true)} className={SECONDARY[tone]}>
                {t('sendWithoutSign')}
              </button>
            </>
          )}
          {/* 署名の要求が返らないまま待っている: 失敗ではないので「署名できませんでした」は出さず、署名せずに送る道だけ
              足す (主ボタンは「署名しています…」のまま・要求は取り消さない)。 */}
          {signing && signSlow && !signFailed && !otherWallet && (
            <button type="button" onClick={() => setSkipped(true)} className={SECONDARY[tone]}>
              {t('sendWithoutSign')}
            </button>
          )}
        </>
      ) : (
        <>
          {confirm && (
            <p className={`inline-flex items-center gap-1 ${NOTE[tone]}`}>
              {signature && <Check className="h-3.5 w-3.5" aria-hidden />}
              {t(signature ? 'signedReady' : 'unsignedReady')}
            </p>
          )}
          {/* 別のアプリを開くのはリンクにする (押した操作そのものなので、ポップアップとして止められない)。 */}
          {contact?.kind === 'line' ? (
            <a href={lineMessageUrl(contact.id, text)} target="_blank" rel="noopener noreferrer" className={PRIMARY[tone]}>
              <MessageCircle className="h-5 w-5" aria-hidden />
              {t('sendByLine')}
            </a>
          ) : contact?.kind === 'mail' ? (
            <a href={mailtoUrl(contact.address, intro, text)} className={PRIMARY[tone]}>
              <Mail className="h-5 w-5" aria-hidden />
              {t('sendByMail')}
            </a>
          ) : (
            <button type="button" onClick={() => void share()} className={PRIMARY[tone]}>
              {canShare ? <Send className="h-5 w-5" aria-hidden /> : <Copy className="h-5 w-5" aria-hidden />}
              {t(canShare ? 'send' : 'notifyShopCopy')}
            </button>
          )}
          <p className={NOTE[tone]}>{t(askShipping ? 'sendOrderHint' : 'notifyShopHint')}</p>
          {contact && canShare && (
            <button type="button" onClick={() => void share()} className={SECONDARY[tone]}>
              <Send className="h-4 w-4" aria-hidden />
              {t('sendOther')}
            </button>
          )}
          {canCopy && (contact || canShare) && (
            <button type="button" onClick={() => void copy()} className={SECONDARY[tone]}>
              <Copy className="h-4 w-4" aria-hidden />
              {t('notifyShopCopy')}
            </button>
          )}
        </>
      )}
      {(status === 'shared' || status === 'copied') && (
        <p role="status" className={`inline-flex items-center gap-1 ${NOTE[tone]}`}>
          <Check className="h-3.5 w-3.5" aria-hidden />
          {t(status === 'shared' ? 'notifyShopShared' : 'notifyShopCopied')}
        </p>
      )}
      {/* コピーもできない環境では、文を選んで写せるように見せる。 */}
      {status === 'failed' && (
        <div className="mt-1 w-full max-w-md">
          <label htmlFor={textId} className={`block ${NOTE[tone]}`}>
            {t('notifyShopTextLabel')}
          </label>
          <textarea
            id={textId}
            readOnly
            value={text}
            rows={6}
            onFocus={(event) => event.target.select()}
            className="mt-1 w-full rounded-lg bg-white px-3 py-2 font-mono text-xs text-slate-700 ring-1 ring-slate-200"
          />
        </div>
      )}
    </div>
  );
}
