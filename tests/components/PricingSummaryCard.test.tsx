// 料金がかかる 5 つの場合のカード (components/pricing/PricingPieces.tsx の SummaryCard)。トップの料金の節と /pricing の冒頭が同じ部品。
// スマホでは余白だけを詰める (2026-11-15) が、並びはどの幅でも縦のまま (5 枚の大きい数字の左がそろう・同じ役割は同じ形)、
// 文を隠さない (払う人・最低額・対象は常に見せる・2026-10-12 user 裁定)。DOM の順 (= 読み上げの順) は変えない。
// 実際の見た目 (数字の左がそろうか・詰まりすぎないか) は jsdom では見られないので、実機スクショで見る。

import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import { SummaryCard } from '@/components/pricing/PricingPieces';
import { PRICING } from '@/lib/pricing';

// class の前置き (variant) を全部はがした、末尾の utility。variant は `xxx:` の繰り返しで、角括弧や丸括弧の中の `:`
// (`max-[640px]:`・`supports-[display:grid]:`・`[@media(max-width:639px)]:` など) は区切りに数えない。`!` (important) も外す。
function utilityOf(token: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!|!$/g, '');
}

// 見えなくする・切り詰める utility (どの幅・どの条件の指定でも: max-sm:hidden・max-[640px]:hidden・supports-[…]:sr-only なども)。
const HIDING = /^(?:hidden|sr-only|invisible|collapse|truncate|line-clamp-(?:\d+|\[.+\])|opacity-0|h-0|max-h-0|\[display:none\]|\[visibility:hidden\])$/;
// カード (li) の並びを変える utility。縦 (flex-col) 以外の並びは、どの幅・どの条件の指定でも持たない。
const LAYOUT = /^(?:flex-row|flex-row-reverse|flex-col-reverse|flex-wrap|flex-wrap-reverse|grid|inline-flex|inline-grid|block|contents|items-baseline|\[display:.+\]|\[flex-direction:.+\]|\[flex-wrap:.+\])$/;

describe.each(['ja', 'en'] as const)('%s 料金がかかる場合のカード', (locale) => {
  it.each(PRICING[locale].summary.map((item) => [item.id, item] as const))(
    '%s: 名前・払う人・料金の名前・数字・補足・対象を、この順に縦に描き、どれも隠さない',
    (_, item) => {
      const { container } = render(
        <ul>
          <SummaryCard item={item} />
        </ul>,
      );
      const card = within(container).getByRole('heading', { level: 3, name: item.name }).closest('li')!;
      // 読み上げの順 = DOM の順: 名前 → 払う人 → 料金の名前 → 数字 → 補足 → 対象。
      const parts = [item.name, item.payer.label, item.feeName, item.focal, item.focalSub, item.detail].filter(
        (part): part is string => Boolean(part),
      );
      const text = card.textContent ?? '';
      let from = 0;
      for (const part of parts) {
        const at = text.indexOf(part, from);
        expect(at, part).toBeGreaterThanOrEqual(from);
        from = at + part.length;
      }
      // 並びはどの幅でも縦 (スマホで料金の名前を数字の横に並べると、5 枚の数字の左がそろわない)。
      const cardTokens = (card.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      expect(cardTokens).toContain('flex-col');
      expect(cardTokens.filter((token) => LAYOUT.test(utilityOf(token)))).toEqual([]);
      // カードの中のどの要素にも、見えなくする・切り詰める class が無い。読み上げから外すのは文字の無いアイコンだけ。
      for (const el of [card, ...card.querySelectorAll('*')]) {
        const tokens = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        expect(tokens.filter((token) => HIDING.test(utilityOf(token))), el.outerHTML.slice(0, 80)).toEqual([]);
        if (el.getAttribute('aria-hidden') === 'true') expect(el.textContent).toBe('');
      }
    },
  );
});
