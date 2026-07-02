import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { HistoryEntry } from '@/lib/history';

// freee ルートの「グルー」を実コードで通すための統合テスト。
// モックするのは外部 I/O 境界だけ: KV(in-memory Map)・next/headers cookie・global fetch。
// requireSession / _store(claim/finalize) / lib/freee パース / runFreeeSync の配線は本物を実行する。
// → orchestration と冪等が「実際に配線通り動くか」を実証する (401 経路だけの env-gate test を補完)。

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  cookieToken: { value: undefined as string | undefined },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...mod,
    env: new Proxy(mod.env, {
      get: (target, prop) =>
        prop === 'enableFreeeSync' ? true : Reflect.get(target, prop),
    }),
  };
});

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvGet: async (k: string) => ({ ok: true, value: h.store.has(k) ? h.store.get(k) : null }),
  kvSet: async (k: string, v: string, opts: { nx?: boolean } = {}) => {
    if (opts.nx && h.store.has(k)) return { ok: true, value: null };
    h.store.set(k, v);
    return { ok: true, value: 'OK' };
  },
  // SET NX GET 原子 claim (REM-21): null=新設(fresh)、旧値=既存。
  kvSetNxGet: async (k: string, v: string) => {
    if (h.store.has(k)) return { ok: true, value: h.store.get(k) };
    h.store.set(k, v);
    return { ok: true, value: null };
  },
  kvDel: async (k: string) => {
    const had = h.store.has(k);
    h.store.delete(k);
    return { ok: true, value: had ? 1 : 0 };
  },
  kvGetDel: async (k: string) => {
    const value = h.store.has(k) ? h.store.get(k) : null;
    h.store.delete(k);
    return { ok: true, value };
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) =>
      n === 'op_sess' && h.cookieToken.value ? { value: h.cookieToken.value } : undefined,
  }),
}));

import { POST as syncPOST } from '@/app/api/freee/sync/route';
import { GET as mappingGET, POST as mappingPOST } from '@/app/api/freee/mapping/route';
import { GET as callbackGET } from '@/app/api/freee/callback/route';
import { encryptStoredToken, type StoredToken } from '@/lib/freee';

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TOKEN = 'sess-token-abc';
const FAR_FUTURE = 9_999_999_999_999;
const ENC_KEY = '00'.repeat(32);

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let dealCounter = 0;
function mockFreeeFetch(over: Record<string, unknown> = {}) {
  dealCounter = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/public_api/token'))
      return json(over.token ?? { access_token: 'AT', refresh_token: 'RT', expires_in: 21_600, company_id: 7 });
    if (url.includes('/api/1/companies'))
      return json(over.companies ?? { companies: [{ id: 7, display_name: 'テスト商店' }] });
    if (url.includes('/api/1/account_items'))
      return json(over.accountItems ?? { account_items: [{ id: 101, name: '売上高' }] });
    if (url.includes('/api/1/taxes/codes'))
      return json(over.taxes ?? { taxes: [{ code: 21, name: '課税売上10%' }] });
    if (url.includes('/api/1/deals')) {
      dealCounter += 1;
      return json(over.deal ?? { deal: { id: 9000 + dealCounter } });
    }
    return json({}, 404);
  });
}

function seedSession() {
  h.store.set(`siwe:sess:${TOKEN}`, JSON.stringify({ address: MERCHANT, issuedAt: 0 }));
  h.cookieToken.value = TOKEN;
}
function seedFreeeConnected() {
  seedFreeeToken({ access: 'AT', refresh: 'RT', expiresAt: FAR_FUTURE, companyId: 7 });
}
function seedFreeeToken(token: StoredToken) {
  h.store.set(`freee:tok:${MERCHANT.toLowerCase()}`, encryptStoredToken(MERCHANT, token));
}
function seedMapping() {
  h.store.set(
    `freee:map:${MERCHANT.toLowerCase()}`,
    JSON.stringify({ companyId: 7, accountItemId: 101, taxCode: 21 }),
  );
}

function income(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 4,
    id: 'e1',
    ts: new Date(2026, 5, 15, 9, 0, 0).getTime(),
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xT',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: MERCHANT,
    merchantAmount: '1000000000000000000000', // 1000 JPYC
    customer: '0xC',
    feeReceiver: '0xF',
    feeAmount: '0',
    txHash: `0x${'a'.repeat(64)}`,
    userOpHash: null,
    blockNumber: '1',
    errorMessage: null,
    storeName: '',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    saleAmount: '1000000000000000000000',
    networkFeeEquivalent: null,
    feeBreakdownVersion: 1,
    anchorAmount: null,
    anchorSymbol: null,
    fxRateUsdcJpy: null,
    productName: null,
    memo: null,
    taxRate: null,
    taxCategory: null,
    receiptNo: null,
    lineItems: null,
    ...overrides,
  };
}

function req(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.store.clear();
  h.cookieToken.value = undefined;
  vi.restoreAllMocks();
  process.env.FREEE_CLIENT_ID = 'cid';
  process.env.FREEE_CLIENT_SECRET = 'sec';
  process.env.FREEE_REDIRECT_URI = 'http://localhost:3000/api/freee/callback';
  process.env.FREEE_TOKEN_ENC_KEY = ENC_KEY;
  delete process.env.ALPHA_ENTITLEMENT_BYPASS; // bypass ON (entitled)
});

afterAll(() => {
  delete process.env.FREEE_CLIENT_ID;
  delete process.env.FREEE_CLIENT_SECRET;
  delete process.env.FREEE_REDIRECT_URI;
  delete process.env.FREEE_TOKEN_ENC_KEY;
});

describe('POST /api/freee/sync (実グルー: session→entitlement→token→runFreeeSync→createDeal)', () => {
  it('ハッピーパス: 取引を作成し synced=1 (実 createDeal を経由)', async () => {
    seedSession();
    seedFreeeConnected();
    seedMapping();
    mockFreeeFetch();

    const res = await syncPOST(
      req('http://localhost/api/freee/sync', { entries: [income()], usdcJpy: 150 }),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.synced).toBe(1);
    expect(j.items[0]).toMatchObject({ id: 'e1', status: 'synced' });
    expect(typeof j.items[0].dealId).toBe('number');
    // 冪等キーが KV に書かれている (恒久 dedup)
    expect(h.store.has(`freee:synced:${MERCHANT.toLowerCase()}:0x${'a'.repeat(64)}`)).toBe(true);
  });

  it('冪等: 同じ entry を再同期 → createDeal を呼ばず skipped=1 (実 _store claim 経由)', async () => {
    seedSession();
    seedFreeeConnected();
    seedMapping();
    const fetchSpy = mockFreeeFetch();

    await syncPOST(req('http://localhost/api/freee/sync', { entries: [income()] }));
    const dealCallsAfterFirst = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/deals'),
    ).length;
    expect(dealCallsAfterFirst).toBe(1);

    const res2 = await syncPOST(req('http://localhost/api/freee/sync', { entries: [income()] }));
    const j2 = await res2.json();
    expect(j2.synced).toBe(0);
    expect(j2.skipped).toBe(1);
    // 2回目は /deals を叩いていない = 二重計上しない
    const totalDealCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/deals'),
    ).length;
    expect(totalDealCalls).toBe(1);
  });

  it('body.usdcJpy が sanity band 外 → undefined 扱いで USDC anchor 無しは rate-unavailable', async () => {
    seedSession();
    seedFreeeConnected();
    seedMapping();
    const fetchSpy = mockFreeeFetch();

    const res = await syncPOST(
      req('http://localhost/api/freee/sync', {
        entries: [
          income({
            id: 'usdc-no-anchor',
            asset: 'usdc',
            merchantAmount: '6400000',
            saleAmount: '6400000',
            anchorAmount: null,
            anchorSymbol: null,
          }),
        ],
        usdcJpy: 1,
      }),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.rateUnavailable).toBe(1);
    expect(j.items[0]).toMatchObject({
      id: 'usdc-no-anchor',
      status: 'rate-unavailable',
    });
    const dealCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/deals'),
    ).length;
    expect(dealCalls).toBe(0);
  });

  it('未連携 → 409 not_connected (entitlement は通過するが token 無し)', async () => {
    seedSession(); // session あり・freee 未連携
    const res = await syncPOST(req('http://localhost/api/freee/sync', { entries: [income()] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_connected');
  });

  it('連携済・マッピング未設定 → 409 mapping_required', async () => {
    seedSession();
    seedFreeeConnected();
    const res = await syncPOST(req('http://localhost/api/freee/sync', { entries: [income()] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('mapping_required');
  });

  it('会社切替後の stale mapping (companyId 不一致) → 409 mapping_required (誤会社計上防止)', async () => {
    seedSession();
    seedFreeeConnected(); // token companyId = 7
    // 旧会社(99)の mapping が残っている
    h.store.set(
      `freee:map:${MERCHANT.toLowerCase()}`,
      JSON.stringify({ companyId: 99, accountItemId: 101, taxCode: 21 }),
    );
    mockFreeeFetch();
    const res = await syncPOST(req('http://localhost/api/freee/sync', { entries: [income()] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('mapping_required');
  });

  it('refresh token 失効 (token endpoint 4xx) → token 破棄 + 502 (再連携導線)', async () => {
    seedSession();
    // 期限切れ token → getValidAccessToken が refresh を試みる
    seedFreeeToken({ access: 'old', refresh: 'expiredR', expiresAt: 1, companyId: 7 });
    seedMapping();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    const res = await syncPOST(req('http://localhost/api/freee/sync', { entries: [income()] }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('token_refresh_failed');
    // token が破棄され、次回 status は not-connected になる (再連携導線)
    expect(h.store.has(`freee:tok:${MERCHANT.toLowerCase()}`)).toBe(false);
  });

  it('refresh が transient 5xx → token は破棄しない (再試行可能に残す)', async () => {
    seedSession();
    seedFreeeToken({ access: 'old', refresh: 'R', expiresAt: 1, companyId: 7 });
    seedMapping();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'server' }, 503));
    const res = await syncPOST(req('http://localhost/api/freee/sync', { entries: [income()] }));
    expect(res.status).toBe(502);
    expect(h.store.has(`freee:tok:${MERCHANT.toLowerCase()}`)).toBe(true); // 残す
  });
});

describe('GET/POST /api/freee/mapping (実グルー)', () => {
  it('GET: account_items / tax codes / 現在 mapping を返す', async () => {
    seedSession();
    seedFreeeConnected();
    seedMapping();
    mockFreeeFetch();
    const res = await mappingGET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.accountItems).toEqual([{ id: 101, name: '売上高' }]);
    expect(j.taxCodes).toEqual([{ code: 21, name: '課税売上10%' }]);
    expect(j.mapping).toMatchObject({ accountItemId: 101, taxCode: 21 });
  });

  it('POST: 選択した accountItemId/taxCode を KV に保存', async () => {
    seedSession();
    seedFreeeConnected();
    const res = await mappingPOST(
      req('http://localhost/api/freee/mapping', { accountItemId: 555, taxCode: 21 }),
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(h.store.get(`freee:map:${MERCHANT.toLowerCase()}`)!);
    expect(saved).toEqual({ companyId: 7, accountItemId: 555, taxCode: 21 });
  });

  it('POST: 不正 body → 400 invalid_mapping', async () => {
    seedSession();
    seedFreeeConnected();
    const res = await mappingPOST(
      req('http://localhost/api/freee/mapping', { accountItemId: 'x' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/freee/callback (実グルー: state消費→CSRF→token交換→保存)', () => {
  it('成功: token 交換 → 保存 → returnTo へ freee=connected で 302', async () => {
    seedSession();
    h.store.set(
      'freee:state:STATE1',
      JSON.stringify({ wallet: MERCHANT, returnTo: '/ja/history' }),
    );
    mockFreeeFetch();
    const res = await callbackGET(
      new Request('http://localhost/api/freee/callback?code=CODE&state=STATE1'),
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/ja/history');
    expect(loc).toContain('freee=connected');
    // token が保存されている
    expect(h.store.has(`freee:tok:${MERCHANT.toLowerCase()}`)).toBe(true);
    // state は消費済 (再利用不可)
    expect(h.store.has('freee:state:STATE1')).toBe(false);
  });

  it('freee token 交換が失敗 → 生500でなく errorRedirect(token_exchange_failed)', async () => {
    seedSession();
    h.store.set('freee:state:STATE3', JSON.stringify({ wallet: MERCHANT, returnTo: '/' }));
    // token endpoint が 500 → exchangeCode が throw → catch で graceful redirect
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'server_error' }, 500));
    const res = await callbackGET(
      new Request('http://localhost/api/freee/callback?code=CODE&state=STATE3'),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location') ?? '').toContain('reason=token_exchange_failed');
  });

  it('open-redirect 防御: state の returnTo が外部URLでも同一オリジン / に倒す', async () => {
    seedSession();
    // KV 破損/改竄を想定し、authorize を介さず外部 URL を直接 state に仕込む
    h.store.set(
      'freee:state:STATE4',
      JSON.stringify({ wallet: MERCHANT, returnTo: 'https://evil.com/phish' }),
    );
    mockFreeeFetch();
    const res = await callbackGET(
      new Request('http://localhost/api/freee/callback?code=CODE&state=STATE4'),
    );
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.origin).toBe('http://localhost'); // evil.com へは飛ばさない
    expect(loc.pathname).toBe('/');
    expect(loc.searchParams.get('freee')).toBe('connected');
  });

  it('open-redirect 防御: プロトコル相対 //evil も / に倒す', async () => {
    seedSession();
    h.store.set(
      'freee:state:STATE5',
      JSON.stringify({ wallet: MERCHANT, returnTo: '//evil.com' }),
    );
    mockFreeeFetch();
    const res = await callbackGET(
      new Request('http://localhost/api/freee/callback?code=CODE&state=STATE5'),
    );
    expect(new URL(res.headers.get('location') ?? '').origin).toBe('http://localhost');
  });

  it('別会社で再連携 → 旧会社の mapping を破棄 (再マッピング要求)', async () => {
    seedSession();
    h.store.set('freee:state:STATE6', JSON.stringify({ wallet: MERCHANT, returnTo: '/' }));
    h.store.set(
      `freee:meta:${MERCHANT.toLowerCase()}`,
      JSON.stringify({ companyId: 7, companyName: '旧商店' }),
    );
    h.store.set(
      `freee:map:${MERCHANT.toLowerCase()}`,
      JSON.stringify({ companyId: 7, accountItemId: 101, taxCode: 21 }),
    );
    // 新連携先 = company 99
    mockFreeeFetch({
      token: { access_token: 'AT', refresh_token: 'RT', expires_in: 21_600, company_id: 99 },
      companies: { companies: [{ id: 99, display_name: '新商店' }] },
    });
    await callbackGET(new Request('http://localhost/api/freee/callback?code=C&state=STATE6'));
    expect(h.store.has(`freee:map:${MERCHANT.toLowerCase()}`)).toBe(false); // 旧 mapping 破棄
    expect(JSON.parse(h.store.get(`freee:meta:${MERCHANT.toLowerCase()}`)!).companyId).toBe(99);
  });

  it('同一会社で再連携 → mapping は保持', async () => {
    seedSession();
    h.store.set('freee:state:STATE7', JSON.stringify({ wallet: MERCHANT, returnTo: '/' }));
    h.store.set(
      `freee:meta:${MERCHANT.toLowerCase()}`,
      JSON.stringify({ companyId: 7, companyName: 'X' }),
    );
    h.store.set(
      `freee:map:${MERCHANT.toLowerCase()}`,
      JSON.stringify({ companyId: 7, accountItemId: 101, taxCode: 21 }),
    );
    mockFreeeFetch(); // company_id = 7 (既定・同一会社)
    await callbackGET(new Request('http://localhost/api/freee/callback?code=C&state=STATE7'));
    expect(h.store.has(`freee:map:${MERCHANT.toLowerCase()}`)).toBe(true); // 保持
  });

  it('CSRF: state の wallet とセッション address 不一致 → session_mismatch', async () => {
    seedSession(); // session = MERCHANT
    h.store.set(
      'freee:state:STATE2',
      JSON.stringify({ wallet: '0x0000000000000000000000000000000000000001', returnTo: '/' }),
    );
    const res = await callbackGET(
      new Request('http://localhost/api/freee/callback?code=CODE&state=STATE2'),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location') ?? '').toContain('reason=session_mismatch');
  });

  it('companies 空 → reason=no_company で errorRedirect し、KV に token を保存しない', async () => {
    seedSession();
    h.store.set(
      'freee:state:STATE_NC',
      JSON.stringify({ wallet: MERCHANT, returnTo: '/' }),
    );
    // token endpoint は company_id なし、companies API は空配列を返す。
    mockFreeeFetch({
      token: { access_token: 'AT', refresh_token: 'RT', expires_in: 21_600 },
      companies: { companies: [] },
    });
    const res = await callbackGET(
      new Request('http://localhost/api/freee/callback?code=CODE&state=STATE_NC'),
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('reason=no_company');
    // KV に token が保存されていないこと (setToken が呼ばれていない)。
    expect(h.store.has(`freee:tok:${MERCHANT.toLowerCase()}`)).toBe(false);
  });
});
