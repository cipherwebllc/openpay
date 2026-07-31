// 全 page 共通の footer。app/[locale]/layout.tsx から 1 度だけ render される。
// 役割は (1) legal page (/terms /privacy /disclaimer) への導線、(2) 事業者表記
// + copyright、(3) 技術スタックの soft 表示 (一般向けは「ステーブルコイン決済技術」、
// <details> 展開で ERC-4337 等の技術ラベル開示)。
//
// QR ポスター印刷時は不要なので `print:hidden` で全体を非表示にする。

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import { LEGAL_ENTITY } from '@/lib/legal';

export function SiteFooter() {
  const t = useTranslations('Footer');
  const currentYear = new Date().getFullYear();
  // copyrightStartYear と一致したら単年表示、それ以外はレンジ表示。
  const yearLabel =
    currentYear === LEGAL_ENTITY.copyrightStartYear
      ? `${currentYear}`
      : `${LEGAL_ENTITY.copyrightStartYear}-${currentYear}`;

  return (
    // pb は mobile で AppShell の fixed BottomNav (~52px) と被らないよう余裕を取る。
    // md 以上は BottomNav が消えるため通常 pb-10 で OK。
    <footer className="mx-auto mt-12 w-full max-w-5xl px-4 pb-24 text-center text-xs text-slate-500 md:pb-10 print:hidden">
      <nav
        aria-label="Legal"
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
      >
        {/* 取引履歴は AppShell のメインメニューにあるため Footer からは外す。 */}
        <Link href="/terms" className="hover:text-slate-700 hover:underline" prefetch={false}>
          {t('links.terms')}
        </Link>
        <Link href="/privacy" className="hover:text-slate-700 hover:underline" prefetch={false}>
          {t('links.privacy')}
        </Link>
        <Link
          href="/disclaimer"
          className="hover:text-slate-700 hover:underline"
          prefetch={false}
        >
          {t('links.disclaimer')}
        </Link>
        <Link
          href="/tokutei"
          className="hover:text-slate-700 hover:underline"
          prefetch={false}
        >
          {t('links.tokutei')}
        </Link>
        <Link
          href="/transparency"
          className="hover:text-slate-700 hover:underline"
          prefetch={false}
        >
          {t('links.transparency')}
        </Link>
        {/* /discovery は flag OFF で notFound になるため、OFF 環境では 404 導線を出さない。 */}
        {env.enableX402Facilitator && (
          <Link
            href="/discovery"
            className="hover:text-slate-700 hover:underline"
            prefetch={false}
          >
            {t('links.discovery')}
          </Link>
        )}
        {/* /store/library も同様に flag OFF で notFound のため OFF 環境では出さない。
            購入完了画面以外で唯一の常設導線 (2026-07-31 user 指摘で追加)。 */}
        {env.enableCreatorStoreUi && (
          <Link
            href="/store/library"
            className="hover:text-slate-700 hover:underline"
            prefetch={false}
          >
            {t('links.storeLibrary')}
          </Link>
        )}
      </nav>
      <p className="mt-3 text-slate-500">
        {t('copyright', {
          year: yearLabel,
          company: LEGAL_ENTITY.companyName,
        })}
      </p>
      {/* 一般店主には Web3 用語 (ERC-4337 等) は不要だが、開発者向け透明性は
          残したいので <details> で折り畳む。summary は soft な日本語/英語、
          展開時に技術ラベルを表示。review (2026-05-23) #15 対応。 */}
      <details className="mt-1 inline-block text-slate-500 marker:hidden">
        {/* min-h + inline-flex で tap target 高さを 24px 以上に確保 (a11y target-size)。
            inline-flex のままなので <details> の inline-block レイアウトは不変。 */}
        <summary className="inline-flex min-h-[24px] cursor-pointer list-none items-center justify-center hover:text-slate-700">
          {t('poweredBySoft')}{' '}
          <span className="text-[10px] underline-offset-2 hover:underline">
            ({t('poweredByExpand')})
          </span>
        </summary>
        <span className="ml-1">{t('poweredByTech')}</span>
      </details>
      <p className="mt-1 flex items-center justify-center gap-3 text-slate-500">
        <a
          href="https://github.com/cipherwebllc/openpay"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-slate-700 hover:underline"
        >
          {t('sourceLink')}
        </a>
        <a
          href="https://x.com/openpay_jp"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('xLink')}
          title={t('xLink')}
          className="inline-flex h-6 w-6 items-center justify-center hover:text-slate-700"
        >
          <XIcon />
        </a>
        <a
          href="https://discord.gg/Cfywb3aNWg"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('discordLink')}
          title={t('discordLink')}
          className="inline-flex h-6 w-6 items-center justify-center hover:text-slate-700"
        >
          <DiscordIcon />
        </a>
        {/* note は公式の標準アイコンが無いためテキストリンク (sourceLink と同方針)。 */}
        <a
          href="https://note.com/masia02/m/mf28261a21eb1"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-slate-700 hover:underline"
        >
          {t('noteLink')}
        </a>
      </p>
    </footer>
  );
}

// X (旧 Twitter) 公式ロゴ。2023 改名後の現行マーク。viewBox 0 0 24 24、
// fill=currentColor で親 <a> の color を継承し hover 時に slate-700 へ追従する。
function XIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

// Discord 公式ロゴ (Clyde マーク)。viewBox 0 0 24 24、fill=currentColor で
// 親 <a> の color を継承し hover 時に slate-700 へ追従する (XIcon と同パターン)。
function DiscordIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}
