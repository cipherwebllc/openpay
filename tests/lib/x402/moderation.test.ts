import { describe, it, expect } from 'vitest';
import { isFreelyAccessible, isPrivateHost } from '@/lib/x402/moderation';

// status を返すだけの fetch スタブ。
const fetchWith = (status: number): typeof fetch =>
  (async () => ({ status }) as Response) as unknown as typeof fetch;
const fetchThrows: typeof fetch = (async () => {
  throw new Error('network');
}) as unknown as typeof fetch;

describe('lib/x402/moderation isFreelyAccessible', () => {
  it('200 (無料公開) → true (= 登録拒否対象)', async () => {
    expect(await isFreelyAccessible('https://x.test', fetchWith(200))).toBe(true);
  });

  it.each([402, 401, 403, 404, 500, 503])(
    'ゲート/不明 (%i) → false (= 通す)',
    async (status) => {
      expect(await isFreelyAccessible('https://x.test', fetchWith(status))).toBe(false);
    },
  );

  it('ネットワークエラー/タイムアウト → false (fail-open)', async () => {
    expect(await isFreelyAccessible('https://x.test', fetchThrows)).toBe(false);
  });
});

describe('lib/x402/moderation isPrivateHost', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '::1',
    'svc.local',
    'db.internal',
  ])('private/loopback %s → true', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(['example.com', 'api.aegis-ai.xyz', '8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1'])(
    'public %s → false',
    (host) => {
      expect(isPrivateHost(host)).toBe(false);
    },
  );
});
