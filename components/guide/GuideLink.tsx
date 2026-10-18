// ガイドのリンクの 2 つの型 (plans/guide-ux-polish-2.md P5)。以前は太字 + 文字の「→」・細字の下線・灰色の下線などが
// ページごとに混ざっていた。
//   - 段落の外に 1 行で置くリンク (続きを読む・公式サイトへ): GuideMoreLink = 太字の緑 + 矢印のアイコン。
//     サイト内は →、別サイト (別タブで開く) は ↗ で見分ける。
//   - 文の中のリンク: GUIDE_INLINE_LINK = 細字の緑 + 下線。
// 矢印は飾り (aria-hidden)・リンクの名前は可視の文字だけ (掟 8)。hook を使わない同期の部品。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';

export const GUIDE_INLINE_LINK =
  'font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900';

const MORE_LINK = 'group inline-flex items-center gap-1 text-sm font-semibold text-emerald-700 hover:text-emerald-900';
const ARROW = 'h-3.5 w-3.5 shrink-0 transition-transform';

export function GuideMoreLink({
  href,
  children,
  external = false,
  className,
}: {
  href: string;
  children: ReactNode;
  /** true: 別サイトを別タブで開く (↗)。 */
  external?: boolean;
  className?: string;
}) {
  const cls = className ? `${MORE_LINK} ${className}` : MORE_LINK;
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {children}
        <ArrowUpRight className={`${ARROW} group-hover:-translate-y-0.5 group-hover:translate-x-0.5`} aria-hidden />
      </a>
    );
  }
  return (
    <Link href={href} prefetch={false} className={cls}>
      {children}
      <ArrowRight className={`${ARROW} group-hover:translate-x-0.5`} aria-hidden />
    </Link>
  );
}

/**
 * 実例の取引 (エクスプローラー) へのリンク。66 文字のハッシュをそのまま出すと段落が崩れるので、頭と末尾だけを
 * 等幅で見せる (0xa9e6…3249)。全体は title とリンク先で確かめられる。
 */
export function GuideTxLink({ href, hash }: { href: string; hash: string }) {
  const short = /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      className={`inline-flex items-center gap-0.5 font-mono ${GUIDE_INLINE_LINK}`}
    >
      {short}
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
    </a>
  );
}
