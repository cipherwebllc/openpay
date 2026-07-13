import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({
    ok: true as const,
    value: store.get(key) ?? null,
  }),
  kvLrange: async () => ({ ok: true as const, value: [] }),
  kvSet: async (key: string, value: string) => {
    store.set(key, value);
    return { ok: true as const, value: 'OK' as const };
  },
  kvLpush: vi.fn(),
  kvEval: async (script: string, keys: string[], args: string[]) => {
    const external = script.includes("o.active~=true");
    const raw = store.get(keys[0]);
    if (!raw && external) return { ok: true as const, value: -1 };
    let record: Record<string, unknown> = {};
    try {
      if (raw) record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: true as const, value: -2 };
    }
    if (external) {
      if (record.active !== true) return { ok: true as const, value: 0 };
      if (record.url !== args[0]) return { ok: true as const, value: -3 };
    }
    const verification = record.verification as
      | { failures?: number; lastRunId?: string; probedUrl?: string; lastOkAt?: string }
      | undefined;
    if (verification?.lastRunId === args[2]) {
      return { ok: true as const, value: -4 };
    }
    const sameUrl = verification?.probedUrl === args[0];
    const before = sameUrl && record.hidden === true;
    let failures = sameUrl ? verification?.failures ?? 0 : 0;
    let hidden = before;
    let lastOkAt = sameUrl ? verification?.lastOkAt : undefined;
    if (args[3] === 'ok') {
      failures = 0;
      hidden = false;
      lastOkAt = args[1];
    } else if (args[3] === 'violation') {
      failures += 1;
      hidden = failures >= 3;
    }
    record.hidden = hidden;
    record.verification = {
      ...(lastOkAt ? { lastOkAt } : {}),
      lastCheckedAt: args[1],
      failures,
      lastRunId: args[2],
      probedUrl: args[0],
    };
    store.set(keys[0], JSON.stringify(record));
    return {
      ok: true as const,
      value: JSON.stringify({ failures, before, after: hidden }),
    };
  },
}));

import {
  applyExternalReverify,
  applyFirstPartyReverify,
  firstPartyVerificationKey,
  readExternalReverifyTarget,
} from '@/lib/x402/reverify';
import { resourceKey } from '@/lib/x402/registry';

const URL = 'https://api.example.jp/paid';

function seed(overrides: Record<string, unknown> = {}) {
  store.set(
    resourceKey('r1'),
    JSON.stringify({
      id: 'r1',
      merchant: '0x1111111111111111111111111111111111111111',
      url: URL,
      description: 'paid API',
      priceJpyc: '1',
      category: 'api',
      payTo: '0x1111111111111111111111111111111111111111',
      network: 'eip155:80002',
      active: true,
      createdAt: 1,
      ...overrides,
    }),
  );
}

beforeEach(() => store.clear());

describe('external reverify CAS', () => {
  it('probe 後に DELETE された record へは書かない', async () => {
    seed();
    const target = await readExternalReverifyTarget('r1');
    expect(target.ok && target.resource?.url).toBe(URL);
    seed({ active: false });

    const result = await applyExternalReverify(
      'r1',
      URL,
      'violation_gone',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(result).toEqual({ applied: false, reason: 'inactive' });
    expect(JSON.parse(store.get(resourceKey('r1'))!)).not.toHaveProperty(
      'verification',
    );
  });

  it('probe 後に URL が変わった record へは旧 URL の結果を書かない', async () => {
    seed({ url: 'https://new.example.jp/paid' });
    const result = await applyExternalReverify(
      'r1',
      URL,
      'violation_gone',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(result).toEqual({ applied: false, reason: 'url_changed' });
    expect(JSON.parse(store.get(resourceKey('r1'))!)).not.toHaveProperty(
      'verification',
    );
  });

  it('同じ lastRunId は冪等、別 run の3回目違反で hidden、成功で復帰', async () => {
    seed({
      verification: {
        failures: 2,
        lastCheckedAt: 'old',
        lastRunId: '2026071323',
        probedUrl: URL,
      },
      hidden: false,
    });
    const hidden = await applyExternalReverify(
      'r1',
      URL,
      'violation_foreign_402',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(hidden).toEqual({
      applied: true,
      failures: 3,
      hiddenBefore: false,
      hiddenAfter: true,
    });

    const duplicate = await applyExternalReverify(
      'r1',
      URL,
      'violation_gone',
      '2026-07-14T00:30:00.000Z',
      '2026071400',
    );
    expect(duplicate).toEqual({ applied: false, reason: 'duplicate' });
    expect(
      (JSON.parse(store.get(resourceKey('r1'))!) as { verification: { failures: number } })
        .verification.failures,
    ).toBe(3);

    const restored = await applyExternalReverify(
      'r1',
      URL,
      'ok_402_openpay',
      '2026-07-14T01:00:00.000Z',
      '2026071401',
    );
    expect(restored).toMatchObject({
      applied: true,
      failures: 0,
      hiddenBefore: true,
      hiddenAfter: false,
    });
  });
});

describe('first-party reverify CAS', () => {
  it('初回 violation から state を作り、同じ run は冪等、3回で hidden・成功で復帰', async () => {
    const path = '/api/paid/demo';
    const url = 'https://open-pay.jp/api/paid/demo';
    const first = await applyFirstPartyReverify(
      path,
      url,
      'violation_200_ungated',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(first).toMatchObject({
      applied: true,
      failures: 1,
      hiddenAfter: false,
    });
    expect(
      await applyFirstPartyReverify(
        path,
        url,
        'violation_gone',
        '2026-07-14T00:30:00.000Z',
        '2026071400',
      ),
    ).toEqual({ applied: false, reason: 'duplicate' });
    await applyFirstPartyReverify(
      path,
      url,
      'violation_gone',
      '2026-07-14T01:00:00.000Z',
      '2026071401',
    );
    const hidden = await applyFirstPartyReverify(
      path,
      url,
      'violation_foreign_402',
      '2026-07-14T02:00:00.000Z',
      '2026071402',
    );
    expect(hidden).toMatchObject({ failures: 3, hiddenAfter: true });

    const restored = await applyFirstPartyReverify(
      path,
      url,
      'ok_402_openpay',
      '2026-07-14T03:00:00.000Z',
      '2026071403',
    );
    expect(restored).toMatchObject({
      failures: 0,
      hiddenBefore: true,
      hiddenAfter: false,
    });
    expect(JSON.parse(store.get(firstPartyVerificationKey(path))!)).toMatchObject({
      hidden: false,
      verification: { failures: 0, lastOkAt: '2026-07-14T03:00:00.000Z' },
    });
  });
});
