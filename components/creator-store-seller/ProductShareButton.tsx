'use client';

// 販売中商品の公開ページ URL をコピーするボタン。持つ state は「コピー済み」表示だけで、
// 私的本文 (content) や下書きは扱わない。

import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';

function copyWithLegacySelection(value: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
}

async function copyProductLink(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Clipboard の許可拒否が共有導線全体へ波及しないよう、旧ブラウザ用の選択コピーへ退避する。
    }
  }
  return copyWithLegacySelection(value);
}

export function ProductShareButton({
  url,
  copyLabel,
  copiedLabel,
  license = false,
}: {
  url: string;
  copyLabel: string;
  copiedLabel: string;
  license?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    if (await copyProductLink(url)) setCopied(true);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`${license ? 'min-h-11 ' : ''}inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand`}
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
