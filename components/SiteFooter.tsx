// 全 page 共通の footer。app/[locale]/layout.tsx から 1 度だけ render される。
// 役割は (1) legal page (/terms /privacy /disclaimer) への導線、(2) 事業者表記
// + copyright、(3) 技術スタックの soft 表示 (一般向けは「ステーブルコイン決済技術」、
// <details> 展開で ERC-4337 等の技術ラベル開示)。
//
// QR ポスター印刷時は不要なので `print:hidden` で全体を非表示にする。

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { env } from '@/lib/env';
import { isHandlePagePath } from '@/lib/handlePath';
import { LEGAL_ENTITY } from '@/lib/legal';
import {
  DISCORD_ICON_PATH,
  GITHUB_ICON_PATH,
  NOTE_ICON_PATH,
  X_ICON_PATH,
  YOUTUBE_ICON_PATH,
} from '@/lib/socialIconPaths';

// 最下段の SNS・ソースのアイコン行。アイコンは @handle の SNS 行と同じ simple-icons (lib/socialIconPaths.ts)。
// 文字が無いので a11y 名は aria-label (= title のツールチップと同じ文言) で付ける。
// size は見た目の大きさをそろえるための px (横長の YouTube は少し大きく、塗りの多い note は小さく)。
const SOCIAL_LINKS = [
  { href: 'https://x.com/openpay_jp', labelKey: 'xLink', path: X_ICON_PATH, size: 14 },
  { href: 'https://www.youtube.com/@openpay_jp?sub_confirmation=1', labelKey: 'youtubeLink', path: YOUTUBE_ICON_PATH, size: 18 },
  { href: 'https://note.com/masia02/m/mf28261a21eb1', labelKey: 'noteLink', path: NOTE_ICON_PATH, size: 13 },
  { href: 'https://discord.gg/Cfywb3aNWg', labelKey: 'discordLink', path: DISCORD_ICON_PATH, size: 16 },
  { href: 'https://github.com/cipherwebllc/openpay', labelKey: 'sourceLink', path: GITHUB_ICON_PATH, size: 16 },
] as const;

export function SiteFooter() {
  const t = useTranslations('Footer');
  // @handle ページはクリエイターの「自分のページ」— OpenPay 側の宣伝味 (技術開示
  // details・SNS/ソース行・AI ストア導線) は世界観を削るので legal + copyright に
  // 絞る (受取ページ磨き上げ P3・AlphaNotice の @handle 非表示と同じ判定)。
  // ライブラリ導線は購入者に有用なので残す。SSR/provider 無しは pathname が null
  // → フル表示 (従来挙動) でテスト互換。
  const pathname = usePathname();
  const onHandlePage = isHandlePagePath(pathname);
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
        {env.enableX402Facilitator && !onHandlePage && (
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
      {onHandlePage ? null : (
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
      )}
      {onHandlePage ? null : (
      <p className="mt-2 flex items-center justify-center gap-3 text-slate-500">
        {SOCIAL_LINKS.map(({ href, labelKey, path, size }) => (
          <a
            key={labelKey}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(labelKey)}
            title={t(labelKey)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-slate-100 hover:text-slate-700"
          >
            <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d={path} />
            </svg>
          </a>
        ))}
      </p>
      )}
    </footer>
  );
}
