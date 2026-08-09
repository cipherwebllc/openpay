// /guide/pos の描画ヘルパ (components/guide/PosGuidePieces.tsx) を **実描画** で検証する。
//
// LARP 監査の指摘 (描画コードパスが build SSG でしか実行されず assertion が無い) に対応。
// これらは next-intl/AppShell に依存しない純 presentational なので、モックゼロで RTL 実描画し
// 実際の DOM 出力 (img src/dims・marker・badge class・caption 分岐・section 構造) を assert する。

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  BulletList,
  FIGURE_DIMS,
  GuideFigure,
  Section,
  StepList,
} from '@/components/guide/PosGuidePieces';
import { POS_GUIDE } from '@/lib/posGuide';
import { startGuideContentFor } from '@/lib/startGuide';

describe('GuideFigure', () => {
  it('img を /guide/<file> + FIGURE_DIMS の width/height + alt + lazy で描画', () => {
    const { container } = render(
      <GuideFigure image={{ file: 'hero.webp', alt: 'ヒーロー図' }} />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', '/guide/hero.webp');
    expect(img).toHaveAttribute('alt', 'ヒーロー図');
    expect(img).toHaveAttribute('width', String(FIGURE_DIMS['hero.webp'].w));
    expect(img).toHaveAttribute('height', String(FIGURE_DIMS['hero.webp'].h));
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('caption 無し → figcaption を描画しない', () => {
    const { container } = render(
      <GuideFigure image={{ file: 'hero.webp', alt: 'a' }} />,
    );
    expect(container.querySelector('figcaption')).toBeNull();
  });

  it('caption 有り → figcaption に文言を描画', () => {
    render(
      <GuideFigure
        image={{ file: 'hero.webp', alt: 'a' }}
        caption="これは例です"
      />,
    );
    const cap = screen.getByText('これは例です');
    expect(cap.tagName.toLowerCase()).toBe('figcaption');
  });

  it('className 既定は my-6 / 指定で上書き', () => {
    const { container, rerender } = render(
      <GuideFigure image={{ file: 'hero.webp', alt: 'a' }} />,
    );
    expect(container.querySelector('figure')).toHaveClass('my-6');
    rerender(
      <GuideFigure
        image={{ file: 'hero.webp', alt: 'a' }}
        className="mx-auto max-w-[260px]"
      />,
    );
    const fig = container.querySelector('figure');
    expect(fig).toHaveClass('mx-auto', 'max-w-[260px]');
    expect(fig).not.toHaveClass('my-6');
  });
});

describe('BulletList', () => {
  it('items を li 化し marker(aria-hidden) + markerClassName + テキストを描画', () => {
    const { container } = render(
      <BulletList
        items={['りんご', 'みかん']}
        marker="✓"
        markerClassName="text-emerald-600"
      />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('りんご')).toBeInTheDocument();
    expect(screen.getByText('みかん')).toBeInTheDocument();
    const markers = container.querySelectorAll('span[aria-hidden]');
    expect(markers).toHaveLength(2);
    markers.forEach((m) => {
      expect(m).toHaveClass('text-emerald-600');
      expect(m.textContent).toBe('✓');
    });
  });

  it('items 空 → li 0 個', () => {
    const { container } = render(
      <BulletList items={[]} marker="•" markerClassName="text-slate-400" />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });
});

describe('StepList', () => {
  it('steps を n/title/body + badgeClassName で描画', () => {
    const steps = [
      { n: 1, title: 'まず', body: '一歩目' },
      { n: 2, title: 'つぎ', body: '二歩目' },
    ] as const;
    const { container } = render(
      <StepList steps={steps} badgeClassName="bg-emerald-600 text-white" />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('まず')).toBeInTheDocument();
    expect(screen.getByText('一歩目')).toBeInTheDocument();
    expect(screen.getByText('つぎ')).toBeInTheDocument();
    const badge = screen.getByText('1');
    expect(badge).toHaveClass('bg-emerald-600', 'text-white', 'rounded-full');
  });
});

describe('Section', () => {
  it('title を h2 にし children を描画', () => {
    render(
      <Section title="見出しA">
        <p>本文B</p>
      </Section>,
    );
    expect(
      screen.getByRole('heading', { level: 2, name: '見出しA' }),
    ).toBeInTheDocument();
    expect(screen.getByText('本文B')).toBeInTheDocument();
  });
});

// ── L2: FIGURE_DIMS と POS_GUIDE 参照の整合 (黙殺フォールバック防止) ──
describe('FIGURE_DIMS: guide content 参照との整合', () => {
  function collect(value: unknown, acc: Set<string>): void {
    if (Array.isArray(value)) {
      value.forEach((v) => collect(v, acc));
      return;
    }
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o.file === 'string' && typeof o.alt === 'string') acc.add(o.file);
      for (const v of Object.values(o)) collect(v, acc);
    }
  }
  const referenced = new Set<string>();
  collect(POS_GUIDE.ja, referenced);
  collect(POS_GUIDE.en, referenced);
  // FIGURE_DIMS は guide/* 共用テーブル。孤児検出を維持するため他ガイドの参照も集める。
  collect(startGuideContentFor('ja'), referenced);
  collect(startGuideContentFor('en'), referenced);

  it('参照される全 file が FIGURE_DIMS に entry を持つ (?? フォールバック未到達)', () => {
    for (const f of referenced) {
      expect(FIGURE_DIMS[f], `${f} の寸法が未登録 (誤比率描画になる)`).toBeDefined();
    }
  });

  it('FIGURE_DIMS に未参照の孤児 entry が無い', () => {
    for (const f of Object.keys(FIGURE_DIMS)) {
      expect(referenced.has(f), `${f} はどこからも参照されていない`).toBe(true);
    }
  });

  it('全 dims が正の数', () => {
    for (const { w, h } of Object.values(FIGURE_DIMS)) {
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });
});

// ── 実データ統合: 実 POS_GUIDE で描画して src/dims が一致 ──
describe('GuideFigure × 実 POS_GUIDE データ', () => {
  it('heroImage 実描画で src=/guide/<file>・dims=FIGURE_DIMS・alt が一致', () => {
    const img = POS_GUIDE.ja.heroImage;
    const { container } = render(<GuideFigure image={img} />);
    const el = container.querySelector('img');
    expect(el).toHaveAttribute('src', `/guide/${img.file}`);
    expect(el).toHaveAttribute('alt', img.alt);
    expect(el).toHaveAttribute('width', String(FIGURE_DIMS[img.file].w));
    expect(el).toHaveAttribute('height', String(FIGURE_DIMS[img.file].h));
  });
});
