import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

// AddressInput の useResolveAddress (react-query で外 RPC) はテストでは
// 通信を発生させないため hook 単位でモック。0x 直接入力は AddressInput 内で
// local 検証されるため、hook は呼ばれない。
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({
    data: null,
    isFetching: false,
    error: null,
  })),
}));

import { TipEmbedGenerator } from '@/components/TipEmbedGenerator';
import { chainForSlug } from '@/lib/chains';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// vitest.config.ts の environmentOptions.jsdom.url で設定された origin
const ORIGIN = 'https://test.local';
// chain id は test env (NETWORK_ENV=testnet) で testnet 版になる:
// polygon → 80002 (Amoy), kaia → 1001 (Kairos)。slug 経由で動的解決する。
const POLYGON_ID = chainForSlug('polygon').id;
const KAIA_ID = chainForSlug('kaia').id;

beforeEach(() => {
  window.localStorage.clear();
});

describe('TipEmbedGenerator — 初期表示', () => {
  it('受取アドレス未入力 → URL / snippet は空のプレースホルダ', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(
      screen.getByText(/受取アドレスを入力すると URL が生成されます/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/受取アドレスを入力するとスニペットが生成されます/),
    ).toBeInTheDocument();
  });

  it('既定 token (jpyc) のプリセットがプレビューに表示', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(screen.getByText('300 JPYC')).toBeInTheDocument();
    expect(screen.getByText('1000 JPYC')).toBeInTheDocument();
    expect(screen.getByText('3000 JPYC')).toBeInTheDocument();
  });
});

// URL は (1) URL 表示 div と (2) iframe snippet の 2 箇所に出るため、
// getByText だと "multiple elements" エラーになる。getAllByText で検出する。
function expectInUrl(pattern: RegExp) {
  const matches = screen.getAllByText(pattern);
  expect(matches.length).toBeGreaterThan(0);
}

describe('TipEmbedGenerator — URL / snippet 生成', () => {
  it('有効アドレス入力 → URL & iframe snippet が生成される', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await waitFor(() => {
      expectInUrl(
        new RegExp(`https://test\\.local/tip/${VALID}\\?token=jpyc`),
      );
    });
    // iframe snippet 固有の文字列 (URL display には出ない)
    expect(screen.getByText(/width="380"/)).toBeInTheDocument();
    expect(screen.getByText(/height="640"/)).toBeInTheDocument();
  });

  it('USDC を選択 → URL の token が usdc に切替', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await user.click(screen.getByRole('button', { name: /USDC/ }));

    await waitFor(() => expectInUrl(/token=usdc/));
  });

  it('表示名入力 → URL に name= が含まれる', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await user.type(screen.getByPlaceholderText('例: 山田太郎'), 'Alice');

    await waitFor(() => expectInUrl(/name=Alice/));
  });

  it('プリセット入力 → URL に preset= が含まれる', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    const presetInput = screen.getByPlaceholderText(/300,1000,3000/);
    await user.type(presetInput, '500,1500,5000');

    await waitFor(() => expectInUrl(/preset=500%2C1500%2C5000/));
  });

  it('プリセットに不正値 → 警告 + 既定値が使われる', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    const presetInput = screen.getByPlaceholderText(/300,1000,3000/);
    await user.type(presetInput, 'abc,xyz');

    await waitFor(() => {
      expect(screen.getByText(/有効な金額がありません/)).toBeInTheDocument();
    });
  });

  it('color #rrggbb が valid → URL に含まれる、不正 → 警告', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    const colorTextInput = screen.getByPlaceholderText('#2563eb');
    // controlled input なので fireEvent.change で一発確定 (user.type の文字単位入力は
    // # を含む短いシーケンスで意図しない state 中間値が見えてフレーキー)
    fireEvent.change(colorTextInput, { target: { value: '#ff0080' } });

    await waitFor(() => expectInUrl(/color=%23ff0080/));

    fireEvent.change(colorTextInput, { target: { value: 'red' } });
    await waitFor(() => {
      expect(screen.getByText(/#rrggbb 形式/)).toBeInTheDocument();
    });
  });
});

describe('TipEmbedGenerator — コピーボタン', () => {
  it('URL コピー → clipboard に書き込まれ、ラベルが「コピー済み」', async () => {
    // userEvent.setup() の後に clipboard を差し替える (setup は内部で
    // 自前の clipboard stub を install するため、後置きしないと上書きされる)
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    await waitFor(() =>
      expectInUrl(new RegExp(`https://test\\.local/tip/${VALID}`)),
    );

    const copyBtns = screen.getAllByRole('button', { name: 'コピー' });
    await user.click(copyBtns[0]!);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain(`/tip/${VALID}`);
    expect(screen.getByText('コピー済み')).toBeInTheDocument();
  });

  it('iframe snippet コピー → clipboard に snippet が書込', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    await waitFor(() => {
      // <iframe テキストは iframe code block にしか出ない
      expect(screen.getByText(/<iframe/)).toBeInTheDocument();
    });

    const copyBtns = screen.getAllByRole('button', { name: 'コピー' });
    await user.click(copyBtns[1]!);

    expect(writeText).toHaveBeenCalled();
    expect(writeText.mock.calls[0][0]).toContain('<iframe');
    expect(writeText.mock.calls[0][0]).toContain(`/tip/${VALID}`);
  });
});

describe('TipEmbedGenerator — 永続化', () => {
  it('入力値が localStorage に保存される', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await user.type(screen.getByPlaceholderText('例: 山田太郎'), 'Alice');

    await waitFor(() => {
      const raw = window.localStorage.getItem('openpay:tip-settings:v2');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.receiver).toBe(VALID);
      expect(parsed.name).toBe('Alice');
    });
  });
});

describe('TipEmbedGenerator — Kaia chain (JPYC)', () => {
  // token=JPYC 選択時、"Polygon" は (a) token 説明 "2 chain 対応 (Polygon / Kaia)"
  // と (b) chain chooser ボタンの両方に出る。chain chooser 専用に絞るため、
  // accessible name が chain id を含むことで一意化する (id は slug → chainForSlug
  // で動的解決、testnet env でも mainnet でも正しく動く)。
  it('JPYC 選択時に chain chooser が表示される (Polygon / Kaia 2 ボタン)', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(
      screen.getByRole('button', {
        name: new RegExp(`id:\\s*${POLYGON_ID}\\b`),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: new RegExp(`id:\\s*${KAIA_ID}\\b`),
      }),
    ).toBeInTheDocument();
  });

  it('Kaia をクリック → URL に chain=kaia が乗る', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await user.click(
      screen.getByRole('button', {
        name: new RegExp(`id:\\s*${KAIA_ID}\\b`),
      }),
    );

    await waitFor(() => expectInUrl(/chain=kaia/));
  });

  it('Polygon (default) は URL に chain= を出さない (旧 embed との互換)', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    // 初期は polygon → click 不要、URL 確認のみ
    await waitFor(() => expectInUrl(/token=jpyc/));
    // URL の query 文字列に chain= が無いこと (preset / name 等は出る可能性あり)
    const urlMatches = screen.getAllByText(/\/tip\/0x/);
    const urlText = urlMatches[0]!.textContent ?? '';
    expect(urlText).not.toContain('chain=');
  });
});

describe('TipEmbedGenerator — cross-chain toggle (USDC)', () => {
  it('USDC 選択時に cross-chain toggle が表示される (default ON)', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.click(screen.getByRole('button', { name: /USDC/ }));

    const checkbox = screen.getByRole('checkbox', {
      name: /他チェーンからの tip を許可/,
    });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();
  });

  it('USDC + toggle OFF → URL に crossChain=false が乗る', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await user.click(screen.getByRole('button', { name: /USDC/ }));

    const checkbox = screen.getByRole('checkbox', {
      name: /他チェーンからの tip を許可/,
    });
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();

    await waitFor(() => expectInUrl(/crossChain=false/));
  });

  it('JPYC 選択時は cross-chain toggle 非表示 (USDC 専用機能)', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    // 初期 token は jpyc。cross-chain checkbox は存在しない
    expect(
      screen.queryByRole('checkbox', { name: /他チェーンからの tip を許可/ }),
    ).toBeNull();
  });
});

describe('TipEmbedGenerator — mobile overflow (regression)', () => {
  // grid item の min-width: auto 既定が長い 0x / tip URL で track を押し広げ、
  // mobile で viewport を突き抜けていたバグの再発防止。
  it('grid 両子カラムが min-w-0 を持つ (shrink 許可)', async () => {
    const { container } = render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    const grid = container.querySelector('div.grid');
    expect(grid?.className).toMatch(/\blg:grid-cols-2\b/);
    const children = Array.from(grid!.children).filter(
      (el) => el.tagName === 'DIV',
    );
    expect(children.length).toBeGreaterThanOrEqual(2);
    for (const child of children) {
      expect(child.className).toMatch(/\bmin-w-0\b/);
    }
  });
});
