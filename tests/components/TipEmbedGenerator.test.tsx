import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
// 受取先の自動補完 (useReceiverAutofill) が useAccount を読むため最小モック。
// 既定は未接続 = 自動補完もチップも出ない (既存テストの挙動を維持)。
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));

const tipMessageFlags = vi.hoisted(() => ({
  enableTipMessage: false,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableTipMessage() {
        return tipMessageFlags.enableTipMessage;
      },
    },
  };
});

const siwe = vi.hoisted(() => ({
  isSignedIn: false,
  isSigningIn: false,
  signInError: null as Error | null,
  signIn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => siwe,
}));

const tipFormPreviewSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/TipForm', () => ({
  TipForm: ({
    params,
    preview,
  }: {
    params: {
      token: 'jpyc' | 'usdc';
      presets?: string[];
      name?: string;
      message?: string;
      theme?: string;
      color?: string;
    };
    preview?: boolean;
  }) => {
    tipFormPreviewSpy(params, preview);
    const presets =
      params.presets ??
      (params.token === 'jpyc' ? ['300', '1000', '3000'] : ['5', '20', '50']);
    return (
      <div
        data-testid="mock-tip-form"
        data-theme={params.theme}
        data-color={params.color}
        data-preview={preview || undefined}
      >
        {params.name && <p>{params.name}</p>}
        {params.message && <p>{params.message}</p>}
        {presets.map((preset) => {
          const separator = preset.indexOf('|');
          const amount = separator === -1 ? preset : preset.slice(0, separator);
          const label = separator === -1 ? '' : preset.slice(separator + 1);
          return (
            <button key={preset} type="button">
              {label && <span>{label}</span>}
              <span>
                {amount} {params.token.toUpperCase()}
              </span>
            </button>
          );
        })}
      </div>
    );
  },
}));

import { TipEmbedGenerator } from '@/components/TipEmbedGenerator';
import { chainForSlug } from '@/lib/chains';
import { useAccount } from 'wagmi';

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const KEY = 'openpay:tip-settings:v2';
// chain id は test env (NETWORK_ENV=testnet) で testnet 版になる:
// polygon → 80002 (Amoy), kaia → 1001 (Kairos)。slug 経由で動的解決する。
const POLYGON_ID = chainForSlug('polygon').id;
const KAIA_ID = chainForSlug('kaia').id;

beforeEach(() => {
  window.localStorage.clear();
  tipFormPreviewSpy.mockClear();
  tipMessageFlags.enableTipMessage = false;
  siwe.isSignedIn = false;
  siwe.isSigningIn = false;
  siwe.signInError = null;
  siwe.signIn.mockReset().mockResolvedValue(undefined);
  vi.mocked(useAccount).mockReturnValue({
    address: undefined,
    isConnected: false,
  } as ReturnType<typeof useAccount>);
});

function renderWithQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <TipEmbedGenerator />
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

function enableTipMessageInbox(signedIn: boolean) {
  tipMessageFlags.enableTipMessage = true;
  siwe.isSignedIn = signedIn;
  vi.mocked(useAccount).mockReturnValue({
    address: VALID,
    isConnected: true,
  } as unknown as ReturnType<typeof useAccount>);
}

// URL は share タブ (default) の URL 表示に出る。iframe snippet は embed タブ。
function expectInUrl(pattern: RegExp) {
  const matches = screen.getAllByText(pattern);
  expect(matches.length).toBeGreaterThan(0);
}

// 公開セクションの embed タブへ切替えて iframe snippet を露出させる。
async function openEmbedTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'サイトに埋め込む' }));
}

// 「高度な設定」は USDC のみで表示する折りたたみ (default 閉・button+条件描画)。
// crossChain toggle にアクセスするテストは先に USDC を選択してから開く。
async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /高度な設定/ }));
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

describe('TipEmbedGenerator — 受け取った質問 inbox', () => {
  it('flag OFF は子を mount せず、QueryClient 無しでも API を呼ばない', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    siwe.isSignedIn = true;

    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    expect(screen.queryByTestId('tip-message-inbox')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('未サインイン + 接続済みはパネル内ボタンから共通 SIWE statement でサインイン', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    enableTipMessageInbox(false);

    renderWithQueryClient();
    const inbox = await screen.findByTestId('tip-message-inbox');
    await user.click(within(inbox).getByRole('button', { name: /サインイン/ }));

    expect(siwe.signIn).toHaveBeenCalledWith(
      'OpenPay にこのウォレットでログインします。',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('GET no-store + address scoped query で金額・時刻・from・改行本文を text node 表示', async () => {
    enableTipMessageInbox(true);
    const privateMessage = '1 行目\n<script>alert("x")</script>';
    const item = {
      from: '0x9999999999999999999999999999999999999999',
      amountWei: (300n * 10n ** 18n).toString(),
      chainId: POLYGON_ID,
      txHash: `0x${'a'.repeat(64)}`,
      message: privateMessage,
      ts: Date.UTC(2026, 6, 28, 3, 4, 0),
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [item] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const { container, client } = renderWithQueryClient();
    const inbox = await screen.findByTestId('tip-message-inbox');
    await waitFor(() =>
      expect(
        Array.from(inbox.querySelectorAll('p')).some(
          (node) => node.textContent === privateMessage,
        ),
      ).toBe(true),
    );

    expect(fetchSpy).toHaveBeenCalledWith('/api/tip-messages', {
      cache: 'no-store',
    });
    expect(within(inbox).getByText(/300 JPYC/)).toBeInTheDocument();
    expect(within(inbox).getByText(/0x9999…9999/)).toBeInTheDocument();
    expect(inbox.querySelector('time')).not.toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(client.getQueryData(['tip-messages', VALID])).toEqual([item]);
    expect(
      client.getQueryData([
        'tip-messages',
        '0x1111111111111111111111111111111111111111',
      ]),
    ).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('GET 失敗を空一覧に偽装せず、再試行で同じ endpoint を読む', async () => {
    enableTipMessageInbox(true);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const user = userEvent.setup();

    renderWithQueryClient();
    const inbox = await screen.findByTestId('tip-message-inbox');
    await user.click(
      await within(inbox).findByRole('button', { name: /再読み込み/ }),
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      '/api/tip-messages',
      '/api/tip-messages',
    ]);
    fetchSpy.mockRestore();
  });

  it('「すべて削除」は DELETE no-store 後に同じ address query key を invalidate', async () => {
    enableTipMessageInbox(true);
    const item = {
      from: '0x9999999999999999999999999999999999999999',
      amountWei: (5n * 10n ** 18n).toString(),
      chainId: POLYGON_ID,
      txHash: `0x${'b'.repeat(64)}`,
      message: '削除対象',
      ts: Date.UTC(2026, 6, 28, 3, 4, 0),
    };
    let deleted = false;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        if (init?.method === 'DELETE') {
          deleted = true;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ items: deleted ? [] : [item] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      });
    const user = userEvent.setup();
    const { client } = renderWithQueryClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const inbox = await screen.findByTestId('tip-message-inbox');

    await user.click(
      await within(inbox).findByRole('button', { name: /すべて削除/ }),
    );

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['tip-messages', VALID],
      }),
    );
    expect(fetchSpy).toHaveBeenCalledWith('/api/tip-messages', {
      method: 'DELETE',
      cache: 'no-store',
    });
    await waitFor(() =>
      expect(within(inbox).queryByText('削除対象')).toBeNull(),
    );
    fetchSpy.mockRestore();
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

  it('テーマピッカー操作 → 実フォーム用 params と Tip URL に即時反映', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    await user.click(screen.getByRole('button', { name: 'Night' }));

    await waitFor(() => expectInUrl(/theme=night/));
    expect(screen.getByTestId('mock-tip-form')).toHaveAttribute(
      'data-theme',
      'night',
    );
    expect(tipFormPreviewSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'night' }),
      true,
    );
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

  it('ラベル入力 → プレビューと URL に即時反映し localStorage に additive 保存', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    const labelInputs = screen.getAllByPlaceholderText('☕ コーヒー1杯');
    await user.type(labelInputs[0], '☕ コーヒー1杯');

    expect(await screen.findByText('☕ コーヒー1杯')).toBeInTheDocument();
    expect(screen.getByText('300 JPYC')).toBeInTheDocument();
    await waitFor(() => expectInUrl(/preset=300%7C/));
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(KEY)!);
      expect(saved.presets.jpyc[0]).toBe('300');
      expect(saved.presetLabels.jpyc[0]).toBe('☕ コーヒー1杯');
    });
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

  it('USDC 高精度プリセットは 6 桁に丸め + 丸め後重複を dedup (lib/amount 結線)', async () => {
    // lib/amount.normalizeAmountList の丸め+dedup が TipEmbedGenerator の
    // preview / URL まで結線されていることを component レベルで検証。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'usdc',
        chain: 'base',
        receiver: VALID,
        presets: {
          jpyc: ['300', '1000', '3000'],
          usdc: ['0.1234567890123', '0.1234567890124', '5'],
        },
      }),
    );
    render(<TipEmbedGenerator />);

    // プレビュー: 高精度 2 件は 0.123456 に潰れて 1 個 + 5 USDC
    await waitFor(() =>
      expect(screen.getAllByText('0.123456 USDC')).toHaveLength(1),
    );
    expect(screen.getByText('5 USDC')).toBeInTheDocument();
    // URL: 丸め後の値 (default と異なるので preset 出力)
    await waitFor(() => expectInUrl(/preset=0\.123456%2C5/));
  });

  it('× で全プリセット削除 → 空 input が 1 行残り、preview は既定へ fallback', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));

    // 既定 JPYC 3 chip を × で全削除 (removePreset の [''] 分岐を実行)
    for (let i = 0; i < 3; i++) {
      const removeBtns = screen.getAllByRole('button', {
        name: /^プリセット \d+ を削除/,
      });
      await user.click(removeBtns[0]);
    }

    const remaining = screen.getAllByPlaceholderText(
      '例: 1000',
    ) as HTMLInputElement[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].value).toBe('');
    // preview は既定 (300/1000/3000) に fallback
    expect(screen.getByText('300 JPYC')).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: 'リンクをコピー' }));

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

describe('TipEmbedGenerator — P2 共有UX (X シェア / QR / ボタン埋め込み)', () => {
  it('share タブ: アドレス入力で「X シェア」と QR ボタン → ポップアップ表示', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    const xLink = await screen.findByRole('link', { name: 'X シェア' });
    const href = xLink.getAttribute('href') ?? '';
    expect(href).toContain('twitter.com/intent/tweet');
    expect(href).toContain(VALID); // url= に tipUrl が含まれる

    // QR は常時表示せずボタン → ポップアップ (dialog 内に svg + フル URL)
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^QR$/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector('svg')).not.toBeNull();
    expect(dialog.textContent).toContain(VALID); // フル URL を提示
    // 閉じる
    await user.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('share タブ: アドレス未入力なら X シェア / QR は出ない', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(screen.queryByRole('link', { name: 'X シェア' })).toBeNull();
    expect(screen.queryByText('リンクの QR コード')).toBeNull();
  });

  it('embed タブ: iframe→ボタン 切替で <a> スニペット (tipUrl + ラベル) を出す', async () => {
    const user = userEvent.setup();
    const { container } = render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);
    await openEmbedTab(user);

    // default は iframe
    expect(screen.getByText('iframe 埋め込みコード')).toBeInTheDocument();

    // ボタン サブタブへ
    await user.click(screen.getByRole('tab', { name: 'ボタン' }));
    expect(screen.getByText('ボタン埋め込みコード')).toBeInTheDocument();
    expect(screen.queryByText('iframe 埋め込みコード')).toBeNull();

    const code = container.querySelector('pre code');
    expect(code?.textContent).toContain(
      `<a href="https://test.local/tip/${VALID}`,
    );
    expect(code?.textContent).toContain('チップを送る');
  });

  it('embed タブ ボタン: コピーで <a> スニペットが clipboard に入る', async () => {
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
    await user.click(screen.getByRole('tab', { name: 'ボタン' }));
    await user.click(screen.getByRole('button', { name: 'コピー' }));

    expect(writeText).toHaveBeenCalled();
    expect(writeText.mock.calls[0][0]).toContain('<a href=');
    expect(writeText.mock.calls[0][0]).toContain(`/tip/${VALID}`);
  });

  it('tipUrl が QR 容量を超えても crash せず QR を省略 (リンク/X シェアは残る)', async () => {
    // 長い webhook で tipUrl を肥大させると qrcode.react が throw しうる。長さガードで
    // QR を省略し、share タブが落ちないことを検証する。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        chain: 'polygon',
        receiver: VALID,
        webhook: `https://hook.example.com/${'a'.repeat(1400)}`,
      }),
    );
    render(<TipEmbedGenerator />);

    // X シェアは長い URL でも出る (crash していない)
    expect(
      await screen.findByRole('link', { name: 'X シェア' }),
    ).toBeInTheDocument();
    // QR は容量超過のため省略される
    expect(screen.queryByText('リンクの QR コード')).toBeNull();
  });

  it('share タブは brand 主 CTA + QR/X/新規タブの同格セカンダリ行', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.type(screen.getByPlaceholderText(/0x\.\.\./), VALID);

    const primary = screen.getByTestId('tip-copy-primary');
    expect(primary).toHaveTextContent('リンクをコピー');
    expect(primary).toHaveClass('w-full', 'bg-brand', 'py-3');
    const secondary = screen.getByTestId('tip-share-secondary');
    expect(within(secondary).getByRole('button', { name: /^QR$/ })).toBeInTheDocument();
    expect(within(secondary).getByRole('link', { name: /^X シェア$/ })).toBeInTheDocument();
    expect(within(secondary).getByRole('link', { name: /^新しいタブ$/ })).toBeInTheDocument();
  });
});

describe('TipEmbedGenerator — Step 1 returning-user 折りたたみ', () => {
  it('初回訪問は展開、保存済み有効アドレスは要約表示し「変更」で再展開', async () => {
    const first = render(<TipEmbedGenerator />);
    const initialToggle = await screen.findByRole('button', { name: /^受取先/ });
    expect(initialToggle).toHaveAttribute('aria-expanded', 'true');
    first.unmount();

    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', chain: 'polygon', receiver: VALID }),
    );
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    const toggle = await screen.findByRole('button', { name: /受取先.*変更/ });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    expect(toggle).toHaveTextContent('0x8335…2913');
    expect(toggle).toHaveTextContent(/JPYC \/ Polygon/);
    expect(screen.queryByPlaceholderText(/0x\.\.\./)).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByPlaceholderText(/0x\.\.\./)).toHaveValue(VALID);
  });

  it('接続ウォレット自動初期化後も折りたたむ', async () => {
    vi.mocked(useAccount).mockReturnValue({
      address: VALID,
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);
    render(<TipEmbedGenerator />);
    const toggle = await screen.findByRole('button', { name: /受取先.*変更/ });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    expect(toggle).toHaveTextContent('0x8335…2913');
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
    await openAdvanced(user);

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
    await openAdvanced(user);

    const checkbox = screen.getByRole('checkbox', {
      name: /他チェーンからの tip を許可/,
    });
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();

    await waitFor(() => expectInUrl(/crossChain=false/));
  });

  it('JPYC 選択時は空の「高度な設定」自体を表示しない', async () => {
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    expect(screen.queryByRole('button', { name: /高度な設定/ })).toBeNull();
    expect(
      screen.queryByRole('checkbox', { name: /他チェーンからの tip を許可/ }),
    ).toBeNull();
  });

  it('USDC の高度な設定は cross-chain だけを表示し、固定の決済方法表示は出さない', async () => {
    const user = userEvent.setup();
    render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.click(screen.getByRole('button', { name: /USDC/ }));
    expect(screen.getByText('高度な設定 (任意)')).toBeInTheDocument();
    await openAdvanced(user);
    expect(screen.getByText('別チェーンからの受取 (USDC のみ)')).toBeInTheDocument();
    expect(screen.queryByText('決済方法')).toBeNull();
  });

  it('高度な設定を開かなくても (折りたたみのまま) crossChain=false が URL に直列化される', async () => {
    // 折りたたみを button+条件描画へ統一したリファクタの load-bearing 前提を検証:
    // crossChain は settings 駆動で URL 化される (checkbox の描画有無に依存しない)。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'usdc',
        chain: 'base',
        receiver: VALID,
        crossChain: false,
      }),
    );
    render(<TipEmbedGenerator />);

    // 高度な設定は閉じたまま = crossChain チェックボックスは DOM 不在。
    expect(
      screen.getByRole('button', { name: /高度な設定/ }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('checkbox', { name: /他チェーンからの tip を許可/ }),
    ).toBeNull();

    // それでも保存済み crossChain=false が URL に反映される (描画非依存)。
    await waitFor(() => expectInUrl(/crossChain=false/));
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
    await openAdvanced(user);

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
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /受取先.*変更/ }),
      ).toHaveAttribute('aria-expanded', 'false'),
    );
    await openAdvanced(user);
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

  it('mobile の表示順は Step1 → Step2 → プレビュー → 高度な設定 → Step3', async () => {
    const user = userEvent.setup();
    const { container } = render(<TipEmbedGenerator />);
    await waitFor(() => screen.getByPlaceholderText(/0x\.\.\./));
    await user.click(screen.getByRole('button', { name: /USDC/ }));
    const grid = container.querySelector('div.lg\\:grid')!;
    const children = Array.from(grid.children);
    expect(children[0].tagName).toBe('DIV');
    expect(children[1].tagName).toBe('ASIDE');
    expect(children[0]).toHaveClass('contents');
    expect(children[1]).toHaveClass('contents');

    const left = children[0] as HTMLElement;
    const aside = children[1] as HTMLElement;
    expect(left.className).toContain('[&>section:first-child]:order-1');
    expect(left.className).toContain('[&>section:nth-child(2)]:order-2');
    expect(within(aside).getByText('プレビュー').closest('.order-3')).not.toBeNull();
    expect(
      within(left).getByText('高度な設定 (任意)').closest('.order-4'),
    ).not.toBeNull();
    expect(aside.className).toContain('[&>section]:order-5');
    expect(within(aside).getByText('公開する')).toBeInTheDocument();
  });
});
