'use client';

// @handle 公開ページの link-in-bio ヘッダー。アバター(https URL・無ければ頭文字イニシャル)
// + 名前 + @handle + bio + SNS アイコン行 (Linktree 風・ドメイン自動判定) + 外部リンク。
// リンクは https のみ (保存時に検証済) + rel="noopener noreferrer nofollow" target="_blank"。
// テーマ色は config.color = アクセント。アバターのリング/グロー・@handle・リンクの hover に効かせ、
// 各クリエイターのページに固有の質感を与える (足し算)。決済本体には触れない純表示。
//
// client component: avatar の読込失敗 (onError) でイニシャルに fallback するため。公開ページ
// (server) からもビルダー (client) のプレビューからも同一描画できる。

import { useEffect, useState } from 'react';
import { SocialIconLinks } from '@/components/SocialIconLinks';
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';

const DEFAULT_ACCENT = '#2563eb';

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
  const showAvatarImg = !!profile.avatar && !avatarFailed;
  const socials = profile.socials ?? [];
  const links = profile.links ?? [];

  return (
    <div className="flex flex-col items-center text-center">
      {/* アバター: 白リング + アクセントの細リング + 柔らかいアクセントグロー (浮遊感) */}
      <div
        className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full text-4xl font-bold text-white"
        style={{
          backgroundColor: accent,
          boxShadow: `0 0 0 4px #ffffff, 0 0 0 6px ${accent}33, 0 16px 36px -12px ${accent}59`,
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
        <h1 className="mt-5 text-[1.7rem] font-extrabold leading-tight tracking-tight text-slate-900">
          {config.name}
        </h1>
      )}
      {handle && (
        <p
          className="mt-1 text-sm font-semibold"
          style={{ color: accent }}
        >
          @{handle}
        </p>
      )}
      {profile.bio && (
        <p className="mt-3 max-w-sm whitespace-pre-wrap text-[0.95rem] leading-relaxed text-slate-600">
          {profile.bio}
        </p>
      )}

      {socials.length > 0 && (
        <div className="mt-5">
          <SocialIconLinks urls={socials} />
        </div>
      )}

      {links.length > 0 && (
        <ul className="mt-7 flex w-full flex-col gap-2.5">
          {links.map((l, i) => (
            <li key={`${l.url}-${i}`}>
              <a
                href={l.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="flex w-full items-center justify-center rounded-2xl border border-slate-200/80 bg-white px-4 py-3.5 text-[0.95rem] font-semibold text-slate-800 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.07)] transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_10px_24px_-8px_rgba(15,23,42,0.2)] active:translate-y-0 active:shadow-sm"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
