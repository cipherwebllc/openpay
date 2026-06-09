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

export function SocialIconLinks({ urls }: { urls: string[] }) {
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
              className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-800"
            >
              <SocialIcon url={url} className="h-5 w-5" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
