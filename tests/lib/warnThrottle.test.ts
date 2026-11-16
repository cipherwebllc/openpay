// @vitest-environment node
// lib/warnThrottle.ts: 同じ名前の警告は instance の中で 60 秒に 1 回まで。最初の 1 回は必ず出る。名前ごとに別に数える。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

import {
  WARN_THROTTLE_INTERVAL_MS,
  __resetWarnThrottleForTest,
  warnThrottled,
} from '@/lib/warnThrottle';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function at(ms: number): void {
  vi.setSystemTime(T0 + ms);
}

beforeEach(() => {
  warn.mockReset();
  __resetWarnThrottleForTest();
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('warnThrottled', () => {
  it('間隔は 60 秒', () => {
    expect(WARN_THROTTLE_INTERVAL_MS).toBe(60_000);
  });

  it('最初の 1 回は必ず出し、fields をそのまま渡す', () => {
    warnThrottled('x402.discovery.read_failed', { id: 'res-1' });
    expect(warn).toHaveBeenCalledExactlyOnceWith('x402.discovery.read_failed', { id: 'res-1' });
  });

  it('60 秒の間の 2 回目以降は出さず、60 秒たつとまた 1 回出す (抑えた回の fields は捨てる)', () => {
    warnThrottled('x402.discovery.read_failed', { id: 'a' });
    for (let i = 0; i < 60; i += 1) warnThrottled('x402.discovery.read_failed', { id: `b${i}` });
    at(59_999);
    warnThrottled('x402.discovery.read_failed', { id: 'c' });
    expect(warn).toHaveBeenCalledTimes(1);
    at(60_000);
    warnThrottled('x402.discovery.read_failed', { id: 'd' });
    expect(warn.mock.calls).toEqual([
      ['x402.discovery.read_failed', { id: 'a' }],
      ['x402.discovery.read_failed', { id: 'd' }],
    ]);
  });

  it('抑えた回では時刻を進めない: 60 秒より短い間隔で失敗が続いても、60 秒ごとに出る', () => {
    for (let s = 0; s <= 180; s += 30) {
      at(s * 1000);
      warnThrottled('x402.dualrail.accepts_failed', { s });
    }
    // 0・60・120・180 秒で出る (30・90・150 秒は抑える)。
    expect(warn.mock.calls).toEqual([0, 60, 120, 180].map((s) => ['x402.dualrail.accepts_failed', { s }]));
  });

  it('名前ごとに別に数える: ある名前の警告が、ほかの名前の最初の 1 回を消さない (3 つの名前とも)', () => {
    const emit = () => {
      warnThrottled('x402.discovery.read_failed', { id: 'res-1' });
      warnThrottled('x402.discovery.requirements_failed', { id: 'res-1', error: 'e' });
      warnThrottled('x402.dualrail.accepts_failed', { resourceId: 'res-1' });
    };
    emit();
    emit();
    expect(warn.mock.calls).toEqual([
      ['x402.discovery.read_failed', { id: 'res-1' }],
      ['x402.discovery.requirements_failed', { id: 'res-1', error: 'e' }],
      ['x402.dualrail.accepts_failed', { resourceId: 'res-1' }],
    ]);
  });
});
