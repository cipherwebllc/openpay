import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  tokenNeedsRefresh,
  buildAuthorizeUrl,
  getValidAccessToken,
  exchangeCode,
  refreshAccessToken,
  getCompanies,
  getAccountItems,
  getTaxCodes,
  createDeal,
  encryptStoredToken,
  decryptStoredToken,
  type StoredToken,
  type FreeeEnv,
} from '@/lib/freee';

// fetch を JSON Response で stub するヘルパ。lib/freee の実パース/エラー処理を実行する
// (network 境界のみ mock・コード自体は本物)。
function mockFetchOnce(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

const ENV: FreeeEnv = {
  clientId: 'cid',
  clientSecret: 'sec',
  redirectUri: 'https://app.example/api/freee/callback',
};
const ENC_KEY = '00'.repeat(32);

afterEach(() => vi.restoreAllMocks());

describe('freee token encryption', () => {
  it('encryptStoredToken/decryptStoredToken: round-trip equals original token', () => {
    const old = process.env.FREEE_TOKEN_ENC_KEY;
    process.env.FREEE_TOKEN_ENC_KEY = ENC_KEY;
    try {
      const token: StoredToken = {
        access: 'AT',
        refresh: 'RT',
        expiresAt: 123_456,
        companyId: 7,
      };
      const encrypted = encryptStoredToken('0xABCDEF', token);
      expect(JSON.parse(encrypted)).toMatchObject({ v: 1, alg: 'A256GCM' });
      expect(decryptStoredToken('0xabcdef', encrypted)).toEqual(token);
    } finally {
      if (old === undefined) {
        delete process.env.FREEE_TOKEN_ENC_KEY;
      } else {
        process.env.FREEE_TOKEN_ENC_KEY = old;
      }
    }
  });

  it('P3: 別 wallet の AAD では復号できない (AAD 束縛)', () => {
    const old = process.env.FREEE_TOKEN_ENC_KEY;
    process.env.FREEE_TOKEN_ENC_KEY = ENC_KEY;
    try {
      const token: StoredToken = { access: 'AT', refresh: 'RT', expiresAt: 1, companyId: 7 };
      const encrypted = encryptStoredToken('0xaaaa', token);
      // AAD (wallet) が違うと GCM 認証に失敗し null (別 wallet が他人の token を復号できない)。
      expect(decryptStoredToken('0xbbbb', encrypted)).toBeNull();
    } finally {
      if (old === undefined) delete process.env.FREEE_TOKEN_ENC_KEY;
      else process.env.FREEE_TOKEN_ENC_KEY = old;
    }
  });

  it('P3: ciphertext 改竄で GCM 認証失敗 (tag 検証)', () => {
    const old = process.env.FREEE_TOKEN_ENC_KEY;
    process.env.FREEE_TOKEN_ENC_KEY = ENC_KEY;
    try {
      const token: StoredToken = { access: 'AT', refresh: 'RT', expiresAt: 1, companyId: 7 };
      const encrypted = encryptStoredToken('0xaaaa', token);
      const env = JSON.parse(encrypted) as Record<string, string>;
      // ct (ciphertext) の 1 文字を差し替えて改竄。GCM の authTag 検証で復号が throw する。
      const ct = env.ct;
      env.ct = (ct[0] === 'a' ? 'b' : 'a') + ct.slice(1);
      // GCM の authTag 検証で復号が失敗し null を返す (改竄検知)。
      expect(decryptStoredToken('0xaaaa', JSON.stringify(env))).toBeNull();
    } finally {
      if (old === undefined) delete process.env.FREEE_TOKEN_ENC_KEY;
      else process.env.FREEE_TOKEN_ENC_KEY = old;
    }
  });
});

describe('tokenNeedsRefresh', () => {
  const now = 1_000_000;
  it('期限まで skew(60s) 以内なら true', () => {
    expect(
      tokenNeedsRefresh({ access: 'a', refresh: 'r', expiresAt: now + 30_000, companyId: 1 }, now),
    ).toBe(true);
  });
  it('十分先なら false', () => {
    expect(
      tokenNeedsRefresh({ access: 'a', refresh: 'r', expiresAt: now + 120_000, companyId: 1 }, now),
    ).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('response_type=code + client_id + redirect_uri + state', () => {
    const u = new URL(buildAuthorizeUrl(ENV, 'st8'));
    expect(u.origin + u.pathname).toBe(
      'https://accounts.secure.freee.co.jp/public_api/authorize',
    );
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe(ENV.redirectUri);
    expect(u.searchParams.get('state')).toBe('st8');
  });
});

describe('getValidAccessToken', () => {
  it('未期限切れ → そのまま返し fetch も persist もしない', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const now = 1_000_000;
    const stored: StoredToken = {
      access: 'A',
      refresh: 'R',
      expiresAt: now + 10 * 60_000,
      companyId: 9,
    };
    const persist = vi.fn();
    const access = await getValidAccessToken(ENV, stored, persist, now);
    expect(access).toBe('A');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('期限近接 → refresh + 新 token を persist (rotation・companyId 引継ぎ)', async () => {
    const now = 1_000_000;
    const stored: StoredToken = {
      access: 'old',
      refresh: 'oldR',
      expiresAt: now + 1_000,
      companyId: 9,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'newA',
          refresh_token: 'newR',
          expires_in: 21_600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const persisted: StoredToken[] = [];
    const persist = vi.fn(async (t: StoredToken) => {
      persisted.push(t);
    });
    const access = await getValidAccessToken(ENV, stored, persist, now);
    expect(access).toBe('newA');
    expect(persisted[0]).toMatchObject({
      access: 'newA',
      refresh: 'newR',
      companyId: 9, // refresh 応答に company_id 無し → 既存を引継ぎ
    });
    expect(persisted[0].expiresAt).toBe(now + 21_600 * 1000);
  });
});

describe('exchangeCode / requestToken (実パース + form body + エラー)', () => {
  it('token JSON → StoredToken (expiresAt 計算・companyId)・form body に grant/secret/code', async () => {
    const fetchSpy = mockFetchOnce({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 21_600,
      company_id: 12,
    });
    const tok = await exchangeCode(ENV, 'the-code', 1_000_000);
    expect(tok).toEqual({
      access: 'AT',
      refresh: 'RT',
      expiresAt: 1_000_000 + 21_600 * 1000,
      companyId: 12,
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://accounts.secure.freee.co.jp/public_api/token');
    const body = String(init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=the-code');
    expect(body).toContain('client_secret=sec');
  });

  it('company_id 無し → companyId:null', async () => {
    mockFetchOnce({ access_token: 'AT', refresh_token: 'RT', expires_in: 600 });
    const tok = await exchangeCode(ENV, 'c', 0);
    expect(tok.companyId).toBeNull();
  });

  it('token endpoint 非 200 → freee_token_http_{status} を throw', async () => {
    mockFetchOnce({ error: 'invalid_grant' }, 400);
    await expect(refreshAccessToken(ENV, 'badR', 0)).rejects.toThrow('freee_token_http_400');
  });
});

describe('freee 会計 API (実パース + 認可ヘッダ + エラー)', () => {
  it('getCompanies: display_name>name>id の順で名前解決・空は []', async () => {
    const spy = mockFetchOnce({
      companies: [
        { id: 1, display_name: 'A 商店', name: 'A' },
        { id: 2, name: 'B' },
        { id: 3 },
      ],
    });
    const companies = await getCompanies('AT');
    expect(companies).toEqual([
      { id: 1, name: 'A 商店' },
      { id: 2, name: 'B' },
      { id: 3, name: '3' },
    ]);
    // Bearer 認可ヘッダが付く
    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer AT');

    mockFetchOnce({});
    expect(await getCompanies('AT')).toEqual([]);
  });

  it('getAccountItems: company_id クエリ付き URL + マッピング', async () => {
    const spy = mockFetchOnce({ account_items: [{ id: 5, name: '売上高' }] });
    const items = await getAccountItems('AT', 7);
    expect(items).toEqual([{ id: 5, name: '売上高' }]);
    expect(String(spy.mock.calls[0][0])).toContain('/account_items?company_id=7');
  });

  it('getTaxCodes: code/name マッピング', async () => {
    mockFetchOnce({ taxes: [{ code: 21, name: '課税売上10%' }] });
    expect(await getTaxCodes('AT')).toEqual([{ code: 21, name: '課税売上10%' }]);
  });

  it('createDeal: deal.id を返す', async () => {
    const spy = mockFetchOnce({ deal: { id: 9001 } });
    const id = await createDeal('AT', {
      company_id: 7,
      issue_date: '2026-06-15',
      type: 'income',
      details: [{ account_item_id: 5, tax_code: 21, amount: 1000, description: 'x' }],
    });
    expect(id).toBe(9001);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).type).toBe('income');
  });

  it('createDeal: 非 200 → freee_api_http_{status}', async () => {
    mockFetchOnce({ message: 'forbidden' }, 403);
    await expect(
      createDeal('AT', {
        company_id: 7,
        issue_date: '2026-06-15',
        type: 'income',
        details: [],
      }),
    ).rejects.toThrow('freee_api_http_403');
  });

  it('createDeal: deal.id 欠落 → freee_deal_no_id', async () => {
    mockFetchOnce({ deal: {} });
    await expect(
      createDeal('AT', {
        company_id: 7,
        issue_date: '2026-06-15',
        type: 'income',
        details: [],
      }),
    ).rejects.toThrow('freee_deal_no_id');
  });
});
