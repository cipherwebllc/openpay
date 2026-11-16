// トップの FAQ (components/LandingFaq.tsx) の行の形。
// 行の余白は質問 (summary) が持つ: details に付けると、押せるのは質問の文字の高さ (20px) だけで、行の余白を押しても開かない
// (plans/lp-polish-2026-11.md P7)。jsdom は CSS を当てないので、どの要素が余白を持つかを class で固定する
// (実際に余白を押して開閉するかは e2e/landing.spec.ts)。Q&A の中身と構造化データとの一致は tests/components/StructuredData.test.tsx。

import { createTranslator } from 'next-intl';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import { LandingFaq } from '@/components/LandingFaq';
import { LANDING_CARD } from '@/components/LandingControls';
import { LANDING_FAQ } from '@/lib/landingFaq';

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getTranslations: async (namespace: 'Landing') => createTranslator({ locale: 'ja', messages: ja, namespace }),
}));

const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
// 余白の class (どの幅・どの条件の指定でも)。
const PADDING = /^(?:[\w-]+:)*-?p[xytblr]?-/;
// 外側の余白 (margin) の class。
const MARGIN = /^(?:[\w-]+:)*-?m[xytblr]?-/;
/** `<prefix>-<数>` の数 (Tailwind の目盛り・1 = 4px)。その指定が無ければ undefined。 */
const scale = (el: Element, name: string) => {
  const token = tokens(el).find((t) => new RegExp(`^${name.replace(/[-:]/g, '\\$&')}-\\d+(?:\\.\\d+)?$`).test(t));
  return token === undefined ? undefined : Number(token.slice(name.length + 1));
};

async function renderRows() {
  const { container } = render(await LandingFaq());
  const rows = [...container.querySelectorAll('details')].map((details) => ({
    details,
    summary: details.querySelector('summary')!,
    question: details.querySelector('summary > span')!,
    answer: details.querySelector('p')!,
  }));
  expect(rows).toHaveLength(LANDING_FAQ.length);
  return { container, rows };
}

describe('LandingFaq: 行の全体を押せる', () => {
  it('行の余白は質問 (summary) が持ち、details は持たない (行の余白を押しても開閉する)', async () => {
    const { rows } = await renderRows();
    for (const { details, summary, answer } of rows) {
      // details の中身は、質問 (summary) と答えの 2 つだけ。
      expect([...details.children]).toEqual([summary, answer]);
      expect(tokens(details).filter((t) => PADDING.test(t) || MARGIN.test(t))).toEqual([]);
      // 左右 20px (sm 以上 24px)・上下 16px (sm 以上 20px) = 余白を details に付けていたときの行の余白。
      expect([scale(summary, 'px'), scale(summary, 'sm:px')]).toEqual([5, 6]);
      expect([scale(summary, 'py'), scale(summary, 'sm:py')]).toEqual([4, 5]);
      expect(tokens(summary).filter((t) => MARGIN.test(t))).toEqual([]);
      expect(tokens(summary)).toContain('cursor-pointer');
    }
  });

  it('開いた姿は今までと同じ位置: 質問と答えの間 12px・答えの左右は質問と同じ・答えの下は閉じた行の下の余白と同じ', async () => {
    const { rows } = await renderRows();
    for (const { details, summary, answer } of rows) {
      // 開いたときだけ、質問の下の余白を 12px にする (どの幅でも・幅の指定より詳細度が高い group-open: で上書き)。
      expect(tokens(details)).toContain('group');
      expect(tokens(summary).filter((t) => PADDING.test(t) && t.includes('group-open:'))).toEqual(['group-open:pb-3']);
      // 答えは外側の余白を持たない (間は質問の下の余白だけ)。上の余白も持たない。
      expect(tokens(answer).filter((t) => MARGIN.test(t))).toEqual([]);
      expect(tokens(answer).filter((t) => /^(?:[\w-]+:)*-?p[yt]?-/.test(t))).toEqual([]);
      expect([scale(answer, 'px'), scale(answer, 'sm:px')]).toEqual([scale(summary, 'px'), scale(summary, 'sm:px')]);
      expect([scale(answer, 'pb'), scale(answer, 'sm:pb')]).toEqual([scale(summary, 'py'), scale(summary, 'sm:py')]);
      // 開いたときの地の色は行の全体 (details)。
      expect(tokens(details)).toContain('open:bg-slate-50/60');
    }
  });

  it('答えの中のリンクは質問 (押すと開閉する範囲) の外にある', async () => {
    const { container, rows } = await renderRows();
    const links = [...container.querySelectorAll('details a')];
    // 料金ページ・JPYC EX・受け取る・割引のガイドへのリンクがある (このテストが空振りしない)。
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const link of links) {
      expect(link.closest('summary')).toBeNull();
      expect(rows.some(({ answer }) => answer.contains(link))).toBe(true);
    }
  });

  it('キーボードの focus の輪は行の内側に描く (外枠の overflow-hidden と角の丸みで切れない)', async () => {
    const { container, rows } = await renderRows();
    // 外枠はカードの型で、はみ出しを切る (行は外枠の端まである)。
    const frame = container.querySelector('ul')!;
    expect(tokens(frame)).toContain('overflow-hidden');
    const rounded = LANDING_CARD.split(/\s+/).filter((t) => /^rounded/.test(t));
    expect(rounded).toHaveLength(1);
    for (const { summary } of rows) {
      const ring = tokens(summary).filter((t) => t.startsWith('focus-visible:'));
      // 2px・内側 2px (負の offset)・紺。角は外枠と同じ丸み (輪が 1 行目と最後の行で外枠の角に切られない)。focus のときの指定はこの 5 つだけ。
      expect(ring.sort()).toEqual(
        ['focus-visible:-outline-offset-2', 'focus-visible:outline', 'focus-visible:outline-2', 'focus-visible:outline-brand', `focus-visible:${rounded[0]}`].sort(),
      );
      // 丸みは focus のときだけ (いつも付けると、行の四隅が押せる範囲から外れる)。
      expect(tokens(summary).filter((t) => /^(?:[\w-]+:)*rounded/.test(t))).toEqual([`focus-visible:${rounded[0]}`]);
    }
  });

  it('質問の折り返し: 文節で折れるブラウザは pretty・折れないブラウザ (WebKit) は行の長さをそろえる (最後の行を 1〜2 字にしない)', async () => {
    const { rows } = await renderRows();
    for (const { question, answer } of rows) {
      const wrap = tokens(question).filter((t) => /(?:^|:)text-(?:balance|pretty|wrap|nowrap)$/.test(t) || t.includes('word-break'));
      expect(wrap.sort()).toEqual(['[word-break:auto-phrase]', 'supports-[word-break:auto-phrase]:text-pretty', 'text-balance']);
      // 答え (本文) は今までどおり: 文節で折れるブラウザだけ pretty。WebKit で行の長さをそろえない (本文の語の途中で折る)。
      const body = tokens(answer).filter((t) => /(?:^|:)text-(?:balance|pretty|wrap|nowrap)$/.test(t) || t.includes('word-break'));
      expect(body.sort()).toEqual(['[word-break:auto-phrase]', 'supports-[word-break:auto-phrase]:text-pretty']);
    }
  });
});
