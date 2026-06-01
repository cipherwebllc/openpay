import { describe, it, expect } from 'vitest';
import { POST } from '@/app/api/relay/jpyc/route';

// GELATO_SPONSOR_API_KEY はテスト env に無いため、route は env-gate で 503 relay_not_configured
// を返す = 設定するまで inert (client は他 provider に fallback)。鍵が要る検証/relay 経路の分岐は
// lib/relay/jpycRelay の DI コア (tests/lib/jpycRelay.test.ts) で担保。
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
