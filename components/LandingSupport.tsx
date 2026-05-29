// OpenPay 利用料についての説明 + 応援 (Tip) リンク。Server Component。
//
// FAQ の下に置き、(1) 決済手数料は将来も取らない / alpha 無料の方針説明、
// (2) 運営継続のための Tip 導線を兼ねる。Tip は /tip ページへの link button で
// 提示し (iframe 3 連は縦に長く見映えが悪いため)、新規タブで開いて応援できる。
//
// link href は canonical な本番 URL (open-pay.jp) を指す。運営の固定受取アドレス
// への寄付なので preview/local でも本番ページへ遷移する。

import { getTranslations } from 'next-intl/server';
import { Heart } from 'lucide-react';

const TIP_ORIGIN = 'https://open-pay.jp';
const TIP_ADDRESS = '0x428483FbA62eDCef1E3a100d3799F6d71759c560';

// 3 種の応援先 (JPYC Polygon / JPYC Kaia / USDC cross-chain)。message は Tip ページ
// 見出しに出る説明文 (URL encode 済)、labelKey は button ラベル用。
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
] as const;

export async function LandingSupport() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('supportTitle')}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          {t('supportBody')}
        </p>
        <p className="mt-2 text-sm font-medium leading-relaxed text-slate-700">
          {t('supportTipRequest')}
        </p>

        {/* 3 つの応援 link button。mobile は縦積み (full width)、sm+ で横並び。 */}
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
