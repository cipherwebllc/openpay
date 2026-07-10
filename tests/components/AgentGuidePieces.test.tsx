// /guide/agent の追加描画ヘルパ (components/guide/AgentGuidePieces.tsx) を **実描画** で検証する。
//
// next-intl/AppShell に依存しない純 presentational なので、モックゼロで RTL 実描画し実 DOM を assert する
// (PosGuidePieces.test.tsx と同思想)。実 AGENT_GUIDE データでも描画して src/文言の整合を確認する。

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AddressCallout,
  CodeBlock,
  GuideHero,
} from '@/components/guide/AgentGuidePieces';
import { AGENT_GUIDE } from '@/lib/agentGuide';

describe('CodeBlock', () => {
  it('code を pre>code に描画し overflow-x-auto で水平スクロール', () => {
    const { container } = render(<CodeBlock code={'{\n  "a": 1\n}'} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveClass('overflow-x-auto');
    expect(pre?.querySelector('code')?.textContent).toBe('{\n  "a": 1\n}');
  });

  it('label 有り → 見出し文言を描画 / 無し → 描画しない', () => {
    const { rerender } = render(<CodeBlock code="x" label="設定例" />);
    expect(screen.getByText('設定例')).toBeInTheDocument();
    rerender(<CodeBlock code="x" />);
    expect(screen.queryByText('設定例')).toBeNull();
  });
});

describe('AddressCallout', () => {
  it('address をモノスペース(break-all)で描画し label / chainNote / legacyWarning を出す', () => {
    const { container } = render(
      <AddressCallout
        label="JPYC アドレス"
        address="0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29"
        chainNote="4 チェーン共通"
        legacyWarning="旧 v1 に注意"
      />,
    );
    const addr = screen.getByText('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
    expect(addr).toHaveClass('font-mono', 'break-all');
    expect(screen.getByText('JPYC アドレス')).toBeInTheDocument();
    expect(screen.getByText('4 チェーン共通')).toBeInTheDocument();
    expect(screen.getByText('旧 v1 に注意')).toBeInTheDocument();
    // 装飾のみの div ではなくテキストが実在すること
    expect(container.textContent).toContain('0xE7C3D8C9');
  });
});

describe('GuideHero', () => {
  it('src/alt/width/height を持つ img を描画する (CLS 防止の寸法明示)', () => {
    render(
      <GuideHero
        image={{ src: '/guide-agent/hero.webp', alt: '3 画面の流れ', width: 1600, height: 840 }}
      />,
    );
    const img = screen.getByAltText('3 画面の流れ') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/guide-agent/hero.webp');
    expect(img.getAttribute('width')).toBe('1600');
    expect(img.getAttribute('height')).toBe('840');
  });

  it('実 AGENT_GUIDE.heroImage で描画でき alt が非空', () => {
    render(<GuideHero image={AGENT_GUIDE.ja.heroImage} />);
    expect(screen.getByAltText(AGENT_GUIDE.ja.heroImage.alt)).toBeInTheDocument();
  });
});

// ── 実データ統合: 実 AGENT_GUIDE で描画して表示アドレス/設定が一致 ──
describe('AgentGuidePieces × 実 AGENT_GUIDE データ', () => {
  it('AddressCallout が実 jpycAddress を表示する', () => {
    const c = AGENT_GUIDE.ja;
    render(
      <AddressCallout
        label={c.jpycAddressLabel}
        address={c.jpycAddress}
        chainNote={c.jpycAddressChainNote}
        legacyWarning={c.jpycLegacyWarning}
      />,
    );
    expect(screen.getByText(c.jpycAddress)).toBeInTheDocument();
  });

  it('CodeBlock が実 configCode を描画する', () => {
    const c = AGENT_GUIDE.en;
    const { container } = render(
      <CodeBlock label={c.configLabel} code={c.configCode} />,
    );
    expect(container.querySelector('code')?.textContent).toBe(c.configCode);
    expect(container.textContent).toContain('openpay-order-mcp');
  });
});
