import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Coins, QrCode, Store } from 'lucide-react';
import { StepCard } from '@/components/StepCard';

// StepCard は intl を使わないので NextIntlClientProvider は不要。
// 直接 render で実 component を実行する (UI 構造の最終 invariant を assert)。

describe('StepCard', () => {
  describe('基本構造 (non-collapsible)', () => {
    it('section に aria-labelledby、h2 の id と一致 → semantic 関連付け', () => {
      const { container } = render(
        <StepCard step={1} icon={Coins} title="金額">
          <div data-testid="body">content</div>
        </StepCard>,
      );
      const section = container.querySelector('section')!;
      expect(section.getAttribute('aria-labelledby')).toBe('step-1-heading');
      const heading = container.querySelector('#step-1-heading');
      expect(heading).not.toBeNull();
      expect(heading?.textContent).toContain('金額');
      // 数字 badge は span (aria-hidden) として heading 内に存在
      expect(within(heading as HTMLElement).getByText('1')).toBeInTheDocument();
    });

    it('step 番号は 1 / 2 / 3 / 4 で aria-labelledby も連動する', () => {
      const { container, rerender } = render(
        <StepCard step={1} icon={Coins} title="A">
          <div>x</div>
        </StepCard>,
      );
      expect(
        container.querySelector('[aria-labelledby="step-1-heading"]'),
      ).not.toBeNull();
      rerender(
        <StepCard step={2} icon={Store} title="B">
          <div>x</div>
        </StepCard>,
      );
      expect(
        container.querySelector('[aria-labelledby="step-2-heading"]'),
      ).not.toBeNull();
      rerender(
        <StepCard step={3} icon={QrCode} title="C">
          <div>x</div>
        </StepCard>,
      );
      expect(
        container.querySelector('[aria-labelledby="step-3-heading"]'),
      ).not.toBeNull();
      // step=4 (@handle ビルダーの ④ プレビュー) も受け付ける。
      rerender(
        <StepCard step={4} icon={QrCode} title="D">
          <div>x</div>
        </StepCard>,
      );
      const heading4 = container.querySelector('#step-4-heading');
      expect(heading4).not.toBeNull();
      expect(within(heading4 as HTMLElement).getByText('4')).toBeInTheDocument();
    });

    it('children は default で mount される (collapsible 未指定)', () => {
      render(
        <StepCard step={1} icon={Coins} title="金額">
          <div data-testid="body">content</div>
        </StepCard>,
      );
      expect(screen.getByTestId('body')).toBeInTheDocument();
    });

    it('icon prop は h2 内に SVG として render (a11y: aria-hidden)', () => {
      const { container } = render(
        <StepCard step={1} icon={Coins} title="金額">
          <div>x</div>
        </StepCard>,
      );
      const heading = container.querySelector('#step-1-heading')!;
      const svg = heading.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      // lucide-react は class 名に "lucide-coins" を付与する
      expect(svg!.getAttribute('class')).toMatch(/lucide-coins/);
    });
  });

  describe('variant prop', () => {
    it("variant='default' は slate ring のみ (border 非依存の面)", () => {
      const { container } = render(
        <StepCard step={1} icon={Coins} title="x">
          <div>x</div>
        </StepCard>,
      );
      const section = container.querySelector('section')!;
      expect(section.className).toMatch(/ring-slate-200\/70/);
      expect(section.className).toMatch(/shadow-card/);
      expect(section.className).not.toMatch(/ring-brand/);
      expect(section.className).not.toMatch(/border /);
    });

    it("variant='qr-prominent' で brand ring (強調面)", () => {
      const { container } = render(
        <StepCard step={3} icon={QrCode} title="QR" variant="qr-prominent">
          <div>x</div>
        </StepCard>,
      );
      const section = container.querySelector('section')!;
      expect(section.className).toMatch(/ring-1/);
      expect(section.className).toMatch(/ring-brand\/25/);
      expect(section.className).toMatch(/shadow-card/);
      // qr-prominent では slate ring を付けない
      expect(section.className).not.toMatch(/ring-slate-200/);
    });
  });

  describe('collapsible', () => {
    it('collapsible + open: toggle button が aria-expanded=true、children mount', () => {
      const onToggle = vi.fn();
      render(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open
          onToggle={onToggle}
        >
          <div data-testid="body">content</div>
        </StepCard>,
      );
      const toggle = screen.getByRole('button', { name: /受取先/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-controls')).toBe('step-2-body');
      // 子は mount されている
      expect(screen.getByTestId('body')).toBeInTheDocument();
    });

    it('collapsible + closed: aria-expanded=false、children は unmount される', () => {
      const onToggle = vi.fn();
      render(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open={false}
          onToggle={onToggle}
        >
          <div data-testid="body">content</div>
        </StepCard>,
      );
      const toggle = screen.getByRole('button', { name: /受取先/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      // children は DOM に存在しない (mount されない)
      expect(screen.queryByTestId('body')).toBeNull();
    });

    it('toggle click で onToggle prop が呼ばれる', async () => {
      const onToggle = vi.fn();
      const user = userEvent.setup();
      render(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open
          onToggle={onToggle}
        >
          <div>x</div>
        </StepCard>,
      );
      const toggle = screen.getByRole('button', { name: /受取先/ });
      await user.click(toggle);
      expect(onToggle).toHaveBeenCalledOnce();
    });

    it('ChevronDown は open 時に rotate-180 class を持つ、closed では持たない', () => {
      const { container, rerender } = render(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open
          onToggle={() => {}}
        >
          <div>x</div>
        </StepCard>,
      );
      // ChevronDown を toggle 内から特定 (transition-transform を持つ唯一の SVG)
      const button = container.querySelector('button')!;
      const chevron = button.querySelector('svg.transition-transform')!;
      expect(chevron.getAttribute('class')).toMatch(/rotate-180/);
      // closed
      rerender(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open={false}
          onToggle={() => {}}
        >
          <div>x</div>
        </StepCard>,
      );
      const button2 = container.querySelector('button')!;
      const chevron2 = button2.querySelector('svg.transition-transform')!;
      expect(chevron2.getAttribute('class')).not.toMatch(/rotate-180/);
    });

    it('collapsedSummary は closed 時のみ表示、open 時は描画しない', () => {
      const onToggle = vi.fn();
      const { rerender } = render(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open={false}
          onToggle={onToggle}
          collapsedSummary={<span data-testid="sum">SUMMARY</span>}
        >
          <div>x</div>
        </StepCard>,
      );
      expect(screen.getByTestId('sum')).toBeInTheDocument();
      // open=true に切替 → summary は非表示
      rerender(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open
          onToggle={onToggle}
          collapsedSummary={<span data-testid="sum">SUMMARY</span>}
        >
          <div>x</div>
        </StepCard>,
      );
      expect(screen.queryByTestId('sum')).toBeNull();
    });

    it('collapsedSummary 未指定: closed でも summary 要素は描画されない (heading は title のみ)', () => {
      const { container } = render(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open={false}
          onToggle={() => {}}
        >
          <div>x</div>
        </StepCard>,
      );
      // heading の中に title 以外の補助文言が無いことを確認
      const heading = container.querySelector('#step-2-heading')!;
      // step badge "2" と title "受取先" のみが text content
      // (ChevronDown は aria-hidden で a11y tree から消える)
      expect(heading.textContent?.trim()).toBe('2受取先');
    });

    it('collapsedSummary に null / undefined を渡しても crash しない (truthy guard)', () => {
      const { rerender } = render(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open={false}
          onToggle={() => {}}
          collapsedSummary={null}
        >
          <div>x</div>
        </StepCard>,
      );
      expect(screen.getByRole('button', { name: /受取先/ })).toBeInTheDocument();
      rerender(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open={false}
          onToggle={() => {}}
          collapsedSummary={undefined}
        >
          <div>x</div>
        </StepCard>,
      );
      expect(screen.getByRole('button', { name: /受取先/ })).toBeInTheDocument();
    });

    it('collapsible=true でも onToggle 未指定なら非 collapsible に degrade (children mount + toggle 不在)', () => {
      // 防御的フォールバック: collapsible だけ true で onToggle 忘れた場合に
      // user が永遠に section を開けない broken state を作らない。effectively
      // 非 collapsible として扱い、heading は inline span / children は常時 mount。
      render(
        <StepCard step={2} icon={Store} title="受取先" collapsible open={false}>
          <div data-testid="body">content</div>
        </StepCard>,
      );
      // toggle button は出ない (onToggle が無いので作りようがない)
      expect(screen.queryByRole('button', { name: /受取先/ })).toBeNull();
      // 重要: children は mount される。これが LARP 修正 (旧: unmount で永遠
      // に表示されない状態を test が「正常」と記録していた)。
      expect(screen.getByTestId('body')).toBeInTheDocument();
    });

    it('collapsible=true + onToggle 未指定 + collapsedSummary 渡しても summary は出さない (非 collapsible degrade)', () => {
      // collapsedSummary を渡されても、effectivelyCollapsible=false なので
      // summary は表示しない (heading は title のみ + children 全展開で代替)。
      const { container } = render(
        <StepCard
          step={2}
          icon={Store}
          title="受取先"
          collapsible
          open={false}
          collapsedSummary={<span data-testid="sum">SUMMARY</span>}
        >
          <div data-testid="body">content</div>
        </StepCard>,
      );
      expect(screen.queryByTestId('sum')).toBeNull();
      expect(screen.getByTestId('body')).toBeInTheDocument();
      // heading に summary class (truncate) を付けた要素も無い
      expect(container.querySelector('#step-2-heading span.truncate')).toBeNull();
    });
  });

  describe('print 用 class', () => {
    it('section は印刷時に border / padding / shadow を消す class を持つ', () => {
      const { container } = render(
        <StepCard step={1} icon={Coins} title="x">
          <div>x</div>
        </StepCard>,
      );
      const section = container.querySelector('section')!;
      expect(section.className).toMatch(/print:rounded-none/);
      expect(section.className).toMatch(/print:ring-0/);
      expect(section.className).toMatch(/print:p-0/);
      expect(section.className).toMatch(/print:shadow-none/);
    });

    it('heading は print:hidden で QR ポスター印刷時に Step 番号が混ざらない', () => {
      const { container } = render(
        <StepCard step={1} icon={Coins} title="x">
          <div>x</div>
        </StepCard>,
      );
      const h2 = container.querySelector('h2')!;
      expect(h2.className).toMatch(/print:hidden/);
    });
  });
});
