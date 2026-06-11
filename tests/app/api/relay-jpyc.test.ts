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

// recover (forwarder) × a1 (usage fee) の併用は misconfig。recover 経路は利用料ゲート/
// 出来高メーターを通らないため、module load で fail-fast する (静かにゲート素通りさせない)。
// 静的 import 済みの POST binding は resetModules の影響を受けないので他テストとは独立。
describe('recover × a1 同時設定の fail-fast', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('forwarder + NEXT_PUBLIC_ENABLE_USAGE_FEE=1 → module load が throw', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    vi.stubEnv(
      'NEXT_PUBLIC_JPYC_FORWARDER_POLYGON',
      '0x0000000000000000000000000000000000000001',
    );
    await expect(import('@/app/api/relay/jpyc/route')).rejects.toThrow(
      /併用できません/,
    );
  });

  it('a1 のみ (forwarder 無し) → 正常 load', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '1');
    const mod = await import('@/app/api/relay/jpyc/route');
    expect(typeof mod.POST).toBe('function');
  });

  it('forwarder のみ (a1 無し) → 正常 load (recover 構成は throw しない)', async () => {
    vi.resetModules();
    vi.stubEnv(
      'NEXT_PUBLIC_JPYC_FORWARDER_POLYGON',
      '0x0000000000000000000000000000000000000001',
    );
    const mod = await import('@/app/api/relay/jpyc/route');
    expect(typeof mod.POST).toBe('function');
  });
});
