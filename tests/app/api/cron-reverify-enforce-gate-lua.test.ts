// @vitest-environment node
// 再検証の照合の強制 (E-3 の残り・2026-10-30 user 裁定 (b) の「強制」の段)。外部の掲載はどの状態でも、402 が登録と同じ照合
// (lib/x402/registrationGateMatch.ts・掲載の payTo が期待値) を通ったときだけ ok になることを、本物の route・本物の probe の
// 解釈・本物の照合・本物の Lua (CAS_EXTERNAL_REVERIFY / CAS_UPDATE / CAS_CREATE) で確かめる。
//   公開中               = 合わない 402 は確定違反 (violation_gate_mismatch)。3 回続くと hidden
//   モデレーションの hidden = 合わない 402 では戻らない (確定違反に数え、hidden のまま)・合う 402 で戻る
//   公開待ち             = #957 のまま (pending_gate_mismatch・違反に数えない)
//   first-party          = 照合しない (従来どおり)
// あわせて、probe の間の payTo の編集で結果を捨てること (CAS の受取先の検査が公開中・hidden にも効く) と、#957 の「残る穴」
// 1〜3 (印のない hidden の照合しない復帰) が閉じたことを見る。差し替えるのは KV の土台 (wasmoon のエミュレータ)・
// SSRF-safe fetch (402 を返す相手)・lock と cursor・alert の fetch だけ。
// 末尾の describe は、掲載の見え方が変わった回 (hidden になった・戻った・公開待ちが公開に進んだ) だけに出る warn
// (x402.reverify.visibility_changed) を、照合の有無を問わず (404/410・締め出し・first-party も) 同じ土台で見る。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';
import type { ReverifyCursor } from '@/lib/x402/reverify';

type Fetched = { res: Response | null };
type EvalCall = { script: string; keys: string[]; args: string[] };
const holder = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  cursor: { offset: 0 } as ReverifyCursor,
  respond: null as unknown as (url: string) => Promise<Fetched>,
  evals: [] as EvalCall[],
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({
  kvEndpointInfo: () => ({ host: null, source: null }),
  kvGet: async (key: string) => ({ ok: true, value: holder.store!.strings.get(key) ?? null }),
  kvLrange: async (key: string, start: number, stop: number) => ({
    ok: true,
    value: (holder.store!.lists.get(key) ?? []).slice(start, stop + 1),
  }),
  kvEval: async (script: string, keys: string[], args: string[]) => {
    holder.evals.push({ script, keys: [...keys], args: [...args] });
    return { ok: true, value: await runRedisLua(script, keys, args, holder.store!) };
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: holder.info, warn: holder.warn, error: vi.fn() } }));
// first-party は本物の 1 件 (/api/paid/demo) を毎回の batch に残す = 照合しないことを毎回の run で見る。
vi.mock('@/lib/x402/firstParty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/x402/firstParty')>();
  return { ...actual, FIRST_PARTY_RESOURCES: actual.FIRST_PARTY_RESOURCES.slice(0, 1) };
});
// probe の取得だけを差し替える (verdict の解釈と照合は本物)。
vi.mock('@/lib/x402/moderation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/moderation')>()),
  fetchSsrfSafeDetailed: (url: string) => holder.respond(url),
}));
vi.mock('@/lib/x402/reverify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/reverify')>()),
  acquireReverifyLock: async () => 'acquired',
  releaseReverifyLock: async () => {},
  readReverifyCursor: async () => holder.cursor,
  writeReverifyCursor: async (cursor: ReverifyCursor) => { holder.cursor = cursor; return true; },
}));

import { FIRST_PARTY_RESOURCES, firstPartyResourceUrl } from '@/lib/x402/firstParty';
import {
  firstPartyVerificationKey, REVERIFY_AUTH_HIDE_THRESHOLD, REVERIFY_HIDE_THRESHOLD, utcDateId,
} from '@/lib/x402/reverify';
import {
  createResource, listActiveResources, RESOURCES_INDEX, resourceKey, updateResource,
} from '@/lib/x402/registry';
import { registrationAcceptExpectation } from '@/lib/x402/registrationGateMatch';
import { HIDDEN_URL_LEDGER_TTL_SEC, hiddenUrlLedgerKey } from '@/lib/x402/hiddenUrlLedger';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';
import { GET } from '@/app/api/cron/reverify/route';

const SELLER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x9999999999999999999999999999999999999999';
const NETWORK = registrationAcceptExpectation(SELLER).network;
const FP_URL = firstPartyResourceUrl(FIRST_PARTY_RESOURCES[0]);
const urlOf = (id: string) => `https://${id}.seller.example/api/paid`;
const ENFORCE_EVENT = 'x402.reverify.gate_mismatch';
const PENDING_EVENT = 'x402.reverify.pending_gate_mismatch';
const VISIBILITY_EVENT = 'x402.reverify.visibility_changed';
const hourIso = (hour: number) => `2026-11-06T${String(hour).padStart(2, '0')}:00:00.000Z`;
const runIdOf = (hour: number) => `20261106${String(hour).padStart(2, '0')}`;

// 受取先 merchant の OpenPay の JPYC accept (登録と同じ期待値の chain・JPYC・forwarder。設定に無い項目は書かない)。
function openpayAccept(merchant: string, network = NETWORK) {
  const e = registrationAcceptExpectation(merchant);
  return {
    scheme: 'exact',
    network,
    ...(e.asset ? { asset: e.asset } : {}),
    ...(e.forwarder ? { payTo: e.forwarder } : {}),
    extra: { openpay: { mode: 'forwarder-split', merchant, ...(e.forwarder ? { forwarder: e.forwarder } : {}) } },
  };
}
const json402 = (body: unknown): Fetched => ({
  res: new Response(JSON.stringify(body), { status: 402, headers: { 'content-type': 'application/json' } }),
});
const gate402 = (merchant: string, network?: string) =>
  async () => json402({ x402Version: 1, accepts: [openpayAccept(merchant, network)] });
const status = (code: number) => async (): Promise<Fetched> => ({ res: new Response('', { status: code }) });

const VISIBLE = { hidden: false, verification: { failures: 0, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: '' } };
const MODERATED = { hidden: true, verification: { failures: 3, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: '' } };
const PENDING = { hidden: true, pendingFirstVerification: true };

type Listing = { id: string; record: Record<string, unknown>; respond: () => Promise<Fetched> };
function seed(listings: readonly Listing[]) {
  for (const listing of listings) {
    const url = urlOf(listing.id);
    const verification = listing.record.verification as Record<string, unknown> | undefined;
    holder.store!.strings.set(resourceKey(listing.id), JSON.stringify({
      id: listing.id, merchant: SELLER, url, description: 'paid', priceJpyc: '1', category: 'api',
      payTo: SELLER, network: NETWORK, active: true, createdAt: 1, updatedAt: 1,
      ...listing.record,
      ...(verification ? { verification: { ...verification, probedUrl: url } } : {}),
    }));
    holder.store!.strings.set(resourceUrlClaimKey(url), listing.id);
  }
  holder.store!.lists.set(RESOURCES_INDEX, listings.map((listing) => listing.id));
  const byUrl = new Map(listings.map((listing) => [urlOf(listing.id), listing.respond]));
  respondExternal((url) => byUrl.get(url)!());
}
// first-party (/api/paid/demo) には毎回、他人の受取先の 402 を返す (照合しないので ok のまま)。
function respondExternal(external: (url: string) => Promise<Fetched>) {
  holder.respond = (url) => (url === FP_URL ? gate402(OTHER)() : external(url));
}

const stored = (id = 'a') => JSON.parse(holder.store!.strings.get(resourceKey(id))!) as Record<string, unknown>;
const publicIds = async () => (await listActiveResources())!.map((resource) => resource.id);
const externalCasArgs = (result: { evals: EvalCall[] }, id = 'a') =>
  result.evals.filter((call) => call.keys[0] === resourceKey(id)).map((call) => call.args);

// 毎時の再検証 1 回 (runId は時刻から作られる)。
async function runAt(hour: number) {
  holder.evals = [];
  holder.warn.mockClear();
  holder.info.mockClear();
  vi.setSystemTime(new Date(hourIso(hour)));
  holder.cursor = { offset: 0, directoryDate: utcDateId(new Date(hourIso(hour))) };
  const webhook = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('ok'));
  vi.stubGlobal('fetch', webhook);
  const response = await GET(new Request('https://open-pay.jp/api/cron/reverify', {
    headers: { authorization: 'Bearer test' },
  }));
  expect(response.status).toBe(200);
  const warns = holder.warn.mock.calls as Array<[string, Record<string, unknown>]>;
  return {
    body: (await response.json()) as Record<string, unknown>,
    evals: holder.evals,
    warns,
    enforceWarns: warns.filter(([event]) => event === ENFORCE_EVENT).map(([, fields]) => fields),
    visibilityWarns: warns.filter(([event]) => event === VISIBILITY_EVENT).map(([, fields]) => fields),
    infos: holder.info.mock.calls as Array<[string, Record<string, unknown>]>,
    alerts: webhook.mock.calls.map(([, init]) => String(init?.body ?? '')),
  };
}

// 出品者の PATCH (本物の updateResource = CAS_UPDATE)。指定しない項目は今の値のまま。
async function patch(id: string, fields: { payTo?: string; description?: string; url?: string }) {
  const current = stored(id);
  const updated = await updateResource(id, SELLER, {
    merchant: SELLER,
    url: fields.url ?? (current.url as string),
    description: fields.description ?? (current.description as string),
    priceJpyc: '1',
    category: 'api',
    payTo: fields.payTo ?? (current.payTo as string),
  });
  expect(updated.ok).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  holder.store = createFakeRedisStore();
  vi.stubEnv('CRON_SECRET', 'test');
  vi.stubEnv('ALERT_WEBHOOK_URL', 'https://hooks.test/reverify');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('公開中の掲載', () => {
  it('他人の受取先の 402 は確定違反に数える (公開のまま 1 回目・CAS に掲載の payTo・warn と alert)', async () => {
    seed([{ id: 'a', record: VISIBLE, respond: gate402(OTHER) }]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ checked: 2, ok: 1, violations: 1, transient: 0, hidden: 0, restored: 0 });
    expect(stored()).toMatchObject({ hidden: false, verification: { failures: 1, lastRunId: runIdOf(10) } });
    expect(stored().verification).not.toHaveProperty('lastOkAt');
    expect(externalCasArgs(run)).toEqual([
      [urlOf('a'), hourIso(10), runIdOf(10), 'violation', 'clear', expect.any(String), expect.any(String), 'a', SELLER],
    ]);
    expect(run.warns).toEqual([[ENFORCE_EVENT, {
      runId: runIdOf(10), target: 'external:a', host: 'a.seller.example', mismatch: 'payTo',
      visibility: 'visible', outcome: 'counted', failures: 1,
    }]]);
    expect(run.alerts).toHaveLength(1);
    expect(run.alerts[0]).toContain('violations=1');
    expect(await publicIds()).toEqual(['a']);
  });

  it('合わない 402 が続くと閾値で hidden になり (台帳あり・一覧から外れる)、照合が合う 402 で戻る', async () => {
    seed([{ id: 'a', record: VISIBLE, respond: gate402(OTHER) }]);
    const outcomes: unknown[] = [];
    const changes: unknown[] = [];
    for (let hour = 10; hour < 10 + REVERIFY_HIDE_THRESHOLD; hour += 1) {
      const run = await runAt(hour);
      outcomes.push(run.enforceWarns.map((fields) => [fields.outcome, fields.failures]));
      changes.push(run.visibilityWarns.map((fields) => [fields.change, fields.verdict, fields.failures]));
    }
    expect(outcomes).toEqual([[['counted', 1]], [['counted', 2]], [['hidden', 3]]]);
    // 閾値の回は照合の warn (outcome: hidden) と見え方の変化の warn の両方が出る。
    expect(changes).toEqual([[], [], [['hidden', 'violation_gate_mismatch', 3]]]);
    expect(stored()).toMatchObject({ hidden: true, verification: { failures: REVERIFY_HIDE_THRESHOLD } });
    expect(holder.store!.strings.has(hiddenUrlLedgerKey(urlOf('a')))).toBe(true);
    expect(await publicIds()).toEqual([]);

    // 合わない 402 のままなら hidden のまま。
    const kept = await runAt(13);
    expect(kept.enforceWarns).toEqual([expect.objectContaining({ visibility: 'hidden', outcome: 'kept_hidden', failures: 4 })]);
    expect(kept.visibilityWarns).toEqual([]);
    expect(await publicIds()).toEqual([]);

    // ゲートを直せば (掲載の受取先の 402) 次の確認で戻る。
    respondExternal(gate402(SELLER));
    const restored = await runAt(14);
    expect(restored.body).toMatchObject({ ok: 2, restored: 1 });
    expect(restored.enforceWarns).toEqual([]);
    expect(restored.visibilityWarns).toEqual([expect.objectContaining({ change: 'restored', verdict: 'ok_402_openpay', failures: 0 })]);
    expect(stored()).toMatchObject({ hidden: false, verification: { failures: 0, lastOkAt: hourIso(14) } });
    expect(await publicIds()).toEqual(['a']);
  });

  it('別のチェーンの 402 も確定違反 (mismatch: network)', async () => {
    seed([{ id: 'a', record: VISIBLE, respond: gate402(SELLER, 'eip155:1') }]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ ok: 1, violations: 1 });
    expect(run.enforceWarns).toEqual([expect.objectContaining({ mismatch: 'network', outcome: 'counted' })]);
  });

  it('掲載の受取先の 402 は従来どおり ok (違反のカウンタが戻る・warn も alert も無い・CAS に掲載の payTo)', async () => {
    seed([{ id: 'a', record: { ...VISIBLE, verification: { ...VISIBLE.verification, failures: 2 } }, respond: gate402(SELLER) }]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ checked: 2, ok: 2, violations: 0, transient: 0 });
    expect(stored()).toMatchObject({ hidden: false, verification: { failures: 0, lastOkAt: hourIso(10) } });
    expect(externalCasArgs(run)).toEqual([
      [urlOf('a'), hourIso(10), runIdOf(10), 'ok', 'clear', expect.any(String), expect.any(String), 'a', SELLER],
    ]);
    expect(run.warns).toEqual([]);
    expect(run.alerts).toEqual([]);
  });

  it('ok 以外 (404・403・foreign の 402・5xx) は照合しない (従来どおりの verdict・照合の warn なし)', async () => {
    seed([
      { id: 'gone', record: VISIBLE, respond: status(404) },
      { id: 'blocked', record: VISIBLE, respond: status(403) },
      { id: 'foreign', record: VISIBLE, respond: async () => json402({ accepts: [{ network: 'base', payTo: OTHER }] }) },
      { id: 'down', record: VISIBLE, respond: status(503) },
    ]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ checked: 5, ok: 1, violations: 2, transient: 2 });
    expect(run.enforceWarns).toEqual([]);
  });
});

describe('モデレーションの hidden (印なし)', () => {
  it('他人の受取先の 402 では戻らない (確定違反に数えて hidden のまま・台帳を延ばす・warn は kept_hidden)', async () => {
    seed([{ id: 'a', record: MODERATED, respond: gate402(OTHER) }]);
    const ledger = hiddenUrlLedgerKey(urlOf('a'));
    holder.store!.strings.set(ledger, '1');
    const run = await runAt(10);
    expect(run.body).toMatchObject({ checked: 2, ok: 1, violations: 1, restored: 0 });
    expect(stored()).toMatchObject({ hidden: true, verification: { failures: 4, lastRunId: runIdOf(10) } });
    expect(holder.store!.getTtl(ledger)).toBe(HIDDEN_URL_LEDGER_TTL_SEC);
    expect(run.warns).toEqual([[ENFORCE_EVENT, {
      runId: runIdOf(10), target: 'external:a', host: 'a.seller.example', mismatch: 'payTo',
      visibility: 'hidden', outcome: 'kept_hidden', failures: 4,
    }]]);
    expect(await publicIds()).toEqual([]);
  });

  it('合わない 402 が何時間続いても戻らず、照合が合う 402 で戻る', async () => {
    seed([{ id: 'a', record: MODERATED, respond: gate402(OTHER) }]);
    for (let hour = 10; hour <= 15; hour += 1) {
      expect((await runAt(hour)).body).toMatchObject({ restored: 0 });
      expect(stored()).toMatchObject({ hidden: true });
    }
    expect(await publicIds()).toEqual([]);
    respondExternal(gate402(SELLER));
    expect((await runAt(16)).body).toMatchObject({ restored: 1 });
    expect(await publicIds()).toEqual(['a']);
  });

  it('掲載の受取先の 402 なら従来どおり戻る (照合の warn は無く、見え方の変化の warn が restored で 1 件)', async () => {
    seed([{ id: 'a', record: MODERATED, respond: gate402(SELLER) }]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ ok: 2, restored: 1 });
    expect(run.warns).toEqual([[VISIBILITY_EVENT, {
      runId: runIdOf(10), target: 'external:a', host: 'a.seller.example', verdict: 'ok_402_openpay',
      change: 'restored', failures: 0, authFailures: 0,
    }]]);
    expect(stored()).toMatchObject({ hidden: false });
    expect(await publicIds()).toEqual(['a']);
  });
});

describe('公開待ちの掲載 (#957 のまま)', () => {
  it('合わない 402 は pending_gate_mismatch だけ (違反に数えず・印と hidden のまま・照合の warn は出さない)', async () => {
    seed([{ id: 'a', record: PENDING, respond: gate402(OTHER) }]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ checked: 2, ok: 1, violations: 0, transient: 1, restored: 0 });
    expect(run.warns).toEqual([[PENDING_EVENT, { runId: runIdOf(10), target: 'external:a', mismatch: 'payTo' }]]);
    expect(stored()).toMatchObject({ ...PENDING, verification: { failures: 0 } });
    expect(externalCasArgs(run)).toEqual([
      [urlOf('a'), hourIso(10), runIdOf(10), 'transient', 'clear', expect.any(String), expect.any(String), 'a', SELLER],
    ]);
  });

  it('合う 402 で公開に進む (印が外れる・見え方の変化の warn は published・集計は従来どおり restored に数える)', async () => {
    seed([{ id: 'a', record: PENDING, respond: gate402(SELLER) }]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ restored: 1 });
    expect(run.warns).toEqual([[VISIBILITY_EVENT, {
      runId: runIdOf(10), target: 'external:a', host: 'a.seller.example', verdict: 'ok_402_openpay',
      change: 'published', failures: 0, authFailures: 0,
    }]]);
    expect(stored()).not.toHaveProperty('pendingFirstVerification');
    expect(await publicIds()).toEqual(['a']);
  });
});

describe('probe の間の payTo の編集 (CAS の受取先の検査が公開中・hidden にも効く)', () => {
  it('公開中: payTo だけを PATCH したら、古い受取先で照合した ok を捨てる (カウンタを戻さない)', async () => {
    seed([{ id: 'a', record: { ...VISIBLE, verification: { ...VISIBLE.verification, failures: 2 } }, respond: gate402(SELLER) }]);
    respondExternal(async () => {
      await patch('a', { payTo: OTHER }); // probe の途中 (402 が返る前) に出品者が受取先を変える
      return gate402(SELLER)();
    });
    await runAt(10);
    expect(stored()).toMatchObject({ hidden: false, payTo: OTHER, verification: { failures: 2, lastRunId: 'old' } });

    // 次の確認は新しい受取先で照合する (ゲートも新しい受取先に直せば ok)。
    respondExternal(gate402(OTHER));
    await runAt(11);
    expect(stored()).toMatchObject({ hidden: false, verification: { failures: 0, lastRunId: runIdOf(11) } });
  });

  it('公開中: 合わない 402 の回に payTo を PATCH したら、違反も数えない (warn は not_applied・pay_to_changed)', async () => {
    seed([{ id: 'a', record: VISIBLE, respond: gate402(OTHER) }]);
    respondExternal(async () => {
      await patch('a', { payTo: OTHER });
      return gate402(OTHER)();
    });
    const run = await runAt(10);
    expect(stored()).toMatchObject({ payTo: OTHER, verification: { failures: 0, lastRunId: 'old' } });
    expect(run.enforceWarns).toEqual([expect.objectContaining({
      mismatch: 'payTo', visibility: 'visible', outcome: 'not_applied', reason: 'pay_to_changed',
    })]);
  });

  it('公開中: 受取先を変えない PATCH (説明だけ) なら結果を捨てない', async () => {
    seed([{ id: 'a', record: VISIBLE, respond: gate402(SELLER) }]);
    respondExternal(async () => {
      await patch('a', { description: 'paid report v2' });
      return gate402(SELLER)();
    });
    await runAt(10);
    expect(stored()).toMatchObject({ description: 'paid report v2', verification: { failures: 0, lastRunId: runIdOf(10) } });
  });

  it('モデレーションの hidden: payTo を PATCH したら古い受取先の ok では戻らず、新しい受取先の 402 で戻る', async () => {
    seed([{ id: 'a', record: MODERATED, respond: gate402(SELLER) }]);
    respondExternal(async () => {
      await patch('a', { payTo: OTHER });
      return gate402(SELLER)();
    });
    expect((await runAt(10)).body).toMatchObject({ restored: 0 });
    expect(stored()).toMatchObject({ hidden: true, payTo: OTHER });

    // 古い受取先の 402 は、新しい受取先の掲載とは合わない。
    respondExternal(gate402(SELLER));
    expect((await runAt(11)).enforceWarns).toEqual([expect.objectContaining({ outcome: 'kept_hidden' })]);
    expect(stored()).toMatchObject({ hidden: true });

    respondExternal(gate402(OTHER));
    expect((await runAt(12)).body).toMatchObject({ restored: 1 });
    expect(await publicIds()).toEqual(['a']);
  });
});

// #957 の「残る穴」: どれも「印のない hidden の復帰は照合しない」ことから来ていた。今はその復帰も照合するので、他人の
// 受取先の 402 では公開されない (どの穴も hidden のまま移るので、その間に公開される時間も無い)。
describe('#957 の「残る穴」1〜3', () => {
  it('1. 閾値で印が外れた掲載 (確定違反 3 回) は、他人の受取先の 402 では公開されない', async () => {
    seed([{ id: 'a', record: PENDING, respond: status(404) }]);
    for (let hour = 10; hour < 10 + REVERIFY_HIDE_THRESHOLD; hour += 1) await runAt(hour);
    expect(stored()).toMatchObject({ hidden: true });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');

    respondExternal(gate402(OTHER));
    for (let hour = 13; hour <= 15; hour += 1) {
      const run = await runAt(hour);
      expect(run.body).toMatchObject({ restored: 0 });
      expect(run.enforceWarns).toEqual([expect.objectContaining({ visibility: 'hidden', outcome: 'kept_hidden' })]);
    }
    expect(await publicIds()).toEqual([]);

    respondExternal(gate402(SELLER));
    expect((await runAt(16)).body).toMatchObject({ restored: 1 });
    expect(await publicIds()).toEqual(['a']);
  });

  it('2. 台帳のある URL へ PATCH した公開待ちの掲載は、他人の受取先の 402 では公開されない', async () => {
    seed([{ id: 'a', record: PENDING, respond: gate402(OTHER) }]);
    const ledgerUrl = 'https://moderated.seller.example/api/paid';
    holder.store!.strings.set(hiddenUrlLedgerKey(ledgerUrl), '1');
    await patch('a', { url: ledgerUrl });
    expect(stored()).toMatchObject({ url: ledgerUrl, hidden: true });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');

    respondExternal(gate402(OTHER));
    const run = await runAt(10);
    expect(run.body).toMatchObject({ violations: 1, restored: 0 });
    expect(run.enforceWarns).toEqual([expect.objectContaining({
      host: 'moderated.seller.example', visibility: 'hidden', outcome: 'kept_hidden',
    })]);
    expect(await publicIds()).toEqual([]);

    respondExternal(gate402(SELLER));
    expect((await runAt(11)).body).toMatchObject({ restored: 1 });
    expect(await publicIds()).toEqual(['a']);
  });

  it('3. 台帳を継承して作られた掲載 (印なしの hidden) は、他人の受取先の 402 では公開されない', async () => {
    const url = urlOf('a');
    holder.store!.strings.set(hiddenUrlLedgerKey(url), '1');
    const created = await createResource(
      { merchant: SELLER, url, description: 'paid', priceJpyc: '1', category: 'api', payTo: SELLER },
      'a',
      1,
      { pendingFirstVerification: true },
    );
    expect(created).toMatchObject({ ok: true, resource: { hidden: true } });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');

    respondExternal(gate402(OTHER));
    const run = await runAt(10);
    expect(run.body).toMatchObject({ violations: 1, restored: 0 });
    expect(run.enforceWarns).toEqual([expect.objectContaining({ visibility: 'hidden', outcome: 'kept_hidden' })]);
    expect(await publicIds()).toEqual([]);

    respondExternal(gate402(SELLER));
    expect((await runAt(11)).body).toMatchObject({ restored: 1 });
    expect(await publicIds()).toEqual(['a']);
  });
});

describe('first-party と集計', () => {
  it('first-party は照合しない (他人の受取先の 402 でも ok・warn なし・CAS に受取先の引数は無い)', async () => {
    seed([]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ checked: 1, ok: 1, violations: 0, transient: 0 });
    expect(run.warns).toEqual([]);
    const firstParty = run.evals.filter((call) => call.keys[0] === firstPartyVerificationKey(FIRST_PARTY_RESOURCES[0].path));
    expect(firstParty.map((call) => call.args)).toEqual([[FP_URL, hourIso(10), runIdOf(10), 'ok', 'clear']]);
  });

  it('合わない 402 は violations (公開中・hidden) と transient (公開待ち) に数え、観測の集計項目は無い', async () => {
    seed([
      { id: 'match', record: VISIBLE, respond: gate402(SELLER) },
      { id: 'other', record: VISIBLE, respond: gate402(OTHER) },
      { id: 'hidden', record: MODERATED, respond: gate402(SELLER, 'eip155:1') },
      { id: 'pending', record: PENDING, respond: gate402(OTHER) },
      { id: 'gone', record: VISIBLE, respond: status(404) },
    ]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ checked: 6, ok: 2, violations: 3, transient: 1, hidden: 0, restored: 0 });
    expect(run.body).not.toHaveProperty('observeChecked');
    expect(run.body).not.toHaveProperty('observeMismatch');
    expect(run.enforceWarns.map((fields) => [fields.target, fields.mismatch, fields.visibility, fields.outcome])).toEqual([
      ['external:other', 'payTo', 'visible', 'counted'],
      ['external:hidden', 'network', 'hidden', 'kept_hidden'],
    ]);
    expect(run.warns.filter(([event]) => event === PENDING_EVENT)).toHaveLength(1);
    const completed = run.infos.filter(([event]) => event === 'x402.reverify.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0][1]).not.toHaveProperty('observeChecked');
  });
});

// 掲載の見え方が変わった回だけに warn を 1 件出す (本番の logger は warn 以上しか出さず、集計の hidden / restored は info・警報は
// 任意の env で件数だけ)。2026-11-08: 外部の掲載の URL が 410 になり violation_gone で hidden になったが、どの掲載がいつ
// hidden になったかを読めなかった。変わらない回と CAS が結果を捨てた回は出さない。
describe('見え方の変化の warn (x402.reverify.visibility_changed)', () => {
  const FP_TARGET = `first-party:${FIRST_PARTY_RESOURCES[0].path}`;
  const FP_HOST = new URL(FP_URL).host;

  it('URL が 410 になった公開中の掲載は、閾値で hidden になった回にだけ 1 件出す (照合の warn は無い)', async () => {
    seed([{ id: 'a', record: VISIBLE, respond: status(410) }]);
    const changes: unknown[] = [];
    for (let hour = 10; hour < 10 + REVERIFY_HIDE_THRESHOLD; hour += 1) {
      changes.push((await runAt(hour)).warns);
    }
    expect(changes).toEqual([[], [], [[VISIBILITY_EVENT, {
      runId: runIdOf(12), target: 'external:a', host: 'a.seller.example', verdict: 'violation_gone',
      change: 'hidden', failures: REVERIFY_HIDE_THRESHOLD, authFailures: 0,
    }]]]);
    expect(await publicIds()).toEqual([]);

    // hidden のまま (410 が続く) の回は出さない。
    const kept = await runAt(13);
    expect(kept.body).toMatchObject({ violations: 1, hidden: 0 });
    expect(kept.warns).toEqual([]);
  });

  it('締め出し (403) の閾値で hidden になった回は verdict が transient・authFailures が閾値で出る', async () => {
    seed([{
      id: 'a',
      record: { ...VISIBLE, verification: { ...VISIBLE.verification, authFailures: REVERIFY_AUTH_HIDE_THRESHOLD - 1 } },
      respond: status(403),
    }]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ transient: 1, hidden: 1 });
    expect(run.warns).toEqual([[VISIBILITY_EVENT, {
      runId: runIdOf(10), target: 'external:a', host: 'a.seller.example', verdict: 'transient',
      change: 'hidden', failures: 0, authFailures: REVERIFY_AUTH_HIDE_THRESHOLD,
    }]]);
  });

  it('first-party も hidden になった回と戻った回に出す', async () => {
    seed([]);
    holder.store!.strings.set(firstPartyVerificationKey(FIRST_PARTY_RESOURCES[0].path), JSON.stringify({
      hidden: false,
      verification: { failures: REVERIFY_HIDE_THRESHOLD - 1, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: FP_URL },
    }));
    holder.respond = status(404);
    const hidden = await runAt(10);
    expect(hidden.body).toMatchObject({ checked: 1, violations: 1, hidden: 1 });
    expect(hidden.warns).toEqual([[VISIBILITY_EVENT, {
      runId: runIdOf(10), target: FP_TARGET, host: FP_HOST, verdict: 'violation_gone',
      change: 'hidden', failures: REVERIFY_HIDE_THRESHOLD, authFailures: 0,
    }]]);

    holder.respond = gate402(OTHER); // first-party は照合しない
    const restored = await runAt(11);
    expect(restored.body).toMatchObject({ checked: 1, ok: 1, restored: 1 });
    expect(restored.warns).toEqual([[VISIBILITY_EVENT, {
      runId: runIdOf(11), target: FP_TARGET, host: FP_HOST, verdict: 'ok_402_openpay',
      change: 'restored', failures: 0, authFailures: 0,
    }]]);
  });

  it('見え方が変わらない回 (公開のまま・hidden のまま・公開待ちのまま) は出さない', async () => {
    seed([
      { id: 'ok', record: VISIBLE, respond: gate402(SELLER) },
      { id: 'counted', record: VISIBLE, respond: status(404) },
      { id: 'kept', record: MODERATED, respond: status(404) },
      { id: 'pending', record: PENDING, respond: status(503) },
    ]);
    const run = await runAt(10);
    expect(run.body).toMatchObject({ checked: 5, ok: 2, violations: 2, transient: 1, hidden: 0, restored: 0 });
    expect(run.warns).toEqual([]);
  });

  it('CAS が結果を捨てた回 (applied: false) は、戻るはずの ok でも出さない', async () => {
    seed([
      { id: 'moderated', record: MODERATED, respond: gate402(SELLER) },
      { id: 'pending', record: PENDING, respond: gate402(SELLER) },
    ]);
    respondExternal(async (url) => {
      // probe の途中 (402 が返る前) に出品者が編集する: 受取先の変更 (pay_to_changed)・URL の変更 (url_changed)。
      if (url === urlOf('moderated')) await patch('moderated', { payTo: OTHER });
      else await patch('pending', { url: 'https://moved.seller.example/api/paid' });
      return gate402(SELLER)();
    });
    const run = await runAt(10);
    expect(run.body).toMatchObject({ ok: 3, restored: 0 });
    expect(stored('moderated')).toMatchObject({ hidden: true, verification: { lastRunId: 'old' } });
    expect(stored('pending')).toMatchObject({ hidden: true, pendingFirstVerification: true });
    expect(run.warns).toEqual([]);
  });
});
