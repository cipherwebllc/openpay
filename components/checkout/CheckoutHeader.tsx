'use client';

// /checkout (CheckoutForm) の会計の頭の部分 (header): 見出し・店名と店名の注記・受付番号 (または「OpenPay Checkout」)・説明・
// 何度でも使える注文リンク (ship=ask) の案内・支払先の行 (支払先・チェーン名・通貨・ガス代の扱い)・「別のチェーンで払う」ボタン。
// CheckoutForm から切り出した表示だけの部品 (第 9 回レビュー F-04・Q11)。アドレスの短縮表示 (shortAddress)・チェーン名・通貨・
// どの文言を出すかの判定 (受付番号の有無・案内を出すかと送り先の有無・通常決済か) と「別のチェーンで払う」を出すか・押したときに
// 呼ぶ処理 (URL から chain を外して router.replace) は CheckoutForm が決めて渡し、ここは受け取った値を描くだけ (掟 12・15)。
// 要素の形 (header の子の並びと、支払先の行のテキストノードの区切り) は切り出し前の JSX と同じ。
// 描画は tests/components/CheckoutHeader.test.tsx が状態ごとに固定する。

import { useTranslations } from 'next-intl';

type Props = {
  /** 店名 (URL の store・お店が付けた名前)。無ければ店名と注記を出さない。 */
  storeName: string | undefined;
  /** 見出し (受付番号があれば「受付番号 #…」・無ければ「OpenPay Checkout」)。 */
  title: string;
  /** 説明 (URL の description)。無ければ出さない。 */
  description: string | undefined;
  /** 何度でも使える注文リンク (ship=ask) の、払う前の案内。null なら出さない。 */
  shipAskNote: string | null;
  /** 支払先のアドレスの短縮表示 (例 "0x2222…2222")。 */
  payToAddress: string;
  /** 要求のチェーンの名前。 */
  chainName: string;
  /** 通貨の表示名 (JPYC・USDC)。 */
  tokenSymbol: string;
  /** ガス代の扱い (通常決済か、ガス代不要か) の文言。 */
  modeBadge: string;
  /** 「別のチェーンで払う」を出す (受け付けるチェーンが 2 つ以上で、支払いを始めていない)。 */
  canPayOnOtherChain: boolean;
  /** 「別のチェーンで払う」を押したとき (CheckoutForm が URL から chain を外してチェーンを選ぶ画面へ戻す処理を作って渡す)。 */
  onPayOnOtherChain: () => void;
};

export function CheckoutHeader({
  storeName,
  title,
  description,
  shipAskNote,
  payToAddress,
  chainName,
  tokenSymbol,
  modeBadge,
  canPayOnOtherChain,
  onPayOnOtherChain,
}: Props) {
  const t = useTranslations('CheckoutForm');

  return (
    <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs uppercase tracking-wider text-slate-500">
        {t('header')}
      </p>
      {/* 店名 (URL の store・お店が付けた名前)。DM で届いたリンクがどのお店のものかを示す。表示だけで、
          受取先・金額・利用料には関与しない (受取先は下の「支払先」のアドレスが正)。誰でも好きな名前でリンクを
          作れるので、確かめていない名前であることを下に添える (第 9 回レビュー D-1)。 */}
      {storeName && (
        <>
          <p className="mt-1 break-words text-lg font-bold text-slate-900">{storeName}</p>
          <p className="mt-0.5 text-xs text-slate-600 [word-break:auto-phrase]">{t('storeNameUnverified')}</p>
        </>
      )}
      <p className="mt-1 text-base font-semibold text-slate-800">
        {title}
      </p>
      {description && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">
          {description}
        </p>
      )}
      {/* 何度でも使える注文リンク (ship=ask): 払う前に、この後にすることを伝える (お名前とお届け先は自分の LINE や
          メールで送り、OpenPay には入力しない)。送り先は完了画面にも出す。 */}
      {shipAskNote !== null && (
        <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
          {shipAskNote}
        </p>
      )}
      <p className="mt-3 text-xs text-slate-500">
        {t('payToLabel', { addr: payToAddress })} ·{' '}
        {chainName} · {tokenSymbol} ·{' '}
        {modeBadge}
      </p>
      {canPayOnOtherChain && (
        <button
          type="button"
          onClick={onPayOnOtherChain}
          className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:text-brand-dark"
        >
          {t('payOnOtherChain')}
        </button>
      )}
    </header>
  );
}
