'use client';

// @handle 公開ページの link-in-bio ヘッダー。アバター(https URL・無ければ頭文字イニシャル)
// + 名前 + @handle + bio + SNS アイコン行 (Linktree 風・ドメイン自動判定) + 外部リンク。
// リンクは https のみ (保存時に検証済) + rel="noopener noreferrer nofollow" target="_blank"。
// テーマ色は config.color = アクセント。アバターのリング/グロー・@handle・リンクの hover に効かせ、
// 各クリエイターのページに固有の質感を与える (足し算)。決済本体には触れない純表示。
//
// 着せ替えテーマ (profile.theme): clean(既定)/gradient/bold/outline/night/soft。トークンは
// lib/handleTheme に集約 (server の page.tsx と共有)。**clean は現行の className を一切変えず
// (inline style を付けず) 描画する = 現行レコードのピクセル一致を担保**。他テーマだけ inline
// style で上書きする。リンクの絵文字 (先頭・aria-hidden) と「注目」(featured・最大 1 本・少し
// 大きく強調) も Phase 1 で追加。
//
// client component: avatar の読込失敗 (onError) でイニシャルに fallback するため。公開ページ
// (server) からもビルダー (client) のプレビューからも同一描画できる。

import { useEffect, useState } from 'react';
import { SocialIconLinks } from '@/components/SocialIconLinks';
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';
import { handleViewTheme, resolveHandleTheme } from '@/lib/handleTheme';

const DEFAULT_ACCENT = '#2563eb';

// clean (現行) の通常リンク className。**この文字列は現行レコードのピクセル一致の基準**
// なので変更しないこと (clean かつ非 featured のときだけ inline style 無しでこれを使う)。
const CLEAN_LINK_CLASS =
  'flex w-full items-center justify-center rounded-2xl border border-slate-200/80 bg-white px-4 py-3.5 text-[0.95rem] font-semibold text-slate-800 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_10px_24px_-8px_rgba(15,23,42,0.2)] active:translate-y-0 active:shadow-sm';

// 非 clean テーマ / featured リンクのレイアウト用 base (配色は inline style で上書き)。
const THEMED_LINK_BASE =
  'flex w-full items-center justify-center rounded-2xl px-4 py-3.5 text-[0.95rem] font-semibold transition-all duration-200 hover:-translate-y-0.5';
// featured は少し大きく (py 増し + text 大) して主役リンクを際立たせる。
const FEATURED_LINK_BASE =
  'flex w-full items-center justify-center rounded-2xl px-4 py-4 text-base font-bold transition-all duration-200 hover:-translate-y-1';

function initialOf(name?: string): string {
  const n = (name ?? '').trim();
  // コードポイント単位で先頭1文字 (絵文字/補助漢字 𠮷 を割って tofu にしない)。
  return n ? ([...n][0] ?? '').toUpperCase() : '@';
}

export function HandleProfileView({
  config,
  profile,
  handle,
}: {
  config: HandleTipConfig;
  profile: HandleProfile;
  handle?: string;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  // avatar URL を変えたら失敗状態をリセット (ビルダーで誤 URL を直したのに fallback が残らない)。
  useEffect(() => {
    setAvatarFailed(false);
  }, [profile.avatar]);
  const accent =
    config.color && /^#[0-9a-fA-F]{6}$/.test(config.color)
      ? config.color
      : DEFAULT_ACCENT;
  const themeName = resolveHandleTheme(profile.theme);
  const tk = handleViewTheme(accent, themeName);
  const isClean = themeName === 'clean';
  const showAvatarImg = !!profile.avatar && !avatarFailed;
  const socials = profile.socials ?? [];
  const links = profile.links ?? [];

  return (
    <div className="flex flex-col items-center text-center">
      {/* アバター: 白リング + アクセントの細リング + 柔らかいアクセントグロー (浮遊感)。
          リングはテーマごとに切替 (night は外リングを #0f172a 基調に)。 */}
      <div
        className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full text-4xl font-bold text-white"
        style={{
          backgroundColor: accent,
          boxShadow: tk.avatarRing,
        }}
      >
        {showAvatarImg ? (
          // 任意の第三者 https 画像。referrerPolicy で hotlink トラッキングを抑制。
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.avatar}
            alt={config.name ? config.name : ''}
            referrerPolicy="no-referrer"
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <span aria-hidden>{initialOf(config.name)}</span>
        )}
      </div>

      {config.name && (
        <h1
          className={`mt-5 text-[1.7rem] font-extrabold leading-tight tracking-tight${
            tk.inkColor ? '' : ' text-slate-900'
          }`}
          style={tk.inkColor ? { color: tk.inkColor } : undefined}
        >
          {config.name}
        </h1>
      )}
      {handle && (
        <p
          className="mt-1 text-sm font-semibold"
          style={{ color: tk.handleColor }}
        >
          @{handle}
        </p>
      )}
      {profile.bio && (
        <p
          className={`mt-3 max-w-sm whitespace-pre-wrap text-[0.95rem] leading-relaxed${
            tk.bioColor ? '' : ' text-slate-600'
          }`}
          style={tk.bioColor ? { color: tk.bioColor } : undefined}
        >
          {profile.bio}
        </p>
      )}

      {socials.length > 0 && (
        <div className="mt-5">
          <SocialIconLinks urls={socials} variant={tk.socialVariant} />
        </div>
      )}

      {links.length > 0 && (
        <ul className="mt-7 flex w-full flex-col gap-2.5">
          {links.map((l, i) => {
            const featured = l.featured === true;
            // clean かつ非 featured のときだけ現行 className をそのまま使い inline style を付けない
            // (= 現行レコードのピクセル一致)。それ以外はテーマ/featured の inline style を適用。
            const useCleanClass = isClean && !featured;
            const className = useCleanClass
              ? CLEAN_LINK_CLASS
              : featured
                ? FEATURED_LINK_BASE
                : THEMED_LINK_BASE;
            const style = useCleanClass
              ? undefined
              : featured
                ? tk.featuredStyle
                : tk.linkStyle;
            return (
              <li key={`${l.url}-${i}`}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className={className}
                  style={style}
                >
                  {l.emoji && (
                    // 絵文字はテキストノードとして描画 (HTML 解釈なし)。a11y 名は label から
                    // 導出させるため aria-hidden (絵文字がリンク名に混ざるのを防ぐ)。
                    <span className="mr-1.5" aria-hidden>
                      {l.emoji}
                    </span>
                  )}
                  {l.label}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
