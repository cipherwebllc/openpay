// OpenPay 利用料についての説明 + 応援 (Tip) widget。Server Component。
//
// FAQ の下に置き、(1) 決済手数料は将来も取らない / alpha 無料の方針説明、
// (2) 運営継続のための Tip 導線を兼ねる。Tip widget は実際の /tip ページを
// iframe で埋め込み、来訪者がそのまま応援できる + お試し動線にもなる。
//
// iframe src は canonical な本番 URL (open-pay.jp) を指す。運営の固定受取
// アドレスへの寄付なので、preview/local でも本番 widget を読み込む (お試し含め
// 常に live なエンドポイントを使う)。/tip は TipEmbedGenerator が出力する埋め込み
// 用ページで、同一/外部オリジン双方からの iframe 化を許容する。

import { getTranslations } from 'next-intl/server';

const TIP_ORIGIN = 'https://open-pay.jp';
const TIP_ADDRESS = '0x428483FbA62eDCef1E3a100d3799F6d71759c560';

// 3 種の応援先 (JPYC Polygon / JPYC Kaia / USDC cross-chain)。message は widget の
// 見出しに出る説明文 (URL encode 済)、labelKey は a11y title / caption 用。
const TIP_WIDGETS = [
  {
    labelKey: 'supportTipJpycPolygon',
    src: `${TIP_ORIGIN}/tip/${TIP_ADDRESS}?token=jpyc&name=OpenPay&message=JPYC+Polygon%E3%81%AF%E3%81%93%E3%81%A1%E3%82%89&color=%232563eb`,
  },
  {
    labelKey: 'supportTipJpycKaia',
    src: `${TIP_ORIGIN}/tip/${TIP_ADDRESS}?token=jpyc&chain=kaia&name=OpenPay&message=JPYC+Kaia%E3%81%AF%E3%81%93%E3%81%A1%E3%82%89&color=%232563eb`,
  },
  {
    labelKey: 'supportTipUsdc',
    src: `${TIP_ORIGIN}/tip/${TIP_ADDRESS}?token=usdc&name=OpenPay&message=USDC%E3%82%AF%E3%83%AD%E3%82%B9%E3%83%81%E3%82%A7%E3%83%BC%E3%83%B3Tip&color=%232563eb`,
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
      </div>

      {/* 3 widget を中央寄せ。mobile は 1 列、md+ で横並び。各 iframe は 380×640
          固定だが max-w-full で枠に収め、狭幅でも overflow しない。 */}
      <div className="mt-8 flex flex-wrap justify-center gap-6">
        {TIP_WIDGETS.map(({ labelKey, src }) => {
          const label = t(labelKey);
          return (
            <div key={labelKey} className="flex flex-col items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {label}
              </span>
              <iframe
                src={src}
                width={380}
                height={640}
                title={t('supportTipFrameTitle', { label })}
                loading="lazy"
                className="max-w-full rounded-2xl border border-slate-200 shadow-sm"
                style={{ border: 0 }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
