import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
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
const KEY = 'openpay:tip-settings:v2';
// chain id は test env (NETWORK_ENV=testnet) で testnet 版になる:
// polygon → 80002 (Amoy), kaia → 1001 (Kairos)。slug 経由で動的解決する。
const POLYGON_ID = chainForSlug('polygon').id;
const KAIA_ID = chainForSlug('kaia').id;

beforeEach(() => {
  window.localStorage.clear();
});

// URL は share タブ (default) の URL 表示に出る。iframe snippet は embed タブ。
function expectInUrl(pattern: RegExp) {
  const matches = screen.getAllByText(pattern);
  expect(matches.length).toBeGreaterThan(0);
}

// 公開セクションの embed タブへ切替えて iframe snippet を露出させる。
async function openEmbedTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'サイトに埋め込む' }));
}

describe('TipEmbedGenerator — 初期表示', () => {
  it('受取アドレス未入力 → share タブの URL プレースホルダが出る', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(
      screen.getByText(/受取アドレスを入力すると URL が生成されます/),
    ).toBeInTheDocument();
  });

  it('embed タブへ切替 → snippet プレースホルダが出る', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await openEmbedTab(user);
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

  it('step 見出し (受取先 / 表示をカスタマイズ / 公開する) が出る', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(screen.getByText('受取先')).toBeInTheDocument();
    expect(screen.getByText('表示をカスタマイズ')).toBeInTheDocument();
    expect(screen.getByText('公開する')).toBeInTheDocument();
  });
});

describe('TipEmbedGenerator — URL / snippet 生成', () => {
  it('有効アドレス入力 → share タブに URL、embed タブに iframe snippet', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await waitFor(() => {
      expectInUrl(
        new RegExp(`https://test\\.local/tip/${VALID}\\?token=jpyc`),
      );
    });
    // iframe snippet は embed タブでのみ出る
    await openEmbedTab(user);
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

  it('color #rrggbb が valid → URL に含まれる、不正 → 警告', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    const colorTextInput = screen.getByPlaceholderText('#2563eb');
    fireEvent.change(colorTextInput, { target: { value: '#ff0080' } });

    await waitFor(() => expectInUrl(/color=%23ff0080/));

    fireEvent.change(colorTextInput, { target: { value: 'red' } });
    await waitFor(() => {
      expect(screen.getByText(/#rrggbb 形式/)).toBeInTheDocument();
    });
  });
});

describe('TipEmbedGenerator — チップ金額プリセット (ボタン編集 UI)', () => {
  it('既定は JPYC の 3 chip (300/1000/3000) が編集 input として出る', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    const inputs = screen.getAllByPlaceholderText(
      '例: 1000',
    ) as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(['300', '1000', '3000']);
  });

  it('chip を編集 → URL に preset= (default と異なる値) が乗る', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    const inputs = screen.getAllByPlaceholderText('例: 1000');
    for (const [i, value] of ['500', '1500', '5000'].entries()) {
      await user.clear(inputs[i]);
      await user.type(inputs[i], value);
    }

    await waitFor(() => expectInUrl(/preset=500%2C1500%2C5000/));
  });

  it('+ 金額を追加 / × 削除 で chip 数が増減する', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    expect(screen.getAllByPlaceholderText('例: 1000')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: '+ 金額を追加' }));
    expect(screen.getAllByPlaceholderText('例: 1000')).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'プリセット 1 を削除' }));
    expect(screen.getAllByPlaceholderText('例: 1000')).toHaveLength(3);
  });

  it('上限 (6) に達すると + 追加ボタンが消える', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    // 既定 3 + 3 回追加 = 6
    for (let i = 0; i < 3; i++) {
      await user.click(screen.getByRole('button', { name: '+ 金額を追加' }));
    }
    expect(screen.getAllByPlaceholderText('例: 1000')).toHaveLength(6);
    expect(
      screen.queryByRole('button', { name: '+ 金額を追加' }),
    ).toBeNull();
  });

  it('全 chip を空にするとプレビューは既定値に fallback (preset は URL に出ない)', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    for (const inp of screen.getAllByPlaceholderText('例: 1000')) {
      await user.clear(inp);
    }
    // プレビューは既定 (300/1000/3000) に倒れる
    await waitFor(() =>
      expect(screen.getByText('300 JPYC')).toBeInTheDocument(),
    );
    // 既定なので URL に preset= は出ない
    const urlText = screen.getAllByText(/\/tip\/0x/)[0]!.textContent ?? '';
    expect(urlText).not.toContain('preset=');
  });

  it('既定値ちょうどのままなら preset= は省略される (byte 差分の明示)', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await waitFor(() => expectInUrl(/token=jpyc/));
    const urlText = screen.getAllByText(/\/tip\/0x/)[0]!.textContent ?? '';
    expect(urlText).not.toContain('preset=');
  });

  it('プリセットは token ごと独立 (JPYC↔USDC で別リスト・連動しない)', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    let inputs = screen.getAllByPlaceholderText('例: 1000') as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(['300', '1000', '3000']);

    await user.click(screen.getByRole('button', { name: /USDC/ }));
    await waitFor(() => {
      inputs = screen.getAllByPlaceholderText('例: 1000') as HTMLInputElement[];
      expect(inputs.map((i) => i.value)).toEqual(['5', '20', '50']);
    });
    // プレビューも USDC のプリセット
    expect(screen.getByText('5 USDC')).toBeInTheDocument();
    expect(screen.queryByText('300 JPYC')).toBeNull();
  });
});

describe('TipEmbedGenerator — 公開 (リンク共有 / サイト埋め込み 2 択)', () => {
  it('default は share タブ。embed タブへ切替で iframe が出て URL 表示は消える', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    // share: Tip URL 見出しあり / iframe 見出しなし
    expect(screen.getByText('Tip URL')).toBeInTheDocument();
    expect(screen.queryByText('iframe 埋め込みコード')).toBeNull();

    await openEmbedTab(user);
    expect(screen.getByText('iframe 埋め込みコード')).toBeInTheDocument();
    expect(screen.queryByText('Tip URL')).toBeNull();
  });
});

describe('TipEmbedGenerator — コピーボタン', () => {
  it('share タブの URL コピー → clipboard に URL が書込', async () => {
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

    await user.click(screen.getByRole('button', { name: 'コピー' }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain(`/tip/${VALID}`);
    expect(screen.getByText('コピー済み')).toBeInTheDocument();
  });

  it('embed タブの iframe コピー → clipboard に snippet が書込', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await openEmbedTab(user);

    await waitFor(() => expect(screen.getByText(/<iframe/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'コピー' }));

    expect(writeText).toHaveBeenCalled();
    expect(writeText.mock.calls[0][0]).toContain('<iframe');
    expect(writeText.mock.calls[0][0]).toContain(`/tip/${VALID}`);
  });
});

describe('TipEmbedGenerator — 開発者向け設定 (折りたたみ)', () => {
  it('default 閉。開くと thanks / thanksUrl / webhook 入力が出る', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    const toggle = screen.getByRole('button', { name: /開発者向け設定/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByPlaceholderText(/discord\.com\/api\/webhooks/),
    ).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByPlaceholderText(/discord\.com\/api\/webhooks/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/discord\.gg/),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/限定 Discord に招待します/),
    ).toBeInTheDocument();
  });

  it('折りたたんだままでも保存済み webhook / thanks が URL に直列化される', async () => {
    // dev 設定 UI は default 閉。だが settings に保存された値は URL に反映される。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        chain: 'polygon',
        receiver: VALID,
        webhook: 'https://hook.example.com/x',
        thanks: 'thx',
        thanksUrl: 'https://t.example.com',
      }),
    );
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    expect(
      screen.getByRole('button', { name: /開発者向け設定/ }),
    ).toHaveAttribute('aria-expanded', 'false');

    await waitFor(() => expectInUrl(/webhook=/));
    expectInUrl(/thanks=/);
    expectInUrl(/thanksUrl=/);
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
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.receiver).toBe(VALID);
      expect(parsed.name).toBe('Alice');
    });
  });
});

describe('TipEmbedGenerator — Kaia chain (JPYC)', () => {
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
    await waitFor(() => expectInUrl(/token=jpyc/));
    const urlText = screen.getAllByText(/\/tip\/0x/)[0]!.textContent ?? '';
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
    expect(
      screen.queryByRole('checkbox', { name: /他チェーンからの tip を許可/ }),
    ).toBeNull();
  });
});

describe('TipEmbedGenerator — end-to-end フロー (実 hook / 実 localStorage)', () => {
  it('USDC → JPYC 切替で chain が default に戻り、chooser 内容も切替わる', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    await user.click(screen.getByRole('button', { name: /USDC/ }));
    await waitFor(() => expectInUrl(/token=usdc/));
    {
      const urlText = screen.getAllByText(/\/tip\/0x/)[0]!.textContent ?? '';
      expect(urlText).not.toContain('chain=');
    }

    const ARB_ID = chainForSlug('arbitrum').id;
    await user.click(
      screen.getByRole('button', { name: new RegExp(`id:\\s*${ARB_ID}\\b`) }),
    );
    await waitFor(() => expectInUrl(/chain=arbitrum/));

    await user.click(screen.getByRole('button', { name: /JPYC/ }));
    await waitFor(() => expectInUrl(/token=jpyc/));
    {
      const urlText = screen.getAllByText(/\/tip\/0x/)[0]!.textContent ?? '';
      expect(urlText).not.toContain('chain=arbitrum');
      expect(urlText).not.toContain('chain=polygon');
    }
  });

  it('cross-chain toggle は localStorage に永続化、再 mount で復元', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await user.click(screen.getByRole('button', { name: /USDC/ }));

    const checkbox = screen.getByRole('checkbox', {
      name: /他チェーンからの tip を許可/,
    });
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();

    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).crossChain).toBe(false);
    });

    unmount();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    const restored = screen.getByRole('checkbox', {
      name: /他チェーンからの tip を許可/,
    });
    expect(restored).not.toBeChecked();
  });

  it('Kaia 選択 → localStorage に kaia 保存 → 再 mount で kaia 復元', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    await user.click(
      screen.getByRole('button', { name: new RegExp(`id:\\s*${KAIA_ID}\\b`) }),
    );

    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(JSON.parse(raw!).chain).toBe('kaia');
    });

    unmount();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await waitFor(() => expectInUrl(/chain=kaia/));
  });

  it('chainLabel が token に追従して動的に切替 (USDC → JPYC)', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(screen.getByText(/受取チェーン \(JPYC\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /USDC/ }));
    await waitFor(() =>
      expect(screen.getByText(/受取チェーン \(USDC\)/)).toBeInTheDocument(),
    );
  });
});

describe('TipEmbedGenerator — レイアウト (mobile overflow / preview 位置)', () => {
  // 旧: grid item の min-width:auto が長い tip URL で track を押し広げ overflow して
  // いた。新レイアウトは 2 カラム grid + 左 div / 右 aside の両方に min-w-0。
  it('grid 直下の左カラム div と右カラム aside が min-w-0 を持つ', async () => {
    const { container } = render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    const grid = container.querySelector('div.lg\\:grid');
    expect(grid).not.toBeNull();
    const children = Array.from(grid!.children);
    const left = children.find((el) => el.tagName === 'DIV');
    const right = children.find((el) => el.tagName === 'ASIDE');
    expect(left?.className).toMatch(/\bmin-w-0\b/);
    expect(right?.className).toMatch(/\bmin-w-0\b/);
  });

  it('DOM 順は 左カラム (Step1/2) → 右カラム aside (プレビュー/公開)', async () => {
    const { container } = render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    const grid = container.querySelector('div.lg\\:grid')!;
    const children = Array.from(grid.children);
    // mobile (1 カラム) では DOM 順がそのまま視覚順。プレビュー (aside 内) が
    // カスタマイズ設定 (左 div) の直後に来る。
    expect(children[0].tagName).toBe('DIV');
    expect(children[1].tagName).toBe('ASIDE');
    // プレビューは右 aside 内
    const aside = children[1] as HTMLElement;
    expect(within(aside).getByText('プレビュー')).toBeInTheDocument();
  });
});
