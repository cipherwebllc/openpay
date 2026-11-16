// 日本語の文に、文節の区切り (<wbr>) を入れて返す。Server Component からだけ使う (model は server だけに置く)。
//
// iPhone の Safari (WebKit) と Firefox は、文節で折る CSS (word-break: auto-phrase) を持たず、日本語を字の間のどこでも折る
// (「お店のJPYC決済 / を、利用料0円から。」)。区切りを入れた文は、app/globals.css の .phrased で「区切りでだけ折る」にする。
// Chromium は今までどおり CSS (auto-phrase) で折り、足した <wbr> の所でも折れる (.phrased は Chromium には何も指定しない)。
//
// 決まり:
//   - ja のときだけ。ほかの locale は文字列をそのまま返す (DOM は今までと同じ)。
//   - 塊が 1 つだけ (区切りが無い) なら、span を足さずに文字列をそのまま返す。
//   - 返すのは span 1 つ。<wbr> を親の直接の子にしない (flex の親でも、文は 1 つの子のまま)。
//   - 字は変えない (textContent は元の文と同じ)。
//   - <wbr> には aria-hidden を付ける。付けないと、Chromium は <wbr> の所に空白を入れて見出しの名前を作る
//     (「お店の JPYC決済を、 利用料0円から。」・Accessibility tree で確かめた)。付けると、名前は元の文のまま。
//   - 属性 (aria-label・alt・title) と、client component が template に混ぜる文字列には使わない (文字列のまま渡す)。
//   - 塊が欄より長くなる狭い欄 (スマホで 2 列のカードの本文・表のセル) には使わない: 塊の途中で折れる。
// jsdom のテスト: jsdom は <wbr> の display を空で返すので、tests/setup.ts が inline と教えている (見出しの名前に空白が入らない)。

import 'server-only';
import type { ReactNode } from 'react';
import { phrasesJa } from '@/lib/phrase/phrases';

export function phrased(text: string, locale: string): ReactNode {
  if (locale !== 'ja') return text;
  const parts = phrasesJa(text);
  if (parts.length < 2) return text;
  return (
    <span className="phrased">
      {parts.flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} aria-hidden="true" />, part]))}
    </span>
  );
}
