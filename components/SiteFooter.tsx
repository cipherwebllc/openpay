// 全 page 共通の footer。app/[locale]/layout.tsx から 1 度だけ render される。
// 役割は (1) legal page (/terms /privacy /disclaimer) への導線、(2) 事業者表記
// + copyright、(3) お問い合わせ (Discord) と SNS 行。技術スタックの羅列はここに置かない
// (技術は運用透明性ページと GitHub にある・2026-10-25 user 裁定)。
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

// 公開のメールアドレスは載せず、お問い合わせの行き先は Discord (2026-10-25 user 裁定)。SNS 行の Discord と同じ URL を共有する。
const DISCORD_URL = 'https://discord.gg/Cfywb3aNWg';

// 最下段の SNS・ソースのアイコン行。アイコンは @handle の SNS 行と同じ simple-icons (lib/socialIconPaths.ts)。
// 文字が無いので a11y 名は aria-label (= title のツールチップと同じ文言) で付ける。
// size は見た目の大きさをそろえるための px (横長の YouTube は少し大きく、塗りの多い note は小さく)。
const SOCIAL_LINKS = [
  { href: 'https://x.com/openpay_jp', labelKey: 'xLink', path: X_ICON_PATH, size: 14 },
  { href: 'https://www.youtube.com/@openpay_jp?sub_confirmation=1', labelKey: 'youtubeLink', path: YOUTUBE_ICON_PATH, size: 18 },
  { href: 'https://note.com/masia02/m/mf28261a21eb1', labelKey: 'noteLink', path: NOTE_ICON_PATH, size: 13 },
  { href: DISCORD_URL, labelKey: 'discordLink', path: DISCORD_ICON_PATH, size: 16 },
  { href: 'https://github.com/cipherwebllc/openpay', labelKey: 'sourceLink', path: GITHUB_ICON_PATH, size: 16 },
] as const;

export function SiteFooter() {
  const t = useTranslations('Footer');
  // @handle ページはクリエイターの「自分のページ」— OpenPay 側の宣伝味 (技術開示
  // details・SNS/ソース行・AI ストア導線) は世界観を削るので legal + copyright に
  // 絞る (受取ページ磨き上げ P3・AlphaNotice の @handle 非表示と同じ判定)。ガイド (/guide) の導線も同じ扱い。
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
      {/* ランドマーク名は messages から読む (以前は英語の直書きで /ja でも英語が読まれていた・全レビュー第 8 回 D-4)。 */}
      <nav
        aria-label={t('navLabel')}
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
      >
        {/* 取引履歴は AppShell のメインメニューにあるため Footer からは外す。 */}
        {/* 全ガイドのハブ (/guide) を先頭に。@handle ページでは AI ストアと同じく OpenPay 側の導線なので出さない。 */}
        {!onHandlePage && (
          <Link href="/guide" className="hover:text-slate-700 hover:underline" prefetch={false}>
            {t('links.guides')}
          </Link>
        )}
        {/* 料金 (/pricing) は「ガイド」の直後。ガイドと違い @handle ページでも出す: 特商法・運用透明性と同じ
            開示寄りのリンクで、チップ・デジタル商品の買い手がだれが何を払うかを確かめられるようにする
            (plans/pricing-page.md §2.6)。 */}
        <Link href="/pricing" className="hover:text-slate-700 hover:underline" prefetch={false}>
          {t('links.pricing')}
        </Link>
        <Link href="/terms" className="hover:text-slate-700 hover:underline" prefetch={false}>
          {t('links.terms')}
        </Link>
        <Link href="/privacy" className="hover:text-slate-700 hover:underline" prefetch={false}>
          {t('links.privacy')}
        </Link>
        {/* 外部送信規律の公表 (プライバシーポリシー 3-3) への直リンク。全ページのフッターから辿れるようにする。 */}
        <Link href="/privacy#external" className="hover:text-slate-700 hover:underline" prefetch={false}>
          {t('links.external')}
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
        {/* お問い合わせ (Discord)。@handle ページでは SNS 行と同じく OpenPay 側の導線なので出さない。 */}
        {!onHandlePage && (
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-slate-700 hover:underline"
          >
            {t('links.contact')}
          </a>
        )}
      </nav>
      <p className="mt-3 text-slate-500">
        {t('copyright', {
          year: yearLabel,
          company: LEGAL_ENTITY.companyName,
        })}
      </p>
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
