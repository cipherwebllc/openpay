// cron route 共通の Bearer 認証 (C4)。
// 柱: (1) CRON_SECRET 未設定は fail-closed で false、(2) 不一致/欠落は false、
//     (3) 一致だけ true、(4) 比較は timing-safe (前方一致でも通さない)。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireCronAuth } from '@/lib/cronAuth';
import { safeEqual } from '@/lib/net/safeEqual';

const SECRET = 'cron-test-secret';

function req(authorization?: string): Request {
  return new Request('https://open-pay.jp/api/cron/reverify', {
    headers: authorization ? { authorization } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireCronAuth', () => {
  it('CRON_SECRET 未設定は bearer の有無によらず false (fail-closed)', () => {
    vi.stubEnv('CRON_SECRET', '');
    expect(requireCronAuth(req())).toBe(false);
    expect(requireCronAuth(req('Bearer '))).toBe(false);
    expect(requireCronAuth(req(`Bearer ${SECRET}`))).toBe(false);
  });

  it('header 欠落・不一致・前方一致・大小違いはすべて false', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect(requireCronAuth(req())).toBe(false);
    expect(requireCronAuth(req('Bearer wrong-secret'))).toBe(false);
    expect(requireCronAuth(req('Bearer cron-test-secre'))).toBe(false); // 前方一致
    expect(requireCronAuth(req(`Bearer ${SECRET}x`))).toBe(false);
    expect(requireCronAuth(req(SECRET))).toBe(false); // Bearer prefix なし
    expect(requireCronAuth(req(`bearer ${SECRET}`))).toBe(false);
  });

  it('完全一致だけ true', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect(requireCronAuth(req(`Bearer ${SECRET}`))).toBe(true);
  });
});

describe('safeEqual', () => {
  it('長さの異なる入力でも throw せず false を返す (digest 比較)', () => {
    expect(safeEqual('a', 'a-much-longer-value')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('same', 'same')).toBe(true);
  });
});
