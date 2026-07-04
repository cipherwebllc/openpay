// GET /.well-known/x402 (x402scan discovery fan-out) の検証。
// flag OFF = 404 / payTo 未設定 = resources 空 / 設定済み = first-party URL 列挙。

import { afterEach, describe, expect, it, vi } from 'vitest';

const SELLER = '0x00000000000000000000000000000000000000A1';

async function load(flag: string, payTo: string) {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', flag);
  vi.stubEnv('X402_PAY_TO_ADDRESS', payTo);
  vi.resetModules();
  const mod = await import('@/app/.well-known/x402/route');
  return mod.GET as () => Promise<Response>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /.well-known/x402', () => {
  it('flag OFF → 404 (完全 inert)', async () => {
    const get = await load('', SELLER);
    const res = await get();
    expect(res.status).toBe(404);
  });

  it('payTo 未設定 → resources 空 (支払えない URL を広告しない)', async () => {
    const get = await load('1', '');
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; resources: string[] };
    expect(body.version).toBe(1);
    expect(body.resources).toEqual([]);
  });

  it('payTo == feeReceiver → resources 空 (forwarder が拒否する構成を広告しない)', async () => {
    vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', SELLER);
    const get = await load('1', SELLER);
    const res = await get();
    const body = (await res.json()) as { resources: string[] };
    expect(body.resources).toEqual([]);
  });

  it('payTo 設定済み → first-party 2 本を x402scan 互換形式で返す + edge キャッシュ可', async () => {
    const get = await load('1', SELLER);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage');
    const body = (await res.json()) as { version: number; resources: string[] };
    expect(body).toEqual({
      version: 1,
      resources: [
        'https://open-pay.jp/api/paid/demo',
        'https://open-pay.jp/api/paid/stores',
      ],
    });
  });
});
