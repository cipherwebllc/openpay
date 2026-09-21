import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agent/activityServer', () => ({ fetchAgentActivity: vi.fn() }));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { GET } from '@/app/api/agent/activity/route';
import { fetchAgentActivity } from '@/lib/agent/activityServer';
import type { AgentActivityFailure, AgentActivityResponse } from '@/lib/agent/activityTypes';
import { logger } from '@/lib/logger';
import { hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';

const ADDRESS = `0x${'a'.repeat(40)}`;
const EMPTY: AgentActivityResponse = {
  ok: true, chainId: 137, items: [], rawCount: 0, truncated: false, asOf: 1790000000,
};

function req(query = `address=${ADDRESS}`, ip: string | null = '203.0.113.10') {
  return new Request(`https://test.local/api/agent/activity?${query}`, {
    headers: ip === null ? {} : { 'x-forwarded-for': ip },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('IP_HASH_SECRET', 'agent-activity-test-secret-32-bytes-long');
  // route テストの mock 漏れが実 API 呼出しへ波及しないようネットワークを閉じる。
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected fetch')));
  vi.mocked(fetchAgentActivity).mockResolvedValue(EMPTY);
  vi.mocked(checkIpRateLimit).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET /api/agent/activity', () => {
  it('小文字 address を受理し、IP 制限後に取得・成功だけ public キャッシュ', async () => {
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(EMPTY);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=30, stale-while-revalidate=120');
    expect(checkIpRateLimit).toHaveBeenCalledWith('agent-activity', hashIp('203.0.113.10'), 20, 60);
    expect(fetchAgentActivity).toHaveBeenCalledWith(ADDRESS);
    expect(vi.mocked(checkIpRateLimit).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fetchAgentActivity).mock.invocationCallOrder[0]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('履歴ありの成功 DTO をそのまま返す', async () => {
    const body: AgentActivityResponse = {
      ...EMPTY,
      items: [{
        key: 'transfer-key', hash: `0x${'b'.repeat(64)}`, timestamp: 1790000000,
        direction: 'out', counterparty: `0x${'c'.repeat(40)}`,
        valueAtomic: '9'.repeat(78), viaOpenPay: false,
      }],
      rawCount: 50, truncated: true,
    };
    vi.mocked(fetchAgentActivity).mockResolvedValue(body);
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=30, stale-while-revalidate=120');
  });

  it.each([
    `address=0xA${'a'.repeat(39)}`,
    `address=${ADDRESS.toUpperCase()}`,
    `address=${ADDRESS.slice(2)}`,
    `address=${ADDRESS}&address=${ADDRESS}`,
    `address=${ADDRESS}&address=`,
    `address=${ADDRESS}&extra=1`,
    `extra=1&address=${ADDRESS}`,
    `address=${ADDRESS}&unused`,
    // URLSearchParams は空ペアを数えない (size 1 のまま) → 生の query 文字列で弾く。CDN のキャッシュキーを増やせない。
    `address=${ADDRESS}&`, `&address=${ADDRESS}`, `address=${ADDRESS}&&&`, `address=${ADDRESS}&=`,
    '', 'extra=1', 'address=', `Address=${ADDRESS}`,
    `address=${ADDRESS}0`, `address=${ADDRESS.slice(0, -1)}`,
    `address=${ADDRESS}%0A`, `address=%20${ADDRESS}`, `address=${ADDRESS}%20`,
    `address=0x${'g'.repeat(40)}`,
  ])('不正 query (%s) は IP 制限・取得の前に 400 + no-store', async (query) => {
    vi.mocked(checkIpRateLimit).mockResolvedValue(false);
    const response = await GET(req(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: 'invalid_address' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(checkIpRateLimit).not.toHaveBeenCalled();
    expect(fetchAgentActivity).not.toHaveBeenCalled();
  });

  it('IP 制限超過は 429 + no-store、上流を呼ばずログは ipPrefix だけ', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    vi.mocked(checkIpRateLimit).mockResolvedValue(false);
    const response = await GET(req());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, reason: 'rate_limited' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchAgentActivity).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('agent.activity.rate_limited', {
      ipPrefix: '203.0.113.0/24',
      window: 'minute',
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('203.0.113.10');
    // 分の上限で落ちたら日次のカウンタは消費しない。
    expect(checkIpRateLimit).toHaveBeenCalledTimes(1);
  });

  it('IP の日次上限 (300/日) 超過も 429 + no-store で上流を呼ばない', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000_000_000);
    vi.mocked(checkIpRateLimit).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const response = await GET(req());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, reason: 'rate_limited' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchAgentActivity).not.toHaveBeenCalled();
    expect(checkIpRateLimit).toHaveBeenNthCalledWith(2, 'agent-activity-day', hashIp('203.0.113.10'), 300, 86400);
    expect(logger.warn).toHaveBeenCalledWith('agent.activity.rate_limited', { ipPrefix: '203.0.113.0/24', window: 'day' });
  });

  it('拒否の warn はプロセス内で 1 分に 1 回だけ (攻撃者に Sentry のイベント量を決めさせない)', async () => {
    const now = vi.spyOn(Date, 'now');
    vi.mocked(checkIpRateLimit).mockResolvedValue(false);
    now.mockReturnValue(30_000_000_000);
    await GET(req());
    now.mockReturnValue(30_000_000_000 + 1_000);
    await GET(req());
    await GET(req());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    now.mockReturnValue(30_000_000_000 + 61_000);
    await GET(req());
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['invalid_address', 400], ['rate_limited', 429], ['busy', 429],
    ['not_configured', 503], ['unsupported_chain', 200], ['upstream', 502],
  ] satisfies [AgentActivityFailure, number][])(
    '%s は HTTP %i + no-store', async (reason, status) => {
      vi.mocked(fetchAgentActivity).mockResolvedValue({ ok: false, reason });
      const response = await GET(req());
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, reason });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it('IP 不明は共通 guard の fail-open に委ねる', async () => {
    const response = await GET(req(`address=${ADDRESS}`, null));
    expect(response.status).toBe(200);
    expect(checkIpRateLimit).toHaveBeenCalledWith('agent-activity', null, 20, 60);
  });
});
