import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';

const h = vi.hoisted(() => ({
  account: { isConnected: true },
  siwe: {
    isSignedIn: true,
    isSigningIn: false,
    mismatch: false,
    signIn: vi.fn(async () => undefined),
    signInError: null as Error | null,
    refreshSession: vi.fn(async () => undefined),
  },
}));

vi.mock('wagmi', () => ({ useAccount: () => h.account }));
vi.mock('@/hooks/useSiweSession', () => ({ useSiweSession: () => h.siwe }));

import { AdminStoreTakedownView, handleFromInput } from '@/components/AdminStoreTakedownView';
import { decodeHandleSegment, normalizeHandle } from '@/lib/handle';

const ID_A = `h_${'a'.repeat(32)}`;
const ID_B = `h_${'b'.repeat(32)}`;
const item = (id: string, title: string) => ({
  id,
  title,
  desc: 'd',
  imageUrl: 'https://127.0.0.1/secret.png',
  priceJpyc: '100',
  feeJpyc: '1',
  totalJpyc: '101',
  handle: 'pssrf30ed2f66',
});

type Call = { url: string; method: string };
let calls: Call[];
let listingResponses: Array<unknown | Promise<unknown>>;
let takedownStatus: Record<string, { status: number; body: unknown }>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  h.account = { isConnected: true };
  h.siwe = {
    isSignedIn: true,
    isSigningIn: false,
    mismatch: false,
    signIn: vi.fn(async () => undefined),
    signInError: null,
    refreshSession: vi.fn(async () => undefined),
  };
  calls = [];
  listingResponses = [];
  takedownStatus = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.startsWith('/api/store/listings')) {
      return json(200, await (listingResponses.shift() ?? { ok: true, items: [] }));
    }
    const id = decodeURIComponent(url.split('/')[5] ?? '');
    const r = takedownStatus[id] ?? { status: 200, body: { ok: true, id, alreadyPurged: false, contentRevision: 2 } };
    if (r.body === 'unreadable') return new Response('{"ok":tr', { status: r.status });
    return json(r.status, r.body);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function showShop(input: string) {
  const user = userEvent.setup();
  renderWithIntl(<AdminStoreTakedownView />, { locale: 'ja' });
  await user.type(screen.getByLabelText('店のページの URL か @名前'), input);
  await user.click(screen.getByRole('button', { name: '商品を表示' }));
  return user;
}

describe('handleFromInput', () => {
  it.each([
    ['https://open-pay.jp/ja/@pssrf30ed2f66', 'pssrf30ed2f66'],
    ['https://open-pay.jp/ja/@pt7698d_f062?product=h_x&from=agent', 'pt7698d_f062'],
    ['@pssrf30ed2f66', 'pssrf30ed2f66'],
    ['  pssrf30ed2f66  ', 'pssrf30ed2f66'],
    ['@PSSRF30ed2f66', 'pssrf30ed2f66'],
    // パスの区切りだけを見る (クエリの @ は拾わない)・%40 は戻す。
    ['https://open-pay.jp/ja/%40alice?ref=@bob', 'alice'],
    ['https://open-pay.jp/ja/store?ref=@bob', ''],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(handleFromInput(input)).toBe(expected);
  });

  // 画面は bundle を小さく保つため lib/handle を読み込まず、同じ数行を持つ。正規化がずれないように本体と比べる。
  it.each(['@Alice', '  @@bob_1 ', 'carol', '%40dave', '%E0%A4%A'])('lib/handle と同じ正規化: %s', (raw) => {
    expect(handleFromInput(`https://open-pay.jp/ja/${raw.trim()}`)).toBe(
      decodeHandleSegment(raw.trim()).startsWith('@') ? normalizeHandle(decodeHandleSegment(raw.trim())) : '',
    );
    expect(handleFromInput(raw)).toBe(normalizeHandle(raw));
  });
});

describe('AdminStoreTakedownView', () => {
  it('未接続 → 接続を促す', () => {
    h.account = { isConnected: false };
    renderWithIntl(<AdminStoreTakedownView />, { locale: 'ja' });
    expect(screen.getByText('ウォレットを接続してください。')).toBeInTheDocument();
  });

  it('未サインイン → サインインのボタン', async () => {
    h.siwe = { ...h.siwe, isSignedIn: false };
    const user = userEvent.setup();
    renderWithIntl(<AdminStoreTakedownView />, { locale: 'ja' });
    await user.click(screen.getByRole('button', { name: 'サインインして始める' }));
    expect(h.siwe.signIn).toHaveBeenCalledWith('OpenPay の商品の販売を止めるためにサインインします。');
  });

  it('店の URL から公開中の商品を出し、選んで確かめてから 1 件ずつ止め、読み直す', async () => {
    listingResponses = [
      { ok: true, items: [item(ID_A, 'SSRFProd A'), item(ID_B, 'SSRFProd B')] },
      { ok: true, items: [] },
    ];
    takedownStatus[ID_B] = { status: 200, body: { ok: true, id: ID_B, alreadyPurged: true, contentRevision: 3 } };
    const user = await showShop('https://open-pay.jp/ja/@pssrf30ed2f66');

    expect(await screen.findByText('@pssrf30ed2f66 の公開中の商品（2 件）')).toBeInTheDocument();
    expect(calls[0]).toEqual({ url: '/api/store/listings?handle=pssrf30ed2f66&limit=50&locale=ja', method: 'GET' });
    expect(screen.getAllByText('画像の URL: https://127.0.0.1/secret.png')).toHaveLength(2);

    const stop = screen.getByRole('button', { name: /の販売を止める/ });
    expect(stop).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'すべて選ぶ' }));
    await user.click(screen.getByRole('button', { name: '選んだ 2 件の販売を止める' }));
    // 押しただけでは送らない (元に戻せないので、件数を見せて確かめる)。
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(screen.getByText(/2 件の販売を止め、本文を消します。元に戻せません。/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '止める' }));
    await waitFor(() => expect(screen.getByText('@pssrf30ed2f66 の公開中の商品（0 件）')).toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      `/api/admin/store/products/${ID_A}/takedown`,
      `/api/admin/store/products/${ID_B}/takedown`,
    ]);
    expect(screen.getByText('止めました')).toBeInTheDocument();
    expect(screen.getByText('止め済みでした')).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ url: '/api/store/listings?handle=pssrf30ed2f66&limit=50&locale=ja', method: 'GET' });
  });

  it('やめるを押すと送らない', async () => {
    listingResponses = [{ ok: true, items: [item(ID_A, 'SSRFProd A')] }];
    const user = await showShop('@pssrf30ed2f66');
    await screen.findByText('@pssrf30ed2f66 の公開中の商品（1 件）');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '選んだ 1 件の販売を止める' }));
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(screen.queryByText(/元に戻せません/)).not.toBeInTheDocument();
  });

  it.each([
    [403, { ok: false, error: 'forbidden' }, 'このウォレットには運営の権限がありません。'],
    [401, { error: 'unauthorized' }, 'サインインが切れました。サインインし直してから、もう一度押してください。'],
    [429, { ok: false, error: 'rate_limited' }, '回数の上限です。1 分待ってから、もう一度押してください。'],
  ])('%s のときは理由を出し、残りは送らない', async (status, body, message) => {
    listingResponses = [{ ok: true, items: [item(ID_A, 'SSRFProd A'), item(ID_B, 'SSRFProd B')] }];
    takedownStatus[ID_A] = { status, body };
    const user = await showShop('pssrf30ed2f66');
    await screen.findByText('@pssrf30ed2f66 の公開中の商品（2 件）');
    await user.click(screen.getByRole('button', { name: 'すべて選ぶ' }));
    await user.click(screen.getByRole('button', { name: '選んだ 2 件の販売を止める' }));
    await user.click(screen.getByRole('button', { name: '止める' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('別の店を読み込んでいる間は、前の店の商品を選べない (前の一覧は先に消す)', async () => {
    let releaseB!: (value: unknown) => void;
    listingResponses = [
      { ok: true, items: [item(ID_A, 'SSRFProd A')] },
      new Promise((resolve) => {
        releaseB = resolve;
      }),
    ];
    const user = await showShop('@pssrf30ed2f66');
    await screen.findByText('@pssrf30ed2f66 の公開中の商品（1 件）');
    const input = screen.getByLabelText('店のページの URL か @名前');
    await user.clear(input);
    await user.type(input, '@other_shop');
    await user.click(screen.getByRole('button', { name: '商品を表示' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('SSRFProd A')).not.toBeInTheDocument();
    releaseB({ ok: true, items: [item(ID_B, 'Other B')] });
    expect(await screen.findByText('@other_shop の公開中の商品（1 件）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '選んだ 0 件の販売を止める' })).toBeDisabled();
  });

  it('確かめを開いたあとに選び直すと、確かめを閉じる', async () => {
    listingResponses = [{ ok: true, items: [item(ID_A, 'SSRFProd A'), item(ID_B, 'SSRFProd B')] }];
    const user = await showShop('@pssrf30ed2f66');
    await screen.findByText('@pssrf30ed2f66 の公開中の商品（2 件）');
    const [boxA, boxB] = screen.getAllByRole('checkbox');
    await user.click(boxA);
    await user.click(screen.getByRole('button', { name: '選んだ 1 件の販売を止める' }));
    expect(screen.getByRole('button', { name: '止める' })).toBeInTheDocument();
    await user.click(boxB);
    expect(screen.queryByRole('button', { name: '止める' })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('止めた商品は、読み直した一覧に残っていても (CDN の残り) もう選べない', async () => {
    const both = { ok: true, items: [item(ID_A, 'SSRFProd A'), item(ID_B, 'SSRFProd B')] };
    listingResponses = [both, both];
    const user = await showShop('@pssrf30ed2f66');
    await screen.findByText('@pssrf30ed2f66 の公開中の商品（2 件）');
    await user.click(screen.getAllByRole('checkbox')[0]);
    await user.click(screen.getByRole('button', { name: '選んだ 1 件の販売を止める' }));
    await user.click(screen.getByRole('button', { name: '止める' }));
    expect(await screen.findByText('止めました')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'すべて選ぶ' }));
    await user.click(screen.getByRole('button', { name: '選んだ 1 件の販売を止める' }));
    await user.click(screen.getByRole('button', { name: '止める' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      `/api/admin/store/products/${ID_A}/takedown`,
      `/api/admin/store/products/${ID_B}/takedown`,
    ]);
  });

  it('200 でも本文を読めなければ「止めました」と言わない', async () => {
    listingResponses = [{ ok: true, items: [item(ID_A, 'SSRFProd A')] }];
    takedownStatus[ID_A] = { status: 200, body: 'unreadable' };
    const user = await showShop('@pssrf30ed2f66');
    await screen.findByText('@pssrf30ed2f66 の公開中の商品（1 件）');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '選んだ 1 件の販売を止める' }));
    await user.click(screen.getByRole('button', { name: '止める' }));
    expect(await screen.findByText(/止まったか確かめられませんでした/)).toBeInTheDocument();
    expect(screen.queryByText('止めました')).not.toBeInTheDocument();
  });

  it('401 ではサインインの状態を読み直す (サインインのボタンを出すため)', async () => {
    listingResponses = [{ ok: true, items: [item(ID_A, 'SSRFProd A')] }];
    takedownStatus[ID_A] = { status: 401, body: { error: 'unauthorized' } };
    const user = await showShop('@pssrf30ed2f66');
    await screen.findByText('@pssrf30ed2f66 の公開中の商品（1 件）');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '選んだ 1 件の販売を止める' }));
    await user.click(screen.getByRole('button', { name: '止める' }));
    await screen.findByText(/サインインが切れました/);
    expect(h.siwe.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('一覧を読めないときは理由を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { ok: false, error: 'invalid_query' })));
    await showShop('@bad name');
    expect(await screen.findByText('商品を読み込めませんでした。URL か @名前を確かめてください。')).toBeInTheDocument();
  });
});
