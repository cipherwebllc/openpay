'use client';

// 顧客向け注文ページの **読み取り専用** ビュー: 店舗名 + SNS + メニュー (名前/価格/絵文字/画像)。
// 注文ページ URL (?s=<base64url>) を decodeOrderConfig したものを描画する。
//
// ⚠️ 注文確定・お支払い (都度%原子分割) は money-path かつ開示更新 (P0) ゲートのため **未配線**。
//   本ビューは「準備中」を明示する (P1.2 = 設定/メニュー閲覧まで)。料率は表示しない。

import { useTranslations } from 'next-intl';
import { SocialIconLinks } from '@/components/SocialIconLinks';
import { safeHttpUrl, JPYC_CHAIN_LABEL, type MobileOrderConfig } from '@/lib/mobileOrder';

export function MobileOrderView({ config }: { config: MobileOrderConfig }) {
  const t = useTranslations('MobileOrder');
  // 二重防御: config は https のみへ検証済みだが、注文トークンは attacker-controllable な
  // ので href/src へ描画する直前にも scheme を再確認する (javascript:/data: を排除)。
  // プロフ(@handle) と同じ SocialIconLinks でアイコン行として描画 (ドメイン自動判定)。
  const socialUrls = [safeHttpUrl(config.socials.x), safeHttpUrl(config.socials.instagram)].filter(
    (u): u is string => Boolean(u),
  );
  return (
    <div className="space-y-5">
      <header className="text-center">
        <h1 className="text-xl font-bold text-slate-900">{config.shopName}</h1>
        <p className="mt-1 text-xs text-slate-500">
          {t('viewChainBadge', { chain: JPYC_CHAIN_LABEL[config.chain] })}
        </p>
        {socialUrls.length > 0 && (
          <div className="mt-3">
            <SocialIconLinks urls={socialUrls} />
          </div>
        )}
      </header>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('viewMenuHeading')}</h2>
        <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
          {config.menu.map((item) => {
            const imgUrl = item.visual?.kind === 'image' ? safeHttpUrl(item.visual.url) : undefined;
            return (
              <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="flex min-w-0 items-center gap-2">
                  {item.visual?.kind === 'emoji' && (
                    <span className="text-lg" aria-hidden>
                      {item.visual.value}
                    </span>
                  )}
                  {imgUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imgUrl} alt="" className="h-9 w-9 rounded object-cover" />
                  )}
                  <span className="truncate text-slate-800">{item.name}</span>
                </span>
                <span className="shrink-0 font-semibold text-slate-900">{item.price} JPYC</span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 注文・お支払いは P2 (money-path/開示ゲート) ゆえ未配線。「準備中」を明示。 */}
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-800">
        {t('orderComingSoon')}
      </div>

      <p className="text-center text-xs text-slate-400">{t('poweredBy')}</p>
    </div>
  );
}
