import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

// wagmi / SIWE を最小モック (実 wallet グラフを描画せず OOM を避ける)。
const state = vi.hoisted(() => ({
  connected: false,
  address: undefined as string | undefined,
  signedIn: false,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.address, isConnected: state.connected }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: state.signedIn,
    signIn: vi.fn(async () => {}),
    isSigningIn: false,
  }),
}));

import { X402DiscoveryView } from '@/components/X402DiscoveryView';

const ITEM = {
  resource: 'https://api.example.jp/paid/translate',
  description: 'JP→EN 翻訳 API です',
  category: 'api',
  priceJpyc: '1000',
  accepts: [{ extra: { openpay: { feeValue: (10n * 10n ** 18n).toString() } } }],
};

// owner 一覧 (GET /api/facilitator/resources)。url/description はカタログの ITEM と被らせない
// (両方描画されるので getByText が一意になるように)。
const OWNED = {
  id: 'res-1',
  url: 'https://api.example.jp/paid/owned',
  description: '自分の有料 API',
  priceJpyc: '1000',
  category: 'api',
  payTo: '0x1111111111111111111111111111111111111111',
};

// URL+method でルーティングする fetch モック (編集/削除の呼び出しを検証)。
function installRoutingFetch(owned: Array<typeof OWNED>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u === '/api/discovery') {
      return { ok: true, json: async () => ({ x402Version: 1, items: [ITEM] }) };
    }
    if (u === '/api/facilitator/resources' && method === 'GET') {
      return { ok: true, json: async () => ({ resources: owned }) };
    }
    if (u.startsWith('/api/facilitator/resources/') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return { ok: true, json: async () => ({ resource: body }) };
    }
    if (u.startsWith('/api/facilitator/resources/') && method === 'DELETE') {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (u === '/api/facilitator/resources' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return { ok: true, json: async () => ({ resource: body, paywallSnippet: 'snippet' }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  state.connected = false;
  state.address = undefined;
  state.signedIn = false;
  // onEdit は window.scrollTo を呼ぶ (jsdom 未実装) → no-op で stub。
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ x402Version: 1, items: [ITEM] }),
  })) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// X402DiscoveryView は useQuery/useMutation を使うため QueryClientProvider が要る。
// テスト毎に新しい QueryClient を作りキャッシュを分離する (retry:false で失敗を即時に反映)。
function renderView(): ReturnType<typeof renderWithIntl> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <X402DiscoveryView />
    </QueryClientProvider>,
  );
}

// owner サインイン状態で描画する共通ヘルパ。
function renderAsOwner(owned: Array<typeof OWNED> = [OWNED]): ReturnType<typeof vi.fn> {
  state.connected = true;
  state.address = OWNED.payTo;
  state.signedIn = true;
  const fetchFn = installRoutingFetch(owned);
  renderView();
  return fetchFn;
}

describe('X402DiscoveryView', () => {
  it('未接続: connectPrompt を表示し、カタログを /api/discovery から列挙', async () => {
    renderView();
    // カタログ (公開・wallet 不要) が描画される。
    expect(await screen.findByText('JP→EN 翻訳 API です')).toBeInTheDocument();
    expect(screen.getByText(ITEM.resource)).toBeInTheDocument();
    // fee 注記 (手数料 10 JPYC)。
    expect(screen.getByText(/手数料 10 JPYC/)).toBeInTheDocument();
    // 未接続 → 登録には接続を促す。
    expect(
      screen.getByText('登録するにはウォレットを接続してください (画面上部)。'),
    ).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/discovery', { cache: 'no-store' });
  });

  it('サインイン済: 登録フォーム (URL/価格 入力) を表示', async () => {
    state.connected = true;
    state.address = '0x1111111111111111111111111111111111111111';
    state.signedIn = true;
    renderView();
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/リソース URL/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText('価格 (JPYC・整数)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登録する' })).toBeInTheDocument();
  });

  it('owner: 自分の登録一覧 (あなたの登録) を編集/削除ボタン付きで表示', async () => {
    renderAsOwner();
    expect(await screen.findByText('あなたの登録')).toBeInTheDocument();
    expect(screen.getByText('自分の有料 API')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
  });

  it('編集: 編集ボタンでフォームに値が入り PATCH /resources/:id を呼ぶ', async () => {
    const fetchFn = renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    // フォームが編集モードになり、対象の値が入る。
    await waitFor(() => expect(screen.getByDisplayValue(OWNED.url)).toBeInTheDocument());
    expect(screen.getByText('掲載を編集')).toBeInTheDocument();
    // 価格を書き換えて更新。
    const price = screen.getByPlaceholderText('価格 (JPYC・整数)');
    fireEvent.change(price, { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: '更新する' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        `/api/facilitator/resources/${OWNED.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    expect(await screen.findByText('更新しました。')).toBeInTheDocument();
  });

  it('編集キャンセル: キャンセルでフォームが登録モードに戻る', async () => {
    renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await waitFor(() => expect(screen.getByText('掲載を編集')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '登録する' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: '更新する' })).not.toBeInTheDocument();
  });

  it('削除: 確認 → 削除する で DELETE /resources/:id を呼び「削除しました」', async () => {
    const fetchFn = renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    expect(await screen.findByText('この掲載を削除しますか？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        `/api/facilitator/resources/${OWNED.id}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(await screen.findByText('削除しました。')).toBeInTheDocument();
  });

  it('削除キャンセル: やめる で DELETE を呼ばない', async () => {
    const fetchFn = renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: 'やめる' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument(),
    );
    expect(screen.queryByText('この掲載を削除しますか？')).not.toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining(`/api/facilitator/resources/${OWNED.id}`),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('登録: 表明チェック → POST /resources (attested:true + 入力値) → 「登録しました」+ スニペット', async () => {
    state.connected = true;
    state.address = '0x2222222222222222222222222222222222222222';
    state.signedIn = true;
    const fetchFn = installRoutingFetch([]); // owned 空 = 登録フォームのみ
    renderView();

    fireEvent.change(await screen.findByPlaceholderText(/リソース URL/), {
      target: { value: 'https://api.example.jp/paid/new' },
    });
    fireEvent.change(screen.getByPlaceholderText('説明 (何を提供するか)'), {
      target: { value: '新しい有料 API' },
    });
    fireEvent.change(screen.getByPlaceholderText('価格 (JPYC・整数)'), {
      target: { value: '500' },
    });

    // 境界: 表明前は登録ボタン disabled・案内文を表示。
    const submit = screen.getByRole('button', { name: '登録する' });
    expect(submit).toBeDisabled();
    expect(screen.getByText('登録には上記の表明への同意が必要です。')).toBeInTheDocument();
    // 表明にチェック → 有効化。
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        '/api/facilitator/resources',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    // 実出力の検査: 送信 body に attested:true + 入力値が乗る。
    const postCall = fetchFn.mock.calls.find(
      ([u, init]) =>
        u === '/api/facilitator/resources' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    const sentBody = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(sentBody).toMatchObject({
      url: 'https://api.example.jp/paid/new',
      description: '新しい有料 API',
      priceJpyc: '500',
      attested: true,
    });
    // 成功表示 + 402 スニペット。
    expect(await screen.findByText('登録しました。')).toBeInTheDocument();
    expect(screen.getByText('あなたのサーバで 402 を返す例:')).toBeInTheDocument();
  });

  it.each([
    ['resource_not_gated', /この URL は無料で公開されているため登録できません/],
    ['attestation_required', /正当な権利があり、支払いゲートを実装している/],
    ['too_many_resources', '操作に失敗しました (too_many_resources)。'],
  ])('登録エラー %s → 対応文言を表示', async (errCode, expected) => {
    state.connected = true;
    state.address = '0x2222222222222222222222222222222222222222';
    state.signedIn = true;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/api/facilitator/resources' && method === 'POST') {
        return { ok: false, json: async () => ({ error: errCode }) };
      }
      if (u === '/api/facilitator/resources') return { ok: true, json: async () => ({ resources: [] }) };
      return { ok: true, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;
    renderView();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('コピー: カタログ URL のコピーボタンで clipboard に書き込み「コピーしました」に変化', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderView();
    await screen.findByText('JP→EN 翻訳 API です');
    fireEvent.click(screen.getByLabelText('コピー'));
    // 実出力: clipboard にカタログ URL が渡る。
    expect(writeText).toHaveBeenCalledWith(ITEM.resource);
    // フィードバック: ラベルが「コピーしました」に変わる。
    expect(await screen.findByLabelText('コピーしました')).toBeInTheDocument();
  });

  it('カタログ: 支払い計 (価格 1000 + 手数料 10 = 1010 JPYC) を表示', async () => {
    renderView();
    expect(await screen.findByText('支払い計 1010 JPYC')).toBeInTheDocument();
  });

  it('1円 demo セクション: curl と buyer script コマンドをコピーできる', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderView();
    fireEvent.click(await screen.findByText('3円で試す (5分)'));
    const copyButtons = screen.getAllByRole('button', { name: 'コピー' });
    fireEvent.click(copyButtons[copyButtons.length - 1]);
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('BUYER_PRIVATE_KEY=0x...'),
    );
  });

  it('カタログ: 端数のある手数料を小数で表示 (整数除算で切り捨てない)', async () => {
    // price 250・手数料 2.5 JPYC (atomic 2.5e18)。整数除算だと "2" と誤表示する。
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        x402Version: 1,
        items: [
          {
            resource: 'https://api.example.jp/paid/frac',
            description: '端数手数料 API',
            category: 'api',
            priceJpyc: '250',
            accepts: [{ extra: { openpay: { feeValue: (2500000000000000000n).toString() } } }],
          },
        ],
      }),
    })) as unknown as typeof fetch;
    renderView();
    expect(await screen.findByText(/手数料 2\.5 JPYC/)).toBeInTheDocument();
    expect(screen.getByText('支払い計 252.5 JPYC')).toBeInTheDocument();
  });

  it('空カタログ: catalogEmpty を表示', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ x402Version: 1, items: [] }),
    })) as unknown as typeof fetch;
    renderView();
    expect(
      await screen.findByText('まだ登録されたリソースはありません。'),
    ).toBeInTheDocument();
  });
});
