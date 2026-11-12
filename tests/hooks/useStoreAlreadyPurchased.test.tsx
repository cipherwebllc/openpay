import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStoreAlreadyPurchased } from '@/hooks/useStoreAlreadyPurchased';

// 第 10 回レビュー H-K: 購入の前に「この買い手はこの商品を購入済みか」を、購入の有無だけを返す route
// (GET /api/store/purchased/{id}) で確かめる hook。mock は fetch (境界) だけ。

const RESOURCE_ID = `h_${'a'.repeat(32)}`;
const OTHER_RESOURCE_ID = `h_${'b'.repeat(32)}`;
const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x4444444444444444444444444444444444444444';
const INTENT_SALT = `0x${'ab'.repeat(32)}`;
const PURCHASED_AT = 1_799_000_000_000;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** app/api/store/purchased/[resourceId]/route.ts が購入の記録 (grant) に基づいて返す 200。 */
function purchasedBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    purchased: true,
    purchasedAt: PURCHASED_AT,
    ...overrides,
  };
}

type Props = {
  sessionAddress: string | null;
  enabled: boolean;
  refreshKey: string | null;
  resourceId: string;
};

function renderKnown(
  overrides: Partial<Props> = {},
  options: { reactStrictMode?: boolean } = {},
) {
  const initialProps: Props = {
    sessionAddress: WALLET_A,
    enabled: true,
    refreshKey: null,
    resourceId: RESOURCE_ID,
    ...overrides,
  };
  return renderHook((props: Props) => useStoreAlreadyPurchased(props), {
    initialProps,
    ...options,
  });
}

/** 進行中の fetch と effect を流し切る。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useStoreAlreadyPurchased', () => {
  it('購入の有無の route が購入の記録を返したら、購入日時つきで購入済みを返す (cookie つき)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(purchasedBody(), 200));
    const { result } = renderKnown();
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(result.current).toEqual({ purchasedAt: PURCHASED_AT }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    // 商品の本文を返す /api/store/content/{id} は読まない (rate limit の枠を分けた route だけを読む)。
    expect(url).toBe(`/api/store/purchased/${RESOURCE_ID}`);
    expect(init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it('id は URL に入れる前に encode する', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(purchasedBody(), 200));
    renderKnown({ resourceId: 'h_a/b?c' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/store/purchased/h_a%2Fb%3Fc');
  });

  it.each([
    ['purchased: false (購入の記録なし)', () => jsonResponse({ ok: true, purchased: false }, 200)],
    ['404 (Store が OFF)', () => jsonResponse({ ok: false, error: 'not_found' }, 404)],
    ['401 (session 切れ)', () => jsonResponse({ ok: false, error: 'unauthenticated' }, 401)],
    ['429 (rate limit)', () => jsonResponse({ ok: false, error: 'rate_limited' }, 429)],
    ['503 (storage)', () => jsonResponse({ ok: false, error: 'storage_unavailable' }, 503)],
    ['JSON でない 200', () => new Response('<html>', { status: 200 })],
    ['JSON の null', () => jsonResponse(null, 200)],
    ['JSON の配列', () => jsonResponse([purchasedBody()], 200)],
    ['ok でない 200', () => jsonResponse(purchasedBody({ ok: false }), 200)],
    ['purchased が true でない 200 (文字列)', () => jsonResponse(purchasedBody({ purchased: 'true' }), 200)],
    ['purchased の無い 200', () => jsonResponse(purchasedBody({ purchased: undefined }), 200)],
    ['200 でない応答 (本文が購入済みの形でも)', () => jsonResponse(purchasedBody(), 503)],
    ['購入日時の無い 200', () => jsonResponse(purchasedBody({ purchasedAt: undefined }), 200)],
    ['購入日時が数でない 200', () => jsonResponse(purchasedBody({ purchasedAt: '1799000000000' }), 200)],
    ['購入日時が 0 の 200', () => jsonResponse(purchasedBody({ purchasedAt: 0 }), 200)],
    ['購入日時が整数でない 200', () => jsonResponse(purchasedBody({ purchasedAt: 1.5 }), 200)],
  ])('%s は購入済みにしない', async (_label, respond) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => respond());
    const { result } = renderKnown();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flush();
    expect(result.current).toBeNull();
  });

  it('読み取りの失敗 (通信断) を外へ投げず、購入済みにもしない', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderKnown();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flush();
    expect(result.current).toBeNull();
  });

  it('未ログイン (session なし)・画面が閉じている間は読まない', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(purchasedBody(), 200));
    const signedOut = renderKnown({ sessionAddress: null });
    const closed = renderKnown({ enabled: false });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signedOut.result.current).toBeNull();
    expect(closed.result.current).toBeNull();
  });

  it('別のウォレットで分かった購入済みを、切り替えた後のウォレットに使わない', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => jsonResponse(purchasedBody(), 200))
      // 切り替えた後のウォレットには、まだ応答しない (読み込み中)。
      .mockImplementation(() => new Promise<Response>(() => {}));
    const { result, rerender } = renderKnown();
    await waitFor(() =>
      expect(result.current).toEqual({ purchasedAt: PURCHASED_AT }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({
      sessionAddress: WALLET_B,
      enabled: true,
      refreshKey: null,
      resourceId: RESOURCE_ID,
    });
    expect(result.current).toBeNull();
    await flush();
    expect(result.current).toBeNull();
  });

  it('別の商品で分かった購入済みを、切り替えた後の商品に使わない', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        String(input) === `/api/store/purchased/${RESOURCE_ID}`
          ? jsonResponse(purchasedBody(), 200)
          : jsonResponse({ ok: true, purchased: false }, 200),
      );
    const { result, rerender } = renderKnown();
    await waitFor(() =>
      expect(result.current).toEqual({ purchasedAt: PURCHASED_AT }),
    );
    rerender({
      sessionAddress: WALLET_A,
      enabled: true,
      refreshKey: null,
      resourceId: OTHER_RESOURCE_ID,
    });
    expect(result.current).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await flush();
    expect(result.current).toBeNull();
  });

  it('切り替える前のウォレットへの応答が後から届いても、今のウォレットに使わない', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(async () =>
        jsonResponse({ ok: true, purchased: false }, 200),
      );
    const { result, rerender } = renderKnown();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({
      sessionAddress: WALLET_B,
      enabled: true,
      refreshKey: null,
      resourceId: RESOURCE_ID,
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveFirst?.(jsonResponse(purchasedBody(), 200));
      await Promise.resolve();
    });
    await flush();
    expect(result.current).toBeNull();
  });

  it('refreshKey が変わると読み直し、画面を開いた後に確定した購入を拾う', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () =>
        jsonResponse({ ok: true, purchased: false }, 200),
      )
      .mockImplementation(async () => jsonResponse(purchasedBody(), 200));
    const { result, rerender } = renderKnown();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flush();
    expect(result.current).toBeNull();
    rerender({
      sessionAddress: WALLET_A,
      enabled: true,
      refreshKey: INTENT_SALT,
      resourceId: RESOURCE_ID,
    });
    await waitFor(() =>
      expect(result.current).toEqual({ purchasedAt: PURCHASED_AT }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('StrictMode の mount → unmount → mount でも、購入済みを 1 つの結果として返す', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(purchasedBody(), 200));
    const { result } = renderKnown({}, { reactStrictMode: true });
    await waitFor(() =>
      expect(result.current).toEqual({ purchasedAt: PURCHASED_AT }),
    );
    // 擬似 unmount で 1 本目を abort し、2 本目だけが結果を置く。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted,
    ).toBe(true);
    expect(
      (fetchMock.mock.calls[1]![1] as RequestInit).signal?.aborted,
    ).toBe(false);
  });
});
