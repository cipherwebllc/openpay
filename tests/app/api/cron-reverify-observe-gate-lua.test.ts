// @vitest-environment node
// 観測だけの照合 (E-3 の残り・2026-10-30 user 裁定 (b) の「観測」の段)。印のない外部の掲載 (公開中・モデレーションの
// hidden) の ok の 402 を、公開待ちと同じ照合に通して warn と集計に残すだけで、verdict・カウンタ・CAS の引数・復帰・alert・
// 応答 (観測の 2 項目を除く) は変えないことを、本物の route・本物の probe の解釈・本物の照合・本物の Lua で確かめる。
//
// 「変更前」の再現: probeForReverifyDetailed から観測の引数 (observePayTo) を落とす (holder.observe = false)。その戻り値は
// 変更前の route が呼んでいた probeForReverifyDetailed(url) と同じ (既存の tests/lib/x402/reverify*.test.ts が toEqual で
// 固定)。同じ seed・同じ時刻・同じ 402 で「観測なし」と「観測あり」を流し、KV への EVAL の呼び出し (script・keys・args)・
// 掲載の record と TTL・cursor・応答・ほかの warn / info・alert の webhook・probe の HTTP が、観測の項目を除いて一致する
// ことを見る。差し替えるのは KV の土台 (wasmoon のエミュレータ)・SSRF-safe fetch・lock と cursor・alert の fetch だけ。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';
import type { ReverifyCursor } from '@/lib/x402/reverify';

type Fetched = { res: Response | null };
type EvalCall = { script: string; keys: string[]; args: string[] };
const holder = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  cursor: { offset: 0 } as ReverifyCursor,
  respond: null as unknown as (url: string) => Fetched,
  fetched: [] as string[],
  evals: [] as EvalCall[],
  observe: true,
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
// first-party は本物の 1 件 (/api/paid/demo) を残す = 観測しないことを毎回の比較に含める。
vi.mock('@/lib/x402/firstParty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/x402/firstParty')>();
  return { ...actual, FIRST_PARTY_RESOURCES: actual.FIRST_PARTY_RESOURCES.slice(0, 1) };
});
// probe の取得だけを差し替える (verdict の解釈と照合は本物)。呼ばれた URL を数える (追加の HTTP が無いことを見る)。
vi.mock('@/lib/x402/moderation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/moderation')>()),
  fetchSsrfSafeDetailed: async (url: string) => {
    holder.fetched.push(url);
    return holder.respond(url);
  },
}));
vi.mock('@/lib/x402/reverify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/x402/reverify')>();
  return {
    ...actual,
    acquireReverifyLock: async () => 'acquired',
    releaseReverifyLock: async () => {},
    readReverifyCursor: async () => holder.cursor,
    writeReverifyCursor: async (cursor: ReverifyCursor) => { holder.cursor = cursor; return true; },
    probeForReverifyDetailed: (
      url: string,
      opts?: Parameters<typeof actual.probeForReverifyDetailed>[1],
      observePayTo?: string,
    ) => actual.probeForReverifyDetailed(url, opts, holder.observe ? observePayTo : undefined),
  };
});

import { FIRST_PARTY_RESOURCES, firstPartyResourceUrl } from '@/lib/x402/firstParty';
import { utcDateId } from '@/lib/x402/reverify';
import { RESOURCES_INDEX, resourceKey } from '@/lib/x402/registry';
import { registrationAcceptExpectation } from '@/lib/x402/registrationGateMatch';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';
import { GET } from '@/app/api/cron/reverify/route';

const AT = '2026-10-30T10:00:00.000Z';
const RUN_ID = '2026103010';
const SELLER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x9999999999999999999999999999999999999999';
const NETWORK = registrationAcceptExpectation(SELLER).network;
const FP_URL = firstPartyResourceUrl(FIRST_PARTY_RESOURCES[0]);
const urlOf = (id: string) => `https://${id}.seller.example/api/paid`;
const OBSERVE_EVENT = 'x402.reverify.observe_gate_mismatch';
const OBSERVE_FIELDS = ['observeChecked', 'observeMismatch'] as const;

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
  () => json402({ x402Version: 1, accepts: [openpayAccept(merchant, network)] });
const status = (code: number) => (): Fetched => ({ res: new Response('', { status: code }) });

type Listing = { id: string; record?: Record<string, unknown>; respond: () => Fetched; claim?: string; url?: string };
const listingUrl = (listing: Listing) => listing.url ?? urlOf(listing.id);
const VISIBLE = { hidden: false, verification: { failures: 2, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: '' } };
const MODERATED = { hidden: true, verification: { failures: 3, lastCheckedAt: 'old', lastRunId: 'old', probedUrl: '' } };
const PENDING = { hidden: true, pendingFirstVerification: true };

function seed(listings: readonly Listing[], extra: readonly Listing[] = []) {
  for (const listing of [...listings, ...extra]) {
    const url = listingUrl(listing);
    const record = listing.record ?? {};
    const verification = record.verification as Record<string, unknown> | undefined;
    holder.store!.strings.set(resourceKey(listing.id), JSON.stringify({
      id: listing.id, merchant: SELLER, url, description: 'paid', priceJpyc: '1', category: 'api',
      payTo: SELLER, network: NETWORK, active: true, createdAt: 1, updatedAt: 1,
      ...record,
      ...(verification ? { verification: { ...verification, probedUrl: url } } : {}),
    }));
    holder.store!.strings.set(resourceUrlClaimKey(url), listing.claim ?? listing.id);
  }
  holder.store!.lists.set(RESOURCES_INDEX, listings.map((listing) => listing.id));
}

// KV の中身 (文字列・リスト・TTL) を key 順に並べたもの。
function snapshot() {
  const store = holder.store!;
  return {
    strings: [...store.strings.entries()].sort(([a], [b]) => a.localeCompare(b)),
    lists: [...store.lists.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ttl: store.keys().sort().map((key) => [key, store.getTtl(key)]),
  };
}

function withoutObserve(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const copy = { ...(value as Record<string, unknown>) };
  for (const field of OBSERVE_FIELDS) delete copy[field];
  return copy;
}

// 毎時の再検証 1 回。observe = false で「変更前」を再現する。
async function run(listings: readonly Listing[], observe: boolean, extra: readonly Listing[] = []) {
  holder.store = createFakeRedisStore();
  holder.evals = [];
  holder.fetched = [];
  holder.warn.mockClear();
  holder.info.mockClear();
  holder.observe = observe;
  seed(listings, extra);
  const byUrl = new Map(listings.map((listing) => [listingUrl(listing), listing.respond]));
  holder.respond = (url) => (url === FP_URL ? gate402(OTHER)() : byUrl.get(url)!());
  vi.setSystemTime(new Date(AT));
  holder.cursor = { offset: 0, directoryDate: utcDateId(new Date(AT)) };
  const webhook = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('ok'));
  vi.stubGlobal('fetch', webhook);
  const response = await GET(new Request('https://open-pay.jp/api/cron/reverify', {
    headers: { authorization: 'Bearer test' },
  }));
  const body = (await response.json()) as Record<string, unknown>;
  const warns = holder.warn.mock.calls as Array<[string, Record<string, unknown>]>;
  const infos = holder.info.mock.calls as Array<[string, Record<string, unknown>]>;
  return {
    status: response.status,
    body,
    evals: holder.evals,
    store: snapshot(),
    cursor: holder.cursor,
    fetched: [...holder.fetched].sort(),
    webhook: webhook.mock.calls.map(([url, init]) => [url, init?.body]),
    warns,
    infos,
    observeWarns: warns.filter(([event]) => event === OBSERVE_EVENT).map(([, fields]) => fields),
  };
}

// 観測なし (変更前) と観測あり (変更後) を流し、観測の項目を除いてすべて一致することを確かめる。
async function runBoth(listings: readonly Listing[], extra: readonly Listing[] = []) {
  const before = await run(listings, false, extra);
  const after = await run(listings, true, extra);
  expect(after.status).toBe(before.status);
  expect(withoutObserve(after.body)).toEqual(withoutObserve(before.body));
  expect(after.evals).toEqual(before.evals);
  expect(after.store).toEqual(before.store);
  expect(after.cursor).toEqual(before.cursor);
  expect(after.webhook).toEqual(before.webhook);
  // probe の HTTP は対象ごとに 1 回ずつ (観測は追加の HTTP をしない)。
  expect(after.fetched).toEqual(before.fetched);
  expect(after.fetched).toEqual([...listings.map(listingUrl), FP_URL].sort());
  expect(after.warns.filter(([event]) => event !== OBSERVE_EVENT)).toEqual(before.warns);
  expect(after.infos.map(([event, fields]) => [event, withoutObserve(fields)]))
    .toEqual(before.infos.map(([event, fields]) => [event, withoutObserve(fields)]));
  // 「変更前」は観測しない (比べる相手が本当に観測なしであること)。
  expect(before.observeWarns).toEqual([]);
  expect(before.body).toMatchObject({ observeChecked: 0, observeMismatch: 0 });
  return after;
}

// 外部の掲載 id の CAS の引数 (CAS_EXTERNAL_REVERIFY の ARGV)。
const externalCasArgs = (result: { evals: EvalCall[] }, id: string) =>
  result.evals.filter((call) => call.keys[0] === resourceKey(id)).map((call) => call.args);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('CRON_SECRET', 'test');
  vi.stubEnv('ALERT_WEBHOOK_URL', 'https://hooks.test/reverify');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('公開中の掲載の観測', () => {
  it('合わない 402 (他人の受取先) は warn と集計に残し、verdict・CAS・record・応答・alert は観測なしと同じ', async () => {
    const after = await runBoth([{ id: 'a', record: VISIBLE, respond: gate402(OTHER) }]);
    expect(after.observeWarns).toEqual([{
      runId: RUN_ID, target: 'external:a', host: 'a.seller.example', mismatch: 'payTo', visibility: 'visible', restored: false,
    }]);
    expect(after.body).toMatchObject({ checked: 2, ok: 2, violations: 0, transient: 0, observeChecked: 1, observeMismatch: 1 });
    // 従来どおり ok で数え、公開のまま (カウンタが戻る)。照合しなかった probe なので CAS の受取先の検査 (ARGV[9]) は空。
    expect(JSON.parse(holder.store!.strings.get(resourceKey('a'))!))
      .toMatchObject({ hidden: false, verification: { failures: 0, lastOkAt: AT, lastRunId: RUN_ID } });
    expect(externalCasArgs(after, 'a')).toEqual([[urlOf('a'), AT, RUN_ID, 'ok', 'clear', expect.any(String), expect.any(String), 'a', '']]);
    // alert の条件は観測で変わらない (この回は鳴らない)。
    expect(after.webhook).toEqual([]);
  });

  it('別のチェーンの 402 も項目 (network) を残すだけ', async () => {
    const after = await runBoth([{ id: 'a', record: VISIBLE, respond: gate402(SELLER, 'eip155:1') }]);
    expect(after.observeWarns).toEqual([expect.objectContaining({ target: 'external:a', mismatch: 'network', visibility: 'visible' })]);
    expect(after.body).toMatchObject({ ok: 2, observeChecked: 1, observeMismatch: 1 });
  });

  it('掲載の受取先の 402 は warn を出さない (集計は照合した回だけ数える)', async () => {
    const after = await runBoth([{ id: 'a', record: VISIBLE, respond: gate402(SELLER) }]);
    expect(after.observeWarns).toEqual([]);
    expect(after.warns).toEqual([]);
    expect(after.body).toMatchObject({ ok: 2, observeChecked: 1, observeMismatch: 0 });
  });

  it('ok 以外 (404・403・foreign の 402・5xx) は照合しない', async () => {
    const after = await runBoth([
      { id: 'gone', record: VISIBLE, respond: status(404) },
      { id: 'blocked', record: VISIBLE, respond: status(403) },
      { id: 'foreign', record: VISIBLE, respond: () => json402({ accepts: [{ network: 'base', payTo: OTHER }] }) },
      { id: 'down', record: VISIBLE, respond: status(503) },
    ]);
    expect(after.observeWarns).toEqual([]);
    expect(after.body).toMatchObject({ checked: 5, violations: 2, transient: 2, observeChecked: 0, observeMismatch: 0 });
  });
});

describe('モデレーションの hidden (印なし) の観測', () => {
  it('合わない 402 でも従来どおり復帰し (照合しない復帰)、warn は visibility: hidden・restored: true を残す', async () => {
    const after = await runBoth([{ id: 'a', record: MODERATED, respond: gate402(OTHER) }]);
    expect(after.observeWarns).toEqual([{
      runId: RUN_ID, target: 'external:a', host: 'a.seller.example', mismatch: 'payTo', visibility: 'hidden', restored: true,
    }]);
    expect(after.body).toMatchObject({ ok: 2, restored: 1, observeChecked: 1, observeMismatch: 1 });
    expect(JSON.parse(holder.store!.strings.get(resourceKey('a'))!)).toMatchObject({ hidden: false });
    expect(externalCasArgs(after, 'a')).toEqual([[urlOf('a'), AT, RUN_ID, 'ok', 'clear', expect.any(String), expect.any(String), 'a', '']]);
    // 復帰の alert も観測なしと同じ文面 (観測の数は載せない)。
    expect(after.webhook).toHaveLength(1);
    expect(JSON.stringify(after.webhook)).not.toContain('observe');
  });

  it('URL を他の公開中の掲載が持っていて復帰が保留される回も同じ (restored: false・url_taken の warn も従来どおり)', async () => {
    const after = await runBoth(
      [{ id: 'a', record: MODERATED, respond: gate402(OTHER), claim: 'b' }],
      // 'b' は同じ URL を claim する公開中の掲載 (今回の batch には入れない)。
      [{ id: 'b', record: { hidden: false }, respond: gate402(SELLER), claim: 'b', url: urlOf('a') }],
    );
    expect(after.observeWarns).toEqual([expect.objectContaining({ visibility: 'hidden', restored: false })]);
    expect(after.warns.map(([event]) => event)).toEqual(['x402.reverify.url_taken', OBSERVE_EVENT]);
    expect(after.body).toMatchObject({ ok: 2, restored: 0, urlTaken: 1, observeMismatch: 1 });
  });

  it('掲載の受取先の 402 で復帰する回は warn を出さない', async () => {
    const after = await runBoth([{ id: 'a', record: MODERATED, respond: gate402(SELLER) }]);
    expect(after.observeWarns).toEqual([]);
    expect(after.body).toMatchObject({ restored: 1, observeChecked: 1, observeMismatch: 0 });
  });
});

describe('観測しない対象', () => {
  it('公開待ちの掲載は #957 の照合だけ (pending_gate_mismatch を 1 回・観測の warn も集計も無し)', async () => {
    const after = await runBoth([{ id: 'a', record: PENDING, respond: gate402(OTHER) }]);
    expect(after.observeWarns).toEqual([]);
    expect(after.warns).toEqual([['x402.reverify.pending_gate_mismatch', { runId: RUN_ID, target: 'external:a', mismatch: 'payTo' }]]);
    expect(after.body).toMatchObject({ transient: 1, observeChecked: 0, observeMismatch: 0 });
    // 公開待ちは従来どおり照合した受取先を CAS に渡す (#957)。
    expect(externalCasArgs(after, 'a')).toEqual([[urlOf('a'), AT, RUN_ID, 'transient', 'clear', expect.any(String), expect.any(String), 'a', SELLER]]);
  });

  it('公開待ちの掲載が合う 402 で公開に進む回も観測しない', async () => {
    const after = await runBoth([{ id: 'a', record: PENDING, respond: gate402(SELLER) }]);
    expect(after.warns).toEqual([]);
    expect(after.body).toMatchObject({ restored: 1, observeChecked: 0 });
  });

  it('first-party は合わない 402 でも観測しない (どの回も first-party の warn は無く、集計は外部の掲載だけ)', async () => {
    // 外部の掲載は 0 件・first-party (/api/paid/demo) には他人の受取先の 402 を返す。
    const after = await runBoth([]);
    expect(after.body).toMatchObject({ checked: 1, ok: 1, observeChecked: 0, observeMismatch: 0 });
    expect(after.warns).toEqual([]);
  });
});

describe('集計 (observeChecked / observeMismatch)', () => {
  it('1 回の run の照合の回数と不一致の数を、応答と x402.reverify.completed に載せる (alert の条件には入れない)', async () => {
    const after = await runBoth([
      { id: 'match', record: VISIBLE, respond: gate402(SELLER) },
      { id: 'other', record: VISIBLE, respond: gate402(OTHER) },
      { id: 'hidden', record: MODERATED, respond: gate402(OTHER, 'eip155:1') },
      { id: 'pending', record: PENDING, respond: gate402(OTHER) },
      { id: 'gone', record: VISIBLE, respond: status(404) },
    ]);
    expect(after.body).toMatchObject({ observeChecked: 3, observeMismatch: 2 });
    expect(after.observeWarns.map((fields) => [fields.target, fields.mismatch, fields.visibility])).toEqual([
      ['external:other', 'payTo', 'visible'],
      ['external:hidden', 'payTo', 'hidden'],
    ]);
    const completed = after.infos.filter(([event]) => event === 'x402.reverify.completed');
    expect(completed).toEqual([['x402.reverify.completed', expect.objectContaining({ observeChecked: 3, observeMismatch: 2 })]]);
    // 応答の末尾に足すだけ (既存の項目の順は変えない)。
    expect(Object.keys(after.body).slice(-3)).toEqual(['observeChecked', 'observeMismatch', 'kv']);
  });
});
