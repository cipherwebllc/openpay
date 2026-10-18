// ガイドの右の列の「このページの内容」(xl 以上)。同じ frame の article の h2 を集め、data-toc="skip" を除き、
// 名前は data-toc-label を優先、id が無ければ skip を除いた並びの section-<番号> を振る (GuideToc と同じ規則)。見出しが 2 つ未満なら出さない。

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GuideOnThisPage } from '@/components/guide/GuideOnThisPage';

function renderFrame(headings: React.ReactNode) {
  return render(
    <div data-guide-frame>
      <article>{headings}</article>
      <GuideOnThisPage title="このページの内容" />
    </div>,
  );
}

describe('GuideOnThisPage', () => {
  it('h2 を順に並べ、skip を除き、data-toc-label を名前に、id の無い見出しに id を振る', () => {
    renderFrame(
      <>
        <h2 id="prepare" data-toc-label="JPYC を準備する">
          <span>1</span>JPYC を準備する
        </h2>
        <h2 data-toc="skip">動画で見る</h2>
        <h2>売上はその場でウォレットへ</h2>
      </>,
    );
    const nav = screen.getByRole('navigation', { name: 'このページの内容' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['JPYC を準備する', '#prepare'],
      ['売上はその場でウォレットへ', '#section-2'],
    ]);
    expect(screen.getByRole('heading', { name: '売上はその場でウォレットへ' })).toHaveAttribute('id', 'section-2');
    // 読んでいる節は 1 つだけ (aria-current=location)。
    expect(links.filter((a) => a.getAttribute('aria-current') === 'location')).toHaveLength(1);
  });

  it('見出しが 1 つだけのページには何も出さない', () => {
    const { container } = renderFrame(<h2>ひとつだけ</h2>);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
  });
});
