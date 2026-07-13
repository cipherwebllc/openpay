import { describe, expect, it } from 'vitest';
import { probeDirectorySource } from '@/lib/directory/verification';

const lookupPublic = async () => [{ address: '93.184.216.34' }];

describe('directory source liveness probe', () => {
  it.each([200, 204, 301, 302, 307, 308])('status %i は reachable', async (status) => {
    const fetchImpl = (async () => new Response(null, { status })) as typeof fetch;
    expect(
      await probeDirectorySource('https://source.test', {
        fetchImpl,
        lookup: lookupPublic,
      }),
    ).toBe(true);
  });

  it.each([400, 404, 429, 500, 503])('status %i は unreachable', async (status) => {
    const fetchImpl = (async () => new Response(null, { status })) as typeof fetch;
    expect(
      await probeDirectorySource('https://source.test', {
        fetchImpl,
        lookup: lookupPublic,
      }),
    ).toBe(false);
  });
});
