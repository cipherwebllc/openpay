'use client';

// コード欄の「コピー」ボタン (plans/guide-ux-polish.md フェーズ 3)。設定 JSON など「貼る」ためのコードは、
// スマホでは横スクロールの先が見えないので、全文をそのまま写せるようにする。
// 名前は可視の文字・aria-label は使わない (掟 8)。言語は <html lang> を CSS の :lang で見て ja / en の文字を
// 出し分ける (CodeBlock は server でも jsdom でも描くので、next-intl の provider に頼らない)。隠した側は
// display:none なので読み上げの名前にも入らない。
// クリップボードが使えない環境では何もしない (コードは画面に出ているので選んで写せる)。

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

const JA = '[:lang(en)_&]:hidden';
const EN = 'hidden [:lang(en)_&]:inline';

export function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードの権限が無いなど。コードは画面に出ているので、手で選んで写せる (失敗を本文へ波及させない)。
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-200 [@media(hover:hover)]:hover:bg-slate-50"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      <span aria-live="polite">
        <span className={JA}>{copied ? 'コピーしました' : 'コピー'}</span>
        <span className={EN}>{copied ? 'Copied' : 'Copy'}</span>
      </span>
    </button>
  );
}
