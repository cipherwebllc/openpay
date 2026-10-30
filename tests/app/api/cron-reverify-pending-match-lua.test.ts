// @vitest-environment node
// E-3: 最初の再検証を待つ新規掲載 (pendingFirstVerification) が公開に進むのは、402 が登録と同じ照合を通ったときだけ。
// 本物の route・本物の probe の解釈・本物の照合・本物の Lua (CAS_EXTERNAL_REVERIFY / CAS_UPDATE) で確かめる。差し替える
// のは KV の土台 (wasmoon のエミュレータ)・SSRF-safe fetch (402 を返す相手)・lock と cursor だけ。
// あわせて、公開中・モデレーションの hidden (印なし) の掲載は同じ 402 で従来どおりの verdict になること (範囲の固定) と、
// probe の間の payTo だけの編集で、照合した結果を捨てること (CAS の受取先の検査) を見る。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';
import type { ReverifyCursor } from '@/lib/x402/reverify';

type Fetched = { res: Response | null };
const holder = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  cursor: { offset: 0 } as ReverifyCursor,
  fetch: null as unknown as (url: string) => Promise<Fetched>,
  warn: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({
  kvEndpointInfo: () => ({ host: null, source: null }),
  kvGet: async (key: string) => ({ ok: true, value: holder.store!.strings.get(key) ?? null }),
  kvLrange: async (key: string, start: number, stop: number) => ({
    ok: true,
    value: (holder.store!.lists.get(key) ?? []).slice(start, stop + 1),
  }),
  kvEval: async (script: string, keys: string[], args: string[]) => ({
    ok: true, value: await runRedisLua(script, keys, args, holder.store!),
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: holder.warn, error: vi.fn() } }));
vi.mock('@/lib/x402/firstParty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/firstParty')>()), FIRST_PARTY_RESOURCES: [],
}));
// probe の取得だけを差し替える (verdict の解釈と照合は本物)。
vi.mock('@/lib/x402/moderation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/moderation')>()),
  fetchSsrfSafeDetailed: (url: string) => holder.fetch(url),
}));
vi.mock('@/lib/x402/reverify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/reverify')>()),
  acquireReverifyLock: async () => 'acquired',
  releaseReverifyLock: async () => {},
  readReverifyCursor: async () => holder.cursor,
  writeReverifyCursor: async (cursor: ReverifyCursor) => { holder.cursor = cursor; return true; },
}));

import { applyExternalReverify, utcDateId } from '@/lib/x402/reverify';
import { listActiveResources, RESOURCES_INDEX, resourceKey, updateResource } from '@/lib/x402/registry';
import { registrationAcceptExpectation } from '@/lib/x402/registrationGateMatch';
import { hiddenUrlLedgerKey } from '@/lib/x402/hiddenUrlLedger';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';
import { GET } from '@/app/api/cron/reverify/route';

const URL = 'https://seller.example/api/paid';
const SELLER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x9999999999999999999999999999999999999999';
const PENDING = { hidden: true, pendingFirstVerification: true } as const;

// 受取先 merchant の OpenPay の JPYC accept (登録と同じ期待値の chain・JPYC・forwarder。設定に無い項目は書かない)。
function openpayAccept(merchant: string) {
  const e = registrationAcceptExpectation(merchant);
  return {
    scheme: 'exact',
    network: e.network,
    ...(e.asset ? { asset: e.asset } : {}),
    ...(e.forwarder ? { payTo: e.forwarder } : {}),
    resource: URL,
    extra: { openpay: { mode: 'forwarder-split', merchant, ...(e.forwarder ? { forwarder: e.forwarder } : {}) } },
  };
}
function gate402(merchant: string): Fetched {
  return {
    res: new Response(JSON.stringify({ x402Version: 1, accepts: [openpayAccept(merchant)] }), {
      status: 402, headers: { 'content-type': 'application/json' },
    }),
  };
}

function seed(overrides: Record<string, unknown> = {}) {
  holder.store!.strings.set(resourceKey('a'), JSON.stringify({
    id: 'a', merchant: SELLER, url: URL, description: 'paid', priceJpyc: '1', category: 'api',
    payTo: SELLER, network: registrationAcceptExpectation(SELLER).network, active: true, createdAt: 1, updatedAt: 1,
    ...overrides,
  }));
  holder.store!.lists.set(RESOURCES_INDEX, ['a']);
  holder.store!.strings.set(resourceUrlClaimKey(URL), 'a');
}
const stored = () => JSON.parse(holder.store!.strings.get(resourceKey('a'))!) as Record<string, unknown>;
const ledgerKeys = () => holder.store!.keys().filter((key) => key.startsWith('x402:hidden-url:'));
const publicIds = async () => (await listActiveResources())!.map((resource) => resource.id);
const request = () => new Request('https://open-pay.jp/api/cron/reverify', { headers: { authorization: 'Bearer test' } });
// 毎時の再検証 1 回 (runId は時刻から作られる)。
async function runAt(iso: string) {
  vi.setSystemTime(new Date(iso));
  holder.cursor = { offset: 0, directoryDate: utcDateId(new Date(iso)) };
  const response = await GET(request());
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, number>;
}
// 出品者の PATCH (本物の updateResource = CAS_UPDATE)。URL はそのまま。
async function patch(fields: { payTo?: string; description?: string }) {
  const updated = await updateResource('a', SELLER, {
    merchant: SELLER, url: URL, description: fields.description ?? 'paid', priceJpyc: '1', category: 'api',
    payTo: fields.payTo ?? SELLER,
  });
  expect(updated.ok).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  holder.store = createFakeRedisStore();
  holder.warn.mockClear();
  vi.stubEnv('CRON_SECRET', 'test');
  vi.stubEnv('ALERT_WEBHOOK_URL', '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(closeRedisLuaEngine);

describe('最初の再検証を待つ新規掲載 (pending) の照合', () => {
  it('掲載の受取先の 402 なら公開に進む (hidden と印が外れる)', async () => {
    seed(PENDING);
    holder.fetch = async () => gate402(SELLER);
    expect(await runAt('2026-10-30T10:00:00.000Z')).toMatchObject({ checked: 1, ok: 1, restored: 1 });
    expect(stored()).toMatchObject({ hidden: false, verification: { failures: 0, lastOkAt: '2026-10-30T10:00:00.000Z' } });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');
    expect(await publicIds()).toEqual(['a']);
    expect(holder.warn).not.toHaveBeenCalledWith('x402.reverify.pending_gate_mismatch', expect.anything());
  });

  it('他人の受取先の 402 では hidden と印のまま・確定違反のカウンタ (failures) も URL 台帳も動かさず、照合の不一致を warn に残す', async () => {
    seed(PENDING);
    holder.fetch = async () => gate402(OTHER);
    expect(await runAt('2026-10-30T10:00:00.000Z')).toMatchObject({ checked: 1, ok: 0, violations: 0, transient: 1, restored: 0 });
    expect(stored()).toMatchObject({ ...PENDING, verification: { failures: 0, lastRunId: '2026103010' } });
    expect(stored().verification).not.toHaveProperty('lastOkAt');
    expect(ledgerKeys()).toEqual([]);
    expect(await publicIds()).toEqual([]);
    expect(holder.warn).toHaveBeenCalledWith('x402.reverify.pending_gate_mismatch', {
      runId: '2026103010', target: 'external:a', mismatch: 'payTo',
    });
  });

  // 違反に数えると 3 回目で印が外れて通常のモデレーションの hidden になり、その復帰 (照合しない) で 4 回目に公開される。
  it('合わない 402 が何時間続いても公開されず、印も外れない (違反に数えない)', async () => {
    seed(PENDING);
    holder.fetch = async () => gate402(OTHER);
    for (let hour = 10; hour <= 15; hour += 1) {
      await runAt(`2026-10-30T${hour}:00:00.000Z`);
      expect(stored()).toMatchObject({ ...PENDING, verification: { failures: 0 } });
    }
    expect(ledgerKeys()).toEqual([]);
    expect(await publicIds()).toEqual([]);

    // ゲートを直せば次の確認で公開に進む。
    holder.fetch = async () => gate402(SELLER);
    expect(await runAt('2026-10-30T16:00:00.000Z')).toMatchObject({ ok: 1, restored: 1 });
    expect(await publicIds()).toEqual(['a']);
  });

  it('合わない 402 の間に確定違反 (404) があれば、従来どおり違反に数える (照合はそれを打ち消さない)', async () => {
    seed(PENDING);
    holder.fetch = async () => ({ res: new Response('', { status: 404 }) });
    await runAt('2026-10-30T10:00:00.000Z');
    holder.fetch = async () => gate402(OTHER);
    await runAt('2026-10-30T11:00:00.000Z');
    expect(stored()).toMatchObject({ ...PENDING, verification: { failures: 1 } });
  });

  // 締め出しのカウンタ (authFailures) は、ほかの 402 と同じく素の 402 に届いた回 (clear) で 0 に戻す。確定違反の
  // カウンタ (failures) は動かさない (lib/x402/reverify.ts probeForPendingFirstVerification の注釈)。
  it('合わない 402 は failures を残し、authFailures を 0 に戻す (0 は書かない)', async () => {
    seed({ ...PENDING, verification: { failures: 2, authFailures: 5, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: URL } });
    holder.fetch = async () => gate402(OTHER);
    await runAt('2026-10-30T10:00:00.000Z');
    expect(stored()).toMatchObject({ ...PENDING, verification: { failures: 2, lastRunId: '2026103010' } });
    expect(stored().verification).not.toHaveProperty('authFailures');
    expect(ledgerKeys()).toEqual([]);
  });

  // 残すと 403 と合わない 402 が交互に来るだけで 6 回に積み上がり、閾値で印が外れて照合しない復帰に落ちる。
  it('403 が 5 回続いた後の合わない 402 で締め出しの列は切れ、次の 403 は 1 回目から数え直す (印は外れない)', async () => {
    seed(PENDING);
    holder.fetch = async () => ({ res: new Response('', { status: 403 }) });
    for (let hour = 10; hour <= 14; hour += 1) await runAt(`2026-10-30T${hour}:00:00.000Z`);
    expect(stored()).toMatchObject({ ...PENDING, verification: { authFailures: 5 } });
    holder.fetch = async () => gate402(OTHER);
    await runAt('2026-10-30T15:00:00.000Z');
    holder.fetch = async () => ({ res: new Response('', { status: 403 }) });
    await runAt('2026-10-30T16:00:00.000Z');
    expect(stored()).toMatchObject({ ...PENDING, verification: { failures: 0, authFailures: 1 } });
    expect(ledgerKeys()).toEqual([]);
  });
});

describe('probe の間の payTo の編集 (CAS の受取先の検査)', () => {
  it('pending: probe の間に payTo だけを PATCH したら、古い受取先で照合した ok を捨てる (hidden と印のまま)', async () => {
    seed(PENDING);
    holder.fetch = async () => {
      await patch({ payTo: OTHER }); // probe の途中 (402 が返る前) に出品者が受取先を変える
      return gate402(SELLER);
    };
    expect(await runAt('2026-10-30T10:00:00.000Z')).toMatchObject({ checked: 1, restored: 0 });
    expect(stored()).toMatchObject({ ...PENDING, payTo: OTHER });
    expect(stored()).not.toHaveProperty('verification');
    expect(await publicIds()).toEqual([]);

    // 次の確認は新しい受取先で照合する (古い受取先の 402 では公開しない)。
    holder.fetch = async () => gate402(SELLER);
    await runAt('2026-10-30T11:00:00.000Z');
    expect(stored()).toMatchObject(PENDING);
    holder.fetch = async () => gate402(OTHER);
    await runAt('2026-10-30T12:00:00.000Z');
    expect(stored()).toMatchObject({ hidden: false, payTo: OTHER });
    expect(await publicIds()).toEqual(['a']);
  });

  it('pending: 受取先を変えない PATCH (説明だけ) なら結果を捨てない', async () => {
    seed(PENDING);
    holder.fetch = async () => {
      await patch({ description: 'paid report v2' });
      return gate402(SELLER);
    };
    expect(await runAt('2026-10-30T10:00:00.000Z')).toMatchObject({ ok: 1, restored: 1 });
    expect(stored()).toMatchObject({ hidden: false, description: 'paid report v2' });
  });

  it('CAS: 照合した受取先と違えば pay_to_changed (record に書かない)・同じなら適用・照合なしは確かめない', async () => {
    seed({ ...PENDING, payTo: OTHER });
    expect(await applyExternalReverify('a', URL, 'ok_402_openpay', 't1', 'run1', 'clear', SELLER))
      .toEqual({ applied: false, reason: 'pay_to_changed' });
    expect(stored()).not.toHaveProperty('verification');
    expect(stored()).toMatchObject(PENDING);

    expect(await applyExternalReverify('a', URL, 'transient', 't2', 'run2', 'neutral', OTHER))
      .toMatchObject({ applied: true, hiddenAfter: true });
    // 照合しなかった probe (matchedPayTo を渡さない) は従来どおり payTo を確かめない。
    expect(await applyExternalReverify('a', URL, 'transient', 't3', 'run3', 'neutral'))
      .toMatchObject({ applied: true });
  });
});

// 範囲の固定: 公開中の掲載・モデレーションの hidden (印なし) の verdict は変えない (照合しない・CAS も payTo を見ない)。
describe('印のない掲載は従来どおり', () => {
  it('公開中の掲載は、他人の受取先の 402 でも ok (カウンタが戻り、公開のまま・warn なし)', async () => {
    seed({ hidden: false, verification: { failures: 2, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: URL } });
    holder.fetch = async () => gate402(OTHER);
    expect(await runAt('2026-10-30T10:00:00.000Z')).toMatchObject({ checked: 1, ok: 1, violations: 0, transient: 0 });
    expect(stored()).toMatchObject({ hidden: false, verification: { failures: 0, lastOkAt: '2026-10-30T10:00:00.000Z' } });
    expect(await publicIds()).toEqual(['a']);
    expect(holder.warn).not.toHaveBeenCalledWith('x402.reverify.pending_gate_mismatch', expect.anything());
  });

  it('公開中の掲載は、probe の間に payTo を PATCH しても結果を捨てない', async () => {
    seed({ hidden: false, verification: { failures: 2, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: URL } });
    holder.fetch = async () => {
      await patch({ payTo: OTHER });
      return gate402(SELLER);
    };
    await runAt('2026-10-30T10:00:00.000Z');
    expect(stored()).toMatchObject({ hidden: false, payTo: OTHER, verification: { failures: 0, lastRunId: '2026103010' } });
  });

  it('モデレーションの hidden (印なし) は、他人の受取先の 402 でも従来どおり ok で戻る', async () => {
    seed({ hidden: true, verification: { failures: 3, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: URL } });
    holder.fetch = async () => gate402(OTHER);
    expect(await runAt('2026-10-30T10:00:00.000Z')).toMatchObject({ ok: 1, restored: 1 });
    expect(stored()).toMatchObject({ hidden: false });
    expect(await publicIds()).toEqual(['a']);
    expect(ledgerKeys()).toEqual([]);
  });
});
