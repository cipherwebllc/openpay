// @vitest-environment node
// このファイルは **本物の Lua を実行する**。vi.mock('@/lib/kv') の kvEval は
// tests/_helpers/redisLua.ts (wasmoon = C Lua 5.4) に script 文字列をそのまま渡すので、
// CAS_EXTERNAL_REVERIFY / CAS_FIRST_PARTY_REVERIFY の構文誤り・KEYS/ARGV のズレ・
// redis.call の綴り間違いはここで落ちる (以前は Lua を TypeScript で再実装していたため
// 実 Redis に当てるまで出なかった)。
// ⚠️ エミュレータであって Upstash 実機ではない。既知の差異は redisLua.ts の
// KNOWN DIVERGENCES を参照 — money-path の CAS は実機 smoke (掟 15) を省略しない。
// ⚠️ node 環境が必須 (wasmoon の WASM 初期化が jsdom では失敗する)。
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeRedisLuaEngine,
  createFakeRedisStore,
  runRedisLua,
  type FakeRedisStore,
} from '../../_helpers/redisLua';

// vi.mock の factory は import より前に巻き上がるので、store の実体は holder 越しに渡す
// (factory 本体が走るのは '@/lib/kv' が最初に import された時点 = 下の代入より後)。
const holder = vi.hoisted(() => ({ store: null as FakeRedisStore | null }));

vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => ({
    ok: true as const,
    value: holder.store!.strings.get(key) ?? null,
  }),
  kvLrange: async () => ({ ok: true as const, value: [] }),
  kvSet: async (key: string, value: string) => {
    holder.store!.strings.set(key, value);
    return { ok: true as const, value: 'OK' as const };
  },
  kvLpush: vi.fn(),
  // ここが本題: 受け取った script 文字列を **そのまま** Lua VM で実行する。
  kvEval: async (script: string, keys: string[], args: string[]) => ({
    ok: true as const,
    value: await runRedisLua(script, keys, args, holder.store!),
  }),
}));

import {
  applyExternalReverify,
  applyFirstPartyReverify,
  firstPartyVerificationKey,
  readExternalReverifyTarget,
  CAS_EXTERNAL_REVERIFY,
  CAS_FIRST_PARTY_REVERIFY,
  REVERIFY_COUNTER_TRANSITION,
  REVERIFY_HIDDEN_URL_LEDGER,
} from '@/lib/x402/reverify';
import { resourceKey } from '@/lib/x402/registry';
import { hiddenUrlLedgerKey } from '@/lib/x402/hiddenUrlLedger';

const URL = 'https://api.example.jp/paid';

let store: FakeRedisStore;

function seed(overrides: Record<string, unknown> = {}) {
  store.strings.set(
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

beforeEach(() => {
  store = createFakeRedisStore(1_700_000_000_000);
  holder.store = store;
});

afterAll(async () => {
  await closeRedisLuaEngine();
});

describe('CAS script の合成', () => {
  it('external / first-party とも共通のカウンタ遷移断片を含む', () => {
    expect(CAS_EXTERNAL_REVERIFY).toContain(REVERIFY_COUNTER_TRANSITION);
    expect(CAS_FIRST_PARTY_REVERIFY).toContain(REVERIFY_COUNTER_TRANSITION);
    // N-5 の URL 台帳は external 側にだけ足す。
    expect(CAS_EXTERNAL_REVERIFY).toContain(REVERIFY_HIDDEN_URL_LEDGER);
    expect(CAS_FIRST_PARTY_REVERIFY).not.toContain(REVERIFY_HIDDEN_URL_LEDGER);
  });

  it('CAS_FIRST_PARTY_REVERIFY を直接実行しても state を作る', async () => {
    const key = firstPartyVerificationKey('/api/paid/demo');
    const result = await runRedisLua(
      CAS_FIRST_PARTY_REVERIFY,
      [key],
      ['https://open-pay.jp/api/paid/demo', '2026-07-14T00:00:00.000Z', 'run1', 'violation', 'neutral'],
      store,
    );
    expect(JSON.parse(result as string)).toMatchObject({ failures: 1, after: false });
    expect(JSON.parse(store.strings.get(key)!)).toMatchObject({
      hidden: false,
      verification: { failures: 1, lastRunId: 'run1' },
    });
  });
});

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
    expect(JSON.parse(store.strings.get(resourceKey('r1'))!)).not.toHaveProperty(
      'verification',
    );
  });

  it('未存在 record は not_found・壊れた JSON は malformed', async () => {
    expect(
      await applyExternalReverify('missing', URL, 'violation_gone', 'now', 'run1'),
    ).toEqual({ applied: false, reason: 'not_found' });

    store.strings.set(resourceKey('r1'), '{broken');
    expect(await applyExternalReverify('r1', URL, 'violation_gone', 'now', 'run1')).toEqual({
      applied: false,
      reason: 'malformed',
    });
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
    expect(store.strings.get(ledgerKey)).toBeUndefined();

    await applyExternalReverify(
      'r1',
      URL,
      'violation_gone',
      '2026-07-14T01:00:00.000Z',
      '2026071401',
    );
    expect(store.strings.get(ledgerKey)).toBe('1');
    // 台帳は TTL つき (30 日) — Lua の SET ... 'EX' が効いていることを実測する。
    expect(store.getTtl(ledgerKey)).toBe(30 * 24 * 60 * 60);
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
      store.keys().filter((key) => key.startsWith('x402:hidden-url:')),
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
    expect(JSON.parse(store.strings.get(resourceKey('r1'))!)).not.toHaveProperty(
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
      (JSON.parse(store.strings.get(resourceKey('r1'))!) as { verification: { failures: number } })
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
      (JSON.parse(store.strings.get(resourceKey('r1'))!) as {
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

  // Lua は `tonumber(o.verification.failures) or 0` でカウンタを読む。旧 JS 模倣は
  // `verification.failures ?? 0` のまま加算していたので、値が文字列で保存されていた場合に
  // '2'+1='21' の文字列連結になり、本物の Lua (=3) と食い違っていた。
  it('failures が文字列で保存されていても tonumber で数値として加算する', async () => {
    seed({
      verification: {
        failures: '2',
        lastCheckedAt: 'old',
        lastRunId: '2026071323',
        probedUrl: URL,
      },
    });
    const result = await applyExternalReverify(
      'r1',
      URL,
      'violation_gone',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(result).toMatchObject({ applied: true, failures: 3, hiddenAfter: true });
  });

  // 壊れたカウンタ (数値化できない値) は 0 起点に倒れる (`or 0`)。
  it('failures が数値化できない値なら 0 起点で数え直す', async () => {
    seed({
      verification: {
        failures: 'oops',
        lastCheckedAt: 'old',
        lastRunId: '2026071323',
        probedUrl: URL,
      },
    });
    const result = await applyExternalReverify(
      'r1',
      URL,
      'violation_gone',
      '2026-07-14T00:00:00.000Z',
      '2026071400',
    );
    expect(result).toMatchObject({ applied: true, failures: 1, hiddenAfter: false });
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
    expect(JSON.parse(store.strings.get(firstPartyVerificationKey(path))!)).toMatchObject({
      hidden: false,
      verification: { failures: 0, lastOkAt: '2026-07-14T03:00:00.000Z' },
    });
  });

  it('壊れた JSON は malformed (external と同じ -2)', async () => {
    const path = '/api/paid/demo';
    store.strings.set(firstPartyVerificationKey(path), 'not json');
    expect(
      await applyFirstPartyReverify(
        path,
        'https://open-pay.jp/api/paid/demo',
        'violation_gone',
        'now',
        'run1',
      ),
    ).toEqual({ applied: false, reason: 'malformed' });
  });
});
