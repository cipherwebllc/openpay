import { beforeEach, describe, expect, it, vi } from 'vitest';

const INTENT_SALT = `0x${'a'.repeat(64)}`;
const TX_HASH = `0x${'b'.repeat(64)}`;

const hold = vi.hoisted(() => ({
  enabled: true,
  rateAllowed: true,
  reads: [] as unknown[],
  reconcileResult: { ok: true, state: 'pending' } as unknown,
}));

const getIntentSpy = vi.hoisted(() => vi.fn());
const reconcileSpy = vi.hoisted(() => vi.fn());
const getUsdcIntentSpy = vi.hoisted(() => vi.fn());
const reconcileUsdcSpy = vi.hoisted(() => vi.fn());
const rateLimitSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/env', () => ({
  env: {
    get enableCreatorStore() {
      return hold.enabled;
    },
  },
}));

vi.mock('@/lib/x402/purchaseIntent', () => ({
  isPurchaseIntentSalt: (value: unknown) =>
    typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value),
  getPurchaseIntent: getIntentSpy,
  reconcilePurchaseIntent: reconcileSpy,
}));

vi.mock('@/lib/x402/facilitatorStatusRateLimit', () => ({
  checkFacilitatorStatusRateLimit: rateLimitSpy,
}));
vi.mock('@/lib/x402/storeUsdcIntent', () => ({
  getStoreUsdcIntent: getUsdcIntentSpy,
  reconcileStoreUsdcIntent: reconcileUsdcSpy,
}));

import { GET } from '@/app/api/store/purchase/status/route';

function request(intentSalt?: string, rail?: string): Request {
  const url = new URL('https://open-pay.jp/api/store/purchase/status');
  if (intentSalt !== undefined) {
    url.searchParams.set('intentSalt', intentSalt);
  }
  if (rail !== undefined) url.searchParams.set('rail', rail);
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  hold.enabled = true;
  hold.rateAllowed = true;
  hold.reads = [];
  hold.reconcileResult = { ok: true, state: 'pending' };
  getIntentSpy.mockImplementation(async () => hold.reads.shift() ?? null);
  reconcileSpy.mockImplementation(async () => hold.reconcileResult);
  getUsdcIntentSpy.mockResolvedValue(null);
  reconcileUsdcSpy.mockResolvedValue({ ok: true, state: 'pending' });
  rateLimitSpy.mockImplementation(async () => hold.rateAllowed);
});

describe('GET /api/store/purchase/status', () => {
  it('creator-store flag OFF は最初に 404 + no-store で停止する', async () => {
    hold.enabled = false;

    const response = await GET(request('invalid'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(rateLimitSpy).not.toHaveBeenCalled();
    expect(getIntentSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('intentSalt の欠落・形式不正は storage を引く前に 400', async () => {
    for (const intentSalt of [undefined, '', 'not-an-intent']) {
      const response = await GET(request(intentSalt));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: 'invalid_intent',
      });
    }

    expect(rateLimitSpy).not.toHaveBeenCalled();
    expect(getIntentSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('未知の intent は 404', async () => {
    hold.reads = [null];

    const response = await GET(request(INTENT_SALT));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each(['storage', 'corrupt'])(
    'intent read の %s は偽の pending にせず 503',
    async (failure) => {
      hold.reads = [failure];

      const response = await GET(request(INTENT_SALT));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: 'storage_unavailable',
      });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(reconcileSpy).not.toHaveBeenCalled();
    },
  );

  it('rate limit 超過は 429 + Retry-After で intent を読まない', async () => {
    hold.rateAllowed = false;

    const response = await GET(request(INTENT_SALT));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: false,
      error: 'rate_limited',
    });
    expect(getIntentSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it.each(['signed', 'settling', 'indeterminate'])(
    '%s は status read から reconciler を起動し、再読込後の settled へ収束する',
    async (state) => {
      hold.reads = [{ state }, { state: 'settled', txHash: TX_HASH }];
      hold.reconcileResult = {
        ok: true,
        state: 'settled',
        txHash: TX_HASH,
      };

      const response = await GET(request(INTENT_SALT));

      expect(response.status).toBe(200);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(reconcileSpy).toHaveBeenCalledWith(INTENT_SALT);
      expect(getIntentSpy).toHaveBeenCalledTimes(2);
      expect(await response.json()).toEqual({
        ok: true,
        state: 'settled',
        txHash: TX_HASH,
      });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it('reconciler の storage 障害は pending 成功へ偽装せず 503', async () => {
    hold.reads = [{ state: 'indeterminate' }];
    hold.reconcileResult = { ok: false, reason: 'storage' };

    const response = await GET(request(INTENT_SALT));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'storage_unavailable',
    });
    expect(getIntentSpy).toHaveBeenCalledTimes(1);
  });

  it('rail=usdc は専用 intent/reconciler だけを使い coarse pending→settled へ収束する', async () => {
    getUsdcIntentSpy
      .mockResolvedValueOnce({ state: 'indeterminate' })
      .mockResolvedValueOnce({ state: 'settled', txHash: TX_HASH });
    reconcileUsdcSpy.mockResolvedValue({ ok: true, state: 'settled' });

    const response = await GET(request(INTENT_SALT, 'usdc'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: 'settled',
      txHash: TX_HASH,
    });
    expect(reconcileUsdcSpy).toHaveBeenCalledWith(INTENT_SALT);
    expect(getUsdcIntentSpy).toHaveBeenCalledTimes(2);
    expect(getIntentSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('rail=usdc の storage/corrupt は pending に偽装せず 503', async () => {
    getUsdcIntentSpy.mockResolvedValue('corrupt');
    const response = await GET(request(INTENT_SALT, 'usdc'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'storage_unavailable',
    });
    expect(reconcileUsdcSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      intent: {
        state: 'quoted',
        payerHint: 'secret-payer',
        metadata: { title: 'secret-title' },
      },
      expected: { ok: true, state: 'pending' },
    },
    {
      intent: {
        state: 'failed_prebroadcast',
        failureReason: 'secret-reason',
      },
      expected: { ok: true, state: 'failed' },
    },
    {
      intent: {
        state: 'settled',
        txHash: TX_HASH,
        claim: { nonce: `0x${'c'.repeat(64)}` },
        metadata: { title: 'secret-title' },
      },
      expected: { ok: true, state: 'settled', txHash: TX_HASH },
    },
  ])(
    '公開 response は coarse state と settled txHash だけを返す',
    async ({ intent, expected }) => {
      hold.reads = [intent];

      const response = await GET(request(INTENT_SALT));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(reconcileSpy).not.toHaveBeenCalled();
    },
  );
});
