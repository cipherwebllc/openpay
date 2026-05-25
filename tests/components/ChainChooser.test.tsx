import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChainChooser } from '@/components/ChainChooser';
import {
  chainForSlug,
  JPYC_CHAINS,
  USDC_CHAINS,
  type ChainSlug,
} from '@/lib/chains';

// NETWORK_ENV=testnet (vitest.config.ts) で動作。期待値は chainForSlug() から
// 実 viem chain object を引いて導出する (testnet id を hardcode しない)。

describe('ChainChooser', () => {
  it('USDC_CHAINS (6 chain) を render: 6 button, 各 button に chain.name と "id: {id}"', () => {
    render(
      <ChainChooser
        slugs={USDC_CHAINS}
        selected="base"
        onSelect={() => {}}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(USDC_CHAINS.length);
    expect(buttons).toHaveLength(6);

    // 各 slug について chain.name + "id: {id}" が表示される
    for (const slug of USDC_CHAINS) {
      const c = chainForSlug(slug);
      // chain.name は button の accessible name の一部
      const btn = screen.getByRole('button', {
        name: new RegExp(`^${escapeRegExp(c.name)}`),
      });
      expect(btn).toBeInTheDocument();
      expect(within(btn).getByText(`id: ${c.id}`)).toBeInTheDocument();
      expect(within(btn).getByText(c.name)).toBeInTheDocument();
    }
  });

  it('JPYC_CHAINS (2 chain) を render: Polygon + Kaia 系', () => {
    render(
      <ChainChooser
        slugs={JPYC_CHAINS}
        selected="polygon"
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(JPYC_CHAINS.length);
    expect(screen.getByText(chainForSlug('polygon').name)).toBeInTheDocument();
    expect(screen.getByText(chainForSlug('kaia').name)).toBeInTheDocument();
  });

  it('active button は border-brand + bg-brand/5 class、非 active は border-slate-200', () => {
    render(
      <ChainChooser
        slugs={USDC_CHAINS}
        selected="arbitrum"
        onSelect={() => {}}
      />,
    );
    const arbName = chainForSlug('arbitrum').name;
    const baseName = chainForSlug('base').name;
    const activeBtn = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(arbName)}`),
    });
    const inactiveBtn = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(baseName)}`),
    });
    expect(activeBtn.className).toMatch(/border-brand/);
    expect(activeBtn.className).toMatch(/bg-brand\/5/);
    expect(activeBtn.className).toMatch(/text-brand-dark/);
    expect(inactiveBtn.className).toMatch(/border-slate-200/);
    expect(inactiveBtn.className).not.toMatch(/border-brand/);
  });

  it('selected が変わると active button が入れ替わる (re-render)', () => {
    const { rerender } = render(
      <ChainChooser
        slugs={USDC_CHAINS}
        selected="base"
        onSelect={() => {}}
      />,
    );
    const baseName = chainForSlug('base').name;
    const opName = chainForSlug('optimism').name;

    const baseBtnA = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(baseName)}`),
    });
    expect(baseBtnA.className).toMatch(/border-brand/);

    rerender(
      <ChainChooser
        slugs={USDC_CHAINS}
        selected="optimism"
        onSelect={() => {}}
      />,
    );
    const baseBtnB = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(baseName)}`),
    });
    const opBtn = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(opName)}`),
    });
    expect(baseBtnB.className).not.toMatch(/border-brand/);
    expect(opBtn.className).toMatch(/border-brand/);
  });

  it('onSelect: 非 active button click で正しい slug を 1 回 callback', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ChainChooser
        slugs={USDC_CHAINS}
        selected="base"
        onSelect={onSelect}
      />,
    );
    const arbBtn = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(chainForSlug('arbitrum').name)}`),
    });
    await user.click(arbBtn);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('arbitrum');
  });

  it('onSelect: active button を再 click しても callback は発火 (swallow しない)', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ChainChooser
        slugs={USDC_CHAINS}
        selected="base"
        onSelect={onSelect}
      />,
    );
    const baseBtn = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(chainForSlug('base').name)}`),
    });
    await user.click(baseBtn);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('base');
  });

  it('onSelect: 各 USDC slug click → 全 6 slug が正しく callback される', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ChainChooser
        slugs={USDC_CHAINS}
        selected="base"
        onSelect={onSelect}
      />,
    );
    for (const slug of USDC_CHAINS) {
      const btn = screen.getByRole('button', {
        name: new RegExp(`^${escapeRegExp(chainForSlug(slug).name)}`),
      });
      await user.click(btn);
    }
    expect(onSelect).toHaveBeenCalledTimes(USDC_CHAINS.length);
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([...USDC_CHAINS]);
  });

  it('edge: slugs=[] (空) → button 0 個 + grid container は存在', () => {
    const { container } = render(
      <ChainChooser slugs={[]} selected="base" onSelect={() => {}} />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // grid container は描画される (empty state でも layout は維持)。
    // container.firstElementChild で root を取って一貫化 (default gridClassName
    // テストと同じ取り方)。
    const grid = container.firstElementChild as HTMLElement;
    expect(grid).not.toBeNull();
    expect(grid.className).toContain('grid');
    expect(grid.children).toHaveLength(0);
  });

  it('edge: slugs に 1 個だけ → 1 button、active 判定も機能', () => {
    render(
      <ChainChooser slugs={['polygon']} selected="polygon" onSelect={() => {}} />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.className).toMatch(/border-brand/);
  });

  it('edge: selected が slugs に存在しない → active button は 0', () => {
    render(
      <ChainChooser
        slugs={['polygon', 'kaia']}
        selected={'ethereum' as ChainSlug}
        onSelect={() => {}}
      />,
    );
    const buttons = screen.getAllByRole('button');
    for (const btn of buttons) {
      expect(btn.className).not.toMatch(/border-brand/);
      expect(btn.className).toMatch(/border-slate-200/);
    }
  });

  it('form 内に置いて click しても form submit しない (type="button")', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const user = userEvent.setup();
    render(
      <form onSubmit={onSubmit}>
        <ChainChooser
          slugs={USDC_CHAINS}
          selected="base"
          onSelect={() => {}}
        />
        <button type="submit">submit</button>
      </form>,
    );
    const arbBtn = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(chainForSlug('arbitrum').name)}`),
    });
    await user.click(arbBtn);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('logo: 各 button 内に img が 1 個、src=/chains/{slug}.svg + alt="" + aria-hidden="true"', () => {
    const { container } = render(
      <ChainChooser slugs={USDC_CHAINS} selected="base" onSelect={() => {}} />,
    );
    for (const slug of USDC_CHAINS) {
      const btn = screen.getByRole('button', {
        name: new RegExp(`^${escapeRegExp(chainForSlug(slug).name)}`),
      });
      const img = btn.querySelector('img');
      expect(img).not.toBeNull();
      expect(img!.getAttribute('src')).toContain(`/chains/${slug}.svg`);
      expect(img!.getAttribute('alt')).toBe('');
      expect(img!.getAttribute('aria-hidden')).toBe('true');
    }
    expect(container.querySelectorAll('img')).toHaveLength(USDC_CHAINS.length);
  });

  it('default gridClassName: grid-cols-2 + sm:grid-cols-3 + gap-2', () => {
    const { container } = render(
      <ChainChooser slugs={USDC_CHAINS} selected="base" onSelect={() => {}} />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toMatch(/grid-cols-2/);
    expect(grid.className).toMatch(/sm:grid-cols-3/);
    expect(grid.className).toMatch(/gap-2/);
  });

  it('custom gridClassName が default を完全に上書き', () => {
    const { container } = render(
      <ChainChooser
        slugs={JPYC_CHAINS}
        selected="polygon"
        onSelect={() => {}}
        gridClassName="grid grid-cols-2 gap-4"
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toBe('grid grid-cols-2 gap-4');
    // default の sm:grid-cols-3 は混入しない
    expect(grid.className).not.toMatch(/sm:grid-cols-3/);
  });

  it('構造 = button > [img, div.min-w-0 > div.truncate(name) + div(id)]', () => {
    // min-w-0 は flex 子に必要 (これが無いと truncate が成立しない構造的 assertion)
    render(
      <ChainChooser
        slugs={USDC_CHAINS}
        selected="base"
        onSelect={() => {}}
      />,
    );
    const btn = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(chainForSlug('base').name)}`),
    });
    const [imgEl, innerWrapper] = Array.from(btn.children) as HTMLElement[];
    expect(btn.children).toHaveLength(2);
    expect(imgEl!.tagName).toBe('IMG');
    expect(innerWrapper!.classList.contains('min-w-0')).toBe(true);
    const [nameDiv, idDiv] = Array.from(innerWrapper!.children) as HTMLElement[];
    expect(innerWrapper!.children).toHaveLength(2);
    expect(nameDiv!.classList.contains('truncate')).toBe(true);
    expect(nameDiv!.textContent).toBe(chainForSlug('base').name);
    expect(idDiv!.textContent).toBe(`id: ${chainForSlug('base').id}`);
  });

  it('accessible name = chain.name + " id: " + chain.id (existing getByRole pattern を維持)', () => {
    render(
      <ChainChooser slugs={USDC_CHAINS} selected="base" onSelect={() => {}} />,
    );
    // QrGenerator.test 等が使う getByRole({ name: /^Polygon/ }) パターンを保証
    // → button の accessible name は chain.name から始まる必要がある
    for (const slug of USDC_CHAINS) {
      const c = chainForSlug(slug);
      const btn = screen.getByRole('button', {
        name: new RegExp(`^${escapeRegExp(c.name)}`),
      });
      // 末尾に chain id も含まれる
      expect(btn.textContent).toContain(`id: ${c.id}`);
    }
  });

  it('NETWORK_ENV pinning: testnet 環境の chain id が DOM に出る (mainnet 値混入を検知)', () => {
    // chainForSlug 経由ではなく hardcode した testnet 値を直接 DOM 照合することで、
    // NETWORK_ENV が誤って mainnet 解決した場合の regression を catch する。
    const testnetIds: Record<ChainSlug, number> = {
      base: 84532,
      arbitrum: 421614,
      optimism: 11155420,
      polygon: 80002,
      ethereum: 11155111,
      avalanche: 43113,
      kaia: 1001,
    };
    render(
      <ChainChooser slugs={USDC_CHAINS} selected="base" onSelect={() => {}} />,
    );
    for (const slug of USDC_CHAINS) {
      expect(screen.getByText(`id: ${testnetIds[slug]}`)).toBeInTheDocument();
    }
  });

  it('keyboard a11y: Tab + Enter で button activate', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ChainChooser
        slugs={['base', 'arbitrum']}
        selected="base"
        onSelect={onSelect}
      />,
    );
    // 1 回目 Tab で base button (active) にフォーカス
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', {
        name: new RegExp(`^${escapeRegExp(chainForSlug('base').name)}`),
      }),
    );
    // 2 回目 Tab で arbitrum button
    await user.tab();
    const arbBtn = screen.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(chainForSlug('arbitrum').name)}`),
    });
    expect(document.activeElement).toBe(arbBtn);
    // Enter で activate
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('arbitrum');
  });

  it('keyboard a11y: Space でも activate', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ChainChooser
        slugs={['polygon', 'kaia']}
        selected="polygon"
        onSelect={onSelect}
      />,
    );
    await user.tab();
    await user.tab();
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenCalledWith('kaia');
  });

});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
