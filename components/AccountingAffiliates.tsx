'use client';

// 履歴ページ下部のクラウド会計ソフト アフィリエイト (A8.net・300×250)。
// OpenPay の売上は freee/MF/弥生 形式の CSV 書き出しで記帳できるため文脈的に関連する
// (freee の自動連携は保留中のため、コピーでは CSV 書き出しのみを案内する)。
//
// 注意:
// - これらは A8.net の所定タグ (計測用 bgt バナー + 1x1 0.gif インプレッションビーコン) なので
//   next/image ではなく素の <img> を使う (タグを改変すると計測が壊れる)。
// - rel="nofollow" は A8 規定どおり。target=_blank には noopener を付す (外部遷移の安全策)。
// - 景表法 (ステマ規制) 準拠のため「広告」表記を明示する。

import { useTranslations } from 'next-intl';

type Banner = {
  name: string;
  href: string;
  img: string;
  pixel: string;
};

// A8.net 発行タグ (300×250)。href=計測リンク / img=バナー(兼インプレッション) / pixel=1x1 ビーコン。
const BANNERS: ReadonlyArray<Banner> = [
  {
    name: 'クラウド会計ソフト freee会計',
    href: 'https://px.a8.net/svt/ejp?a8mat=3TEZXT+E97UEQ+3SPO+9FMXR5',
    img: 'https://www27.a8.net/svt/bgt?aid=230807153862&wid=009&eno=01&mid=s00000017718057046000&mc=1',
    pixel: 'https://www10.a8.net/0.gif?a8mat=3TEZXT+E97UEQ+3SPO+9FMXR5',
  },
  {
    name: 'マネーフォワード クラウド会計',
    href: 'https://px.a8.net/svt/ejp?a8mat=4B5NW2+1CTQK2+4JGQ+5ZEMP',
    img: 'https://www21.a8.net/svt/bgt?aid=260604722082&wid=009&eno=01&mid=s00000021185001005000&mc=1',
    pixel: 'https://www14.a8.net/0.gif?a8mat=4B5NW2+1CTQK2+4JGQ+5ZEMP',
  },
  {
    name: 'マネーフォワード クラウド確定申告',
    href: 'https://px.a8.net/svt/ejp?a8mat=3TEZXT+EPVZCI+4JGQ+C2GFL',
    img: 'https://www24.a8.net/svt/bgt?aid=230807153890&wid=009&eno=01&mid=s00000021185002027000&mc=1',
    pixel: 'https://www17.a8.net/0.gif?a8mat=3TEZXT+EPVZCI+4JGQ+C2GFL',
  },
  {
    name: '弥生シリーズ',
    href: 'https://px.a8.net/svt/ejp?a8mat=35UMN6+2JOY42+35XE+661TT',
    img: 'https://www20.a8.net/svt/bgt?aid=191225634154&wid=009&eno=01&mid=s00000014765001036000&mc=1',
    pixel: 'https://www18.a8.net/0.gif?a8mat=35UMN6+2JOY42+35XE+661TT',
  },
];

export function AccountingAffiliates() {
  const t = useTranslations('History');
  return (
    <section className="mt-8 border-t border-slate-100 pt-6">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-bold text-slate-900">{t('affiliateHeading')}</h3>
        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
          {t('affiliateAd')}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{t('affiliateNote')}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        {BANNERS.map((b) => (
          <div key={b.name}>
            <a href={b.href} target="_blank" rel="nofollow noopener noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={b.img}
                alt={b.name}
                width={300}
                height={250}
                className="block h-auto max-w-full rounded border border-slate-200"
              />
            </a>
            {/* A8 インプレッションビーコン (1x1)。装飾扱いで a11y からは隠す。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.pixel} alt="" width={1} height={1} aria-hidden />
          </div>
        ))}
      </div>
    </section>
  );
}
