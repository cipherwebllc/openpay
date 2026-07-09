// @handle の SNS アイコン行 (Linktree 風)。URL のドメインからブランドアイコンを自動判定して
// 横並びの円形リンクで表示する。未知ドメインは汎用 globe。リンクは https のみ (保存時検証済)
// + rel="noopener noreferrer nofollow"。state を持たない純表示なので server からも描画可。

import { Globe } from 'lucide-react';
import {
  detectSocialPlatform,
  socialIconPath,
  socialLabelFor,
} from '@/lib/socialLinks';

/** 単一 SNS アイコン (リンクなし)。ビルダーの入力行プレビューにも使う。 */
export function SocialIcon({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  const path = socialIconPath(detectSocialPlatform(url));
  if (!path) return <Globe className={className} aria-hidden />;
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d={path} />
    </svg>
  );
}

// variant='dark' は night テーマ用 (暗い地色でもアイコンが読めるガラス調)。既定は現行のまま。
const SOCIAL_PILL_CLASS: Record<'default' | 'dark', string> = {
  default:
    'flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-800',
  dark: 'flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 text-slate-200 transition hover:bg-white/20 hover:text-white',
};

export function SocialIconLinks({
  urls,
  variant = 'default',
}: {
  urls: string[];
  variant?: 'default' | 'dark';
}) {
  if (urls.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center justify-center gap-2">
      {urls.map((url, i) => {
        const label = socialLabelFor(url);
        return (
          <li key={`${url}-${i}`}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              aria-label={label}
              title={label}
              className={SOCIAL_PILL_CLASS[variant]}
            >
              <SocialIcon url={url} className="h-5 w-5" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
