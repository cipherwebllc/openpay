'use client';

// 出品者向けのゲート (402) スニペット表示。登録結果・gate_not_openpay エラー・要対応カードで使う。
// 公開カタログは使わないので、共有の discoveryDisplay ではなく出品者側の leaf として置く。

import { Check, Copy } from 'lucide-react';

export function PaywallSnippet({
  snippet,
  copyKey,
  copied,
  onCopy,
  title,
  copyLabel,
  copiedLabel,
}: {
  snippet: string;
  copyKey: string;
  copied: boolean;
  onCopy: (key: string, text: string) => void;
  title: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div className="mt-2">
      <p className="text-xs text-slate-500">{title}</p>
      <div className="relative mt-1">
        <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 pr-28 text-xs leading-relaxed text-slate-100">
          {snippet}
        </pre>
        <button
          type="button"
          onClick={() => onCopy(copyKey, snippet)}
          className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-2 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-slate-700"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
          <span>{copied ? copiedLabel : copyLabel}</span>
        </button>
      </div>
    </div>
  );
}
