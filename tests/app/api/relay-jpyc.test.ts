import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST } from '@/app/api/relay/jpyc/route';

// RELAYER_PRIVATE_KEY も GELATO_SPONSOR_API_KEY もテスト env に無いため、provider は起動時に
// null と判定され route は 503 relay_not_configured を返す = 設定するまで inert (client は
// 他 provider に fallback)。鍵が要る検証/submit/poll の分岐は DI コア (jpycRelay.test.ts) と
// self-host I/O (selfHostRelayer.test.ts) で担保。
function req(body: unknown): Request {
  return new Request('http://localhost/api/relay/jpyc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/relay/jpyc (env-gate)', () => {
  it('GELATO_SPONSOR_API_KEY 未設定なら 503 relay_not_configured (inert・fallback signal)', async () => {
    const res = await POST(req({ chainId: 137 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'relay_not_configured',
    });
  });
});

// recover (forwarder) × a1 (usage fee) の併用 invariant。recover 経路は利用料ゲート/
// 出来高メーターを通らないため、mainnet ではリクエスト時に 503 で fail-closed する。
// module load では throw しない (開発 .env.local の testnet 併設や next build を壊さない)。
// 静的 import 済みの POST binding は resetModules の影響を受けないので他テストとは独立。
describe('recover × a1 同時設定の排他 (mainnet fail-closed)', () => {
  // 検証用 self-host 鍵 (秘密情報ではない・テスト専用の決定論値)。
  const DUMMY_RELAYER_KEY = `0x${'11'.repeat(32)}`;
  const DUMMY_FORWARDER = '0x0000000000000000000000000000000000000001';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('mainnet forwarder + a1 + self-host → POST は 503 relay_misconfigured (ゲート素通りさせない)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', DUMMY_FORWARDER);
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 137 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_misconfigured' });
  });

  it('mainnet forwarder + a1 でも module load は throw しない (next build を壊さない)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', DUMMY_FORWARDER);
    const mod = await import('@/app/api/relay/jpyc/route');
    expect(typeof mod.POST).toBe('function');
  });

  it('testnet forwarder (Amoy) + a1 → relay_misconfigured にはならない (開発併設を許容)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', DUMMY_FORWARDER);
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 80002 }));
    // testnet は排他 503 を出さず通常フローへ進む (このリクエストは body 不足の 400 で落ちる)。
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('relay_misconfigured');
  });

  it('a1 のみ (forwarder 無し) + self-host → mainnet でも relay_misconfigured にならない', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 137 }));
    const body = (await res.json()) as { error?: string };
    // free モードの通常フロー (このテスト env では B5 gas ceiling 未設定の 503 に落ちる)
    expect(body.error).not.toBe('relay_misconfigured');
  });

  it('forwarder のみ (a1 無し) + self-host → relay_misconfigured にならない (recover 構成は許可)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', DUMMY_FORWARDER);
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 137 }));
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('relay_misconfigured');
  });
});
