'use client';

// @handle 公開ページの link-in-bio ヘッダー。アバター(https URL・無ければ頭文字イニシャル)
// + 名前 + bio + 外部リンク。リンクは https のみ (保存時に検証済) + rel="noopener noreferrer
// nofollow" target="_blank"。テーマ色は config.color。決済本体には触れない純表示。
//
// client component: avatar の読込失敗 (onError) でイニシャルに fallback するため。公開ページ
// (server) からもビルダー (client) のプレビューからも同一描画できる。

import { useEffect, useState } from 'react';
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';

const DEFAULT_ACCENT = '#2563eb';

function initialOf(name?: string): string {
  const n = (name ?? '').trim();
  return n ? n.slice(0, 1).toUpperCase() : '@';
}

export function HandleProfileView({
  config,
  profile,
}: {
  config: HandleTipConfig;
  profile: HandleProfile;
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
  const links = profile.links ?? [];

  return (
    <div className="flex flex-col items-center text-center">
      <div
        className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full text-2xl font-bold text-white"
        style={{ backgroundColor: accent }}
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
        <h1 className="mt-3 text-xl font-bold text-slate-800">{config.name}</h1>
      )}
      {profile.bio && (
        <p className="mt-1 max-w-xs whitespace-pre-wrap text-sm text-slate-500">
          {profile.bio}
        </p>
      )}

      {links.length > 0 && (
        <ul className="mt-4 flex w-full flex-col gap-2">
          {links.map((l, i) => (
            <li key={`${l.url}-${i}`}>
              <a
                href={l.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="block w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                style={{ borderColor: accent }}
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
