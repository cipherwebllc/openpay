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

// recover (forwarder) × a1 (usage fee) の排他は resolver (jpycForwarderFor) で graceful に解決する:
// a1 が ON なら forwarderFor は全 chain で null を返すため recoverMode=false → handleFree に倒れ、
// 利用料ゲート/出来高メーターが効く。よって致命的な 503 (relay_misconfigured) は **出さない**
// (config guard が顧客の決済を壊すのは誤り)。両方を設定した運営の構成ミスは起動時 logger
// (configuredJpycForwarderFor 基準) で可視化される。
// module load では throw しない (開発 .env.local の併設や next build を壊さない)。
// 静的 import 済みの POST binding は resetModules の影響を受けないので他テストとは独立。
describe('recover × a1 同時設定の排他 (a1 優先で graceful free 化)', () => {
  // 検証用 self-host 鍵 (秘密情報ではない・テスト専用の決定論値)。
  const DUMMY_RELAYER_KEY = `0x${'11'.repeat(32)}`;
  const DUMMY_FORWARDER = '0x0000000000000000000000000000000000000001';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('mainnet forwarder + a1 + self-host → 503 relay_misconfigured を出さない (a1 優先で free モードに倒す)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', DUMMY_FORWARDER);
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 137 }));
    const body = (await res.json()) as { error?: string };
    // 致命的な排他 503 は出ない (顧客決済を壊さない)。a1 優先で forwarderFor=null → free モード。
    // このテスト env では mainnet self-host の B5 gas ceiling 未設定で 503 gas_ceiling_required に
    // 落ちるが、それは free 経路の前提条件であって recover 排他とは別物。
    expect(body.error).not.toBe('relay_misconfigured');
    expect(body.error).toBe('gas_ceiling_required');
  });

  it('mainnet forwarder + a1 でも module load は throw しない (next build を壊さない)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', DUMMY_FORWARDER);
    const mod = await import('@/app/api/relay/jpyc/route');
    expect(typeof mod.POST).toBe('function');
  });

  it('testnet forwarder (Amoy) + a1 → relay_misconfigured にはならない (free モードに倒れる)', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', DUMMY_FORWARDER);
    vi.stubEnv('RELAYER_PRIVATE_KEY', DUMMY_RELAYER_KEY);
    const mod = await import('@/app/api/relay/jpyc/route');
    const res = await mod.POST(req({ chainId: 80002 }));
    // testnet は free モードの通常フローへ進む (このリクエストは body 不足の 400 で落ちる)。
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('relay_misconfigured');
    expect(body.error).toBe('invalid_payload');
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
