// OpenPay 利用料の早見カード (決済QR / レジ / モバイル注文 / チップ) + 運営応援 (Tip) リンク。
// Server Component。FAQ の下に置く。
//
// 料率カードは LandingBenefits と同じビッグナンバー様式で 4 方法の OpenPay 利用料を簡潔に提示する
// (文言は lib/legal.ts の DISCLOSED 定数と整合・drift は tests/lib/landingFeeDisclosure.test.ts で固定)。
// Tip は /tip ページへの link button で提示し (iframe 3 連は縦に長く見映えが悪いため)、新規タブで
// 開いて応援できる。link href は canonical な本番 URL (open-pay.jp) を指す (運営の固定受取アドレス
// への寄付なので preview/local でも本番ページへ遷移する)。

import { getTranslations } from 'next-intl/server';
import { Heart, QrCode, Calculator, Smartphone, Coins } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const TIP_ORIGIN = 'https://open-pay.jp';
const TIP_ADDRESS = '0x428483FbA62eDCef1E3a100d3799F6d71759c560';

// 利用料カード。id から `supportFee${id}{Focal,Title,Body}` の 3 key を派生 (LandingBenefits と同型)。
type FeeId = 'Pay' | 'Register' | 'Mobile' | 'Tip';
const FEE_CARDS: readonly { id: FeeId; Icon: LucideIcon }[] = [
  { id: 'Pay', Icon: QrCode },
  { id: 'Register', Icon: Calculator },
  { id: 'Mobile', Icon: Smartphone },
  { id: 'Tip', Icon: Coins },
];

// 応援先。ERC20 (JPYC Polygon / JPYC Kaia / USDC cross-chain) + ネイティブ
// (POL / KAIA)。message は Tip ページ見出しに出る説明文 (URL encode 済)、labelKey は
// button ラベル用。native=polygon|kaia は NativeTipForm (素のネイティブ送金) へ遷移する。
const TIP_LINKS = [
  {
    labelKey: 'supportTipJpycPolygon',
    href: `${TIP_ORIGIN}/tip/${TIP_ADDRESS}?token=jpyc&name=OpenPay&message=JPYC+Polygon%E3%81%AF%E3%81%93%E3%81%A1%E3%82%89&color=%232563eb`,
  },
  {
    labelKey: 'supportTipJpycKaia',
    href: `${TIP_ORIGIN}/tip/${TIP_ADDRESS}?token=jpyc&chain=kaia&name=OpenPay&message=JPYC+Kaia%E3%81%AF%E3%81%93%E3%81%A1%E3%82%89&color=%232563eb`,
  },
  {
    labelKey: 'supportTipUsdc',
    href: `${TIP_ORIGIN}/tip/${TIP_ADDRESS}?token=usdc&name=OpenPay&message=USDC%E3%82%AF%E3%83%AD%E3%82%B9%E3%83%81%E3%82%A7%E3%83%BC%E3%83%B3Tip&color=%232563eb`,
  },
  {
    labelKey: 'supportTipPol',
    href: `${TIP_ORIGIN}/tip/${TIP_ADDRESS}?native=polygon&name=OpenPay&color=%232563eb`,
  },
  {
    labelKey: 'supportTipKaia',
    href: `${TIP_ORIGIN}/tip/${TIP_ADDRESS}?native=kaia&name=OpenPay&color=%232563eb`,
  },
] as const;

export async function LandingSupport() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('supportTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('supportSubtitle')}</p>
      </div>

      {/* 4 方法の利用料カード (導入メリットと同じビッグナンバー様式)。focal は "1% / 3%" が
          最も幅広いため text-3xl/4xl (benefits より一段小さめ) で 2 列でも 1 行に収める。 */}
      <ul className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {FEE_CARDS.map(({ id, Icon }) => (
          <li
            key={id}
            className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-card"
          >
            <Icon className="h-5 w-5 text-brand" aria-hidden />
            <p className="mt-4 whitespace-nowrap break-keep text-3xl font-extrabold leading-none text-brand sm:text-4xl">
              {t(`supportFee${id}Focal`)}
            </p>
            <h3 className="mt-3 text-sm font-semibold text-slate-900 sm:text-base">
              {t(`supportFee${id}Title`)}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
              {t(`supportFee${id}Body`)}
            </p>
          </li>
        ))}
      </ul>

      <p className="mx-auto mt-6 max-w-2xl text-center text-xs leading-relaxed text-slate-500">
        {t('supportFeeNote')}
      </p>

      <div className="mx-auto mt-10 max-w-3xl text-center">
        <p className="text-sm font-medium leading-relaxed text-slate-700">
          {t('supportTipRequest')}
        </p>

        {/* 応援 link button。mobile は縦積み (full width)、sm+ で横並び。 */}
        <div className="mt-6 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center sm:flex-wrap">
          {TIP_LINKS.map(({ labelKey, href }) => {
            const label = t(labelKey);
            return (
              <a
                key={labelKey}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-brand/30 bg-brand/5 px-5 py-3 text-sm font-semibold text-brand-dark transition hover:border-brand hover:bg-brand/10"
              >
                <Heart className="h-4 w-4 flex-none" aria-hidden />
                {t('supportTipButton', { label })}
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}
