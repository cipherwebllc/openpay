// ⚠️ このファイルは **Lua を実行しない**。vi.mock('@/lib/kv') の kvEval が CAS_*_REVERIFY の
// セマンティクスを TypeScript で再実装しているだけなので、Lua 文字列そのものの構文誤り・
// KEYS/ARGV のズレ・redis.call の綴り間違いはここでは捕まらない (本物の Redis / Upstash に当てて
// 初めて出る)。Lua を実際に走らせる runner (embedded Redis や lua vm の依存追加) を入れるかは
// plans/full-review-2026-09-02.md の「Lua-runner の判断」に記録してある — **依存は足さない**方針の
// 現状では、Lua を変えたら必ず script 文字列と本モックの両方を手で突き合わせること。
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
      | {
          failures?: number;
          authFailures?: number;
          lastRunId?: string;
          probedUrl?: string;
          lastOkAt?: string;
        }
      | undefined;
    if (verification?.lastRunId === args[2]) {
      return { ok: true as const, value: -4 };
    }
    const sameUrl = verification?.probedUrl === args[0];
    // B6: hidden は URL が変わっても引き継ぐ (same で絞らない)。
    const before = record.hidden === true;
    let failures = sameUrl ? verification?.failures ?? 0 : 0;
    let authFailures = sameUrl ? verification?.authFailures ?? 0 : 0;
    let hidden = before;
    let lastOkAt = sameUrl ? verification?.lastOkAt : undefined;
    if (args[3] === 'ok') {
      failures = 0;
      hidden = false;
      lastOkAt = args[1];
    } else if (args[3] === 'violation') {
      failures += 1;
      if (failures >= 3) hidden = true;
    }
    if (args[4] === 'clear') {
      authFailures = 0;
    } else if (args[4] === 'block') {
      authFailures += 1;
      if (authFailures >= 6) hidden = true;
    }
    record.hidden = hidden;
    record.verification = {
      ...(lastOkAt ? { lastOkAt } : {}),
      lastCheckedAt: args[1],
      failures,
      ...(authFailures > 0 ? { authFailures } : {}),
      lastRunId: args[2],
      probedUrl: args[0],
    };
    store.set(keys[0], JSON.stringify(record));
    // N-5: external の script だけが hidden URL 台帳 (KEYS[2]) を立てる。
    if (hidden && script.includes("redis.call('SET',KEYS[2]")) {
      store.set(keys[1], args[5]);
    }
    return {
      ok: true as const,
      value: JSON.stringify({ failures, authFailures, before, after: hidden }),
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
import { hiddenUrlLedgerKey } from '@/lib/x402/hiddenUrlLedger';

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

  // N-5: hidden にした瞬間に URL 台帳を立てる (delete → 同一 URL 再登録で洗い流させない)。
  // first-party (path) 側は再登録できないので台帳を書かない。
  it('hidden にした URL は台帳に載り、hidden でない間は載らない', async () => {
    seed({
      verification: {
        failures: 2,
        lastCheckedAt: 'old',
        lastRunId: '2026071323',
        probedUrl: URL,
      },
    });
    const ledgerKey = hiddenUrlLedgerKey(URL);

    await applyExternalReverify(
      'r1',
      URL,
      'transient',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(store.get(ledgerKey)).toBeUndefined();

    await applyExternalReverify(
      'r1',
      URL,
      'violation_gone',
      '2026-07-14T01:00:00.000Z',
      '2026071401',
    );
    expect(store.get(ledgerKey)).toBe('1');
  });

  it('first-party の hidden は URL 台帳を書かない', async () => {
    await applyFirstPartyReverify(
      '/api/paid/demo',
      'https://open-pay.jp/api/paid/demo',
      'violation_gone',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(
      [...store.keys()].filter((key) => key.startsWith('x402:hidden-url:')),
    ).toEqual([]);
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
      authFailures: 0,
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

  // B6: owner が URL を変えると verification (カウンタ) は消えるが hidden は残る。CAS は残った
  // hidden を出発点にし、transient/violation では解除しない — 復帰は ok の 1 経路のみ。
  it('URL 変更で verification が消えても hidden を引き継ぎ、成功だけが解除する', async () => {
    seed({ hidden: true }); // updateResource が verification を消し hidden を残した後の形

    const stillHidden = await applyExternalReverify(
      'r1',
      URL,
      'transient',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(stillHidden).toMatchObject({
      applied: true,
      failures: 0,
      hiddenBefore: true,
      hiddenAfter: true,
    });

    const restored = await applyExternalReverify(
      'r1',
      URL,
      'ok_402_openpay',
      '2026-07-14T01:00:00.000Z',
      '2026071401',
    );
    expect(restored).toMatchObject({ hiddenBefore: true, hiddenAfter: false });
  });

  // B8: 403 を返し続ける cloaking 出品は verdict が常に transient なので failures では捕まらない。
  // authFailures が 6 連続で hidden になり、素の 402 が 1 回入れば 0 に戻る。
  it('auth block 6 連続で hidden、素の 402 で counter がリセットされる', async () => {
    seed();
    for (let run = 1; run <= 5; run += 1) {
      const result = await applyExternalReverify(
        'r1',
        URL,
        'transient',
        `2026-07-14T0${run}:00:00.000Z`,
        `202607140${run}`,
        'block',
      );
      expect(result).toMatchObject({
        applied: true,
        failures: 0,
        authFailures: run,
        hiddenAfter: false,
      });
    }

    const cleared = await applyExternalReverify(
      'r1',
      URL,
      'ok_402_openpay',
      '2026-07-14T06:00:00.000Z',
      '2026071406',
      'clear',
    );
    expect(cleared).toMatchObject({ authFailures: 0, hiddenAfter: false });
    // 0 のときは書かない = 既存レコードと同じ JSON 形 (後方互換)。
    expect(
      (JSON.parse(store.get(resourceKey('r1'))!) as {
        verification: { authFailures?: number };
      }).verification.authFailures,
    ).toBeUndefined();

    for (let run = 1; run <= 5; run += 1) {
      await applyExternalReverify(
        'r1',
        URL,
        'transient',
        `2026-07-15T0${run}:00:00.000Z`,
        `202607150${run}`,
        'block',
      );
    }
    const hiddenByAuth = await applyExternalReverify(
      'r1',
      URL,
      'transient',
      '2026-07-15T06:00:00.000Z',
      '2026071506',
      'block',
    );
    expect(hiddenByAuth).toMatchObject({
      applied: true,
      failures: 0, // 契約違反は 1 度も観測していない
      authFailures: 6,
      hiddenBefore: false,
      hiddenAfter: true,
    });
  });

  // 5xx (neutral) は authFailures を動かさない = 一時障害で cloaking 扱いしない。
  it('5xx は authFailures を加算しない', async () => {
    seed();
    await applyExternalReverify(
      'r1',
      URL,
      'transient',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
      'block',
    );
    const neutral = await applyExternalReverify(
      'r1',
      URL,
      'transient',
      '2026-07-14T01:00:00.000Z',
      '2026071401',
      'neutral',
    );
    expect(neutral).toMatchObject({ authFailures: 1, hiddenAfter: false });
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
