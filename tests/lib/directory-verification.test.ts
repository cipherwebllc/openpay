import { describe, expect, it } from 'vitest';
import { probeDirectorySource } from '@/lib/directory/verification';

const lookupPublic = async () => [{ address: '93.184.216.34' }];

describe('directory source liveness probe (三値)', () => {
  it.each([200, 204, 301, 302, 307, 308])('status %i → true (到達)', async (status) => {
    const fetchImpl = (async () => new Response(null, { status })) as typeof fetch;
    expect(
      await probeDirectorySource('https://source.test', {
        fetchImpl,
        lookup: lookupPublic,
      }),
    ).toBe(true);
  });

  it.each([404, 410])('status %i → false (確定消滅)', async (status) => {
    const fetchImpl = (async () => new Response(null, { status })) as typeof fetch;
    expect(
      await probeDirectorySource('https://source.test', {
        fetchImpl,
        lookup: lookupPublic,
      }),
    ).toBe(false);
  });

  // 生きているサイトが bot 保護 (Cloudflare 403 等) や一時障害でこれらを返す。
  // false に潰すと本番 /api/directory が sourceOk:false の誤情報を配信する (2026-07-14 実害)。
  it.each([400, 401, 403, 429, 500, 503])(
    'status %i → null (判定不能・false にしない)',
    async (status) => {
      const fetchImpl = (async () => new Response(null, { status })) as typeof fetch;
      expect(
        await probeDirectorySource('https://source.test', {
          fetchImpl,
          lookup: lookupPublic,
        }),
      ).toBe(null);
    },
  );

  it('fetch 失敗 (network/timeout/SSRF block) → null (判定不能)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect(
      await probeDirectorySource('https://source.test', {
        fetchImpl,
        lookup: lookupPublic,
      }),
    ).toBe(null);
  });
});
