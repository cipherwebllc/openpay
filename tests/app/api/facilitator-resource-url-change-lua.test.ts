// @vitest-environment node
// 第 10 回レビュー B3-3: 掲載の URL を替える編集 (PATCH /api/facilitator/resources/[id]) を、新規登録と同じ扱いにする。
//   替えた先が OpenPay の 402 で照合が合う   → 公開のまま保存
//   替えた先が OpenPay の 402 で照合が合わない → 422 gate_accept_mismatch (保存しない)
//   替えた先を確かめられない (404・3xx・5xx・接続失敗) → 保存するが hidden + pendingFirstVerification (公開待ち)
//   URL を替えない編集 (説明・価格・payTo)   → 今までどおり (照合しない・公開待ちにしない)
// 本物の PATCH route・本物の probe の解釈 (lib/x402/moderation.ts)・本物の照合・本物の Lua (CAS_UPDATE /
// CAS_EXTERNAL_REVERIFY)・本物の再検証の route で通しで確かめる。差し替えるのは境界だけ: KV の土台 (wasmoon の
// エミュレータ)・HTTP の取得 (undici の fetch と DNS)・SIWE のセッション・rate limit・再検証の lock と cursor。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';
import type { ReverifyCursor } from '@/lib/x402/reverify';

const holder = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  cursor: { offset: 0 } as ReverifyCursor,
  respond: null as unknown as (url: string) => Response | Promise<Response>,
  fetched: [] as string[],
  failNextGet: false,
  session: '',
  warn: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({
  kvEndpointInfo: () => ({ host: null, source: null }),
  kvGet: async (key: string) => {
    if (holder.failNextGet) {
      holder.failNextGet = false;
      return { ok: false, reason: 'kv_error' };
    }
    return { ok: true, value: holder.store!.strings.get(key) ?? null };
  },
  kvLrange: async (key: string, start: number, stop: number) => ({
    ok: true,
    value: (holder.store!.lists.get(key) ?? []).slice(start, stop + 1),
  }),
  kvEval: async (script: string, keys: string[], args: string[]) => ({
    ok: true, value: await runRedisLua(script, keys, args, holder.store!),
  }),
}));
// HTTP の境界: probe の GET (登録・編集の moderation と、毎時の再検証) が出ていく先。SSRF の guard・402 の解釈は本物。
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: async (url: string) => {
    holder.fetched.push(url);
    return holder.respond(url);
  },
}));
vi.mock('node:dns/promises', () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  return { default: { lookup }, lookup };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableX402Facilitator: true } };
});
vi.mock('@/lib/siweSession', () => ({
  requireSession: async () => ({ ok: true, address: holder.session }),
}));
vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: async () => true,
  checkReadRateLimit: async () => true,
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: holder.warn, error: vi.fn() } }));
vi.mock('@/lib/x402/firstParty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/firstParty')>()), FIRST_PARTY_RESOURCES: [],
}));
vi.mock('@/lib/x402/reverify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/reverify')>()),
  acquireReverifyLock: async () => 'acquired',
  releaseReverifyLock: async () => {},
  readReverifyCursor: async () => holder.cursor,
  writeReverifyCursor: async (cursor: ReverifyCursor) => { holder.cursor = cursor; return true; },
}));

import { utcDateId } from '@/lib/x402/reverify';
import {
  createResource, getPublicResource, listActiveResources, listResourcesForMerchant, RESOURCES_INDEX, resourceKey,
  updateResource,
} from '@/lib/x402/registry';
import { registrationAcceptExpectation } from '@/lib/x402/registrationGateMatch';
import { hiddenUrlLedgerKey } from '@/lib/x402/hiddenUrlLedger';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';
import { PATCH } from '@/app/api/facilitator/resources/[id]/route';
import { GET as REVERIFY } from '@/app/api/cron/reverify/route';

const SELLER = '0x1111111111111111111111111111111111111111';
const NEW_PAY_TO = '0x2222222222222222222222222222222222222222';
const OTHER = '0x9999999999999999999999999999999999999999';
const OLD_URL = 'https://seller.example/api/paid';
const NEW_URL = 'https://seller.example/api/paid-v2';
const NETWORK = registrationAcceptExpectation(SELLER).network;
const VERIFIED = {
  lastOkAt: '2026-11-12T00:00:00.000Z', lastCheckedAt: '2026-11-12T00:00:00.000Z',
  failures: 0, lastRunId: '2026111200', probedUrl: OLD_URL,
};
const MISMATCH_EVENT = 'x402.facilitator.gate_accept_mismatch';

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
const json402 = (accepts: unknown[]) => () =>
  new Response(JSON.stringify({ x402Version: 1, accepts }), { status: 402, headers: { 'content-type': 'application/json' } });
const gate402 = (merchant: string, network?: string) => json402([openpayAccept(merchant, network)]);
const foreign402 = json402([{ scheme: 'exact', network: 'base', payTo: OTHER, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }]);
const status = (code: number) => () => new Response('', { status: code, ...(code === 302 ? { headers: { location: '/moved' } } : {}) });
const unreachable = () => { throw new TypeError('fetch failed'); };

const stored = () => JSON.parse(holder.store!.strings.get(resourceKey('a'))!) as Record<string, unknown>;
const raw = () => holder.store!.strings.get(resourceKey('a'));
const publicIds = async () => (await listActiveResources())!.map((resource) => resource.id);
const ledgerKeys = () => holder.store!.keys().filter((key) => key.startsWith('x402:hidden-url:'));
const mismatchWarns = () => holder.warn.mock.calls.filter(([event]) => event === MISMATCH_EVENT).map(([, fields]) => fields);

// 検証済みで公開中の掲載 (本物の CAS_CREATE で作り、再検証の ok を受けた後の形にする)。
async function seedLive(overrides: Record<string, unknown> = {}) {
  const created = await createResource({
    merchant: SELLER, url: OLD_URL, description: 'paid', priceJpyc: '100', category: 'api', payTo: SELLER,
  }, 'a', 1);
  expect(created.ok).toBe(true);
  holder.store!.strings.set(resourceKey('a'), JSON.stringify({ ...stored(), verification: VERIFIED, ...overrides }));
}

type Edit = { url?: string; description?: string; priceJpyc?: string; payTo?: string };
async function patch(edit: Edit, respond: (url: string) => Response | Promise<Response>) {
  holder.respond = respond;
  holder.fetched = [];
  const current = stored();
  const response = await PATCH(new Request('https://open-pay.jp/api/facilitator/resources/a', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: edit.url ?? current.url,
      description: edit.description ?? current.description,
      priceJpyc: edit.priceJpyc ?? current.priceJpyc,
      category: 'api',
      payTo: edit.payTo ?? current.payTo,
    }),
  }), { params: Promise.resolve({ id: 'a' }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, fetched: [...holder.fetched] };
}

// 毎時の再検証 1 回 (本物の route)。
async function reverifyAt(iso: string, respond: (url: string) => Response | Promise<Response>) {
  holder.respond = respond;
  vi.setSystemTime(new Date(iso));
  holder.cursor = { offset: 0, directoryDate: utcDateId(new Date(iso)) };
  const response = await REVERIFY(new Request('https://open-pay.jp/api/cron/reverify', {
    headers: { authorization: 'Bearer test' },
  }));
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, number>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T09:30:00.000Z'));
  holder.store = createFakeRedisStore();
  holder.session = SELLER;
  holder.failNextGet = false;
  holder.fetched = [];
  holder.warn.mockClear();
  vi.stubEnv('CRON_SECRET', 'test');
  vi.stubEnv('ALERT_WEBHOOK_URL', '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(closeRedisLuaEngine);

describe('URL を替える編集は新規登録と同じ扱い', () => {
  it('替えた先が OpenPay の 402 で照合が合えば、公開のまま保存する (確認のカウンタだけ外れる・GET は今までと同じ 2 回)', async () => {
    await seedLive();
    const result = await patch({ url: NEW_URL }, gate402(SELLER));
    expect(result.status).toBe(200);
    expect(result.body.resource).toMatchObject({ id: 'a', url: NEW_URL });
    expect(result.fetched).toEqual([NEW_URL, NEW_URL]);
    expect(stored()).toMatchObject({ url: NEW_URL });
    expect(stored()).not.toHaveProperty('hidden');
    expect(stored()).not.toHaveProperty('pendingFirstVerification');
    expect(stored()).not.toHaveProperty('verification');
    expect(await publicIds()).toEqual(['a']);
    expect(mismatchWarns()).toEqual([]);
  });

  it.each([
    ['payTo', gate402(OTHER)],
    ['network', gate402(SELLER, 'eip155:999999')],
  ] as const)('替えた先の OpenPay の 402 が掲載と合わない (%s) → 422 gate_accept_mismatch・何も保存しない', async (mismatch, respond) => {
    await seedLive();
    const before = raw();
    const secret = 'token-should-not-leak';
    const result = await patch({ url: `https://victim.example/api?x=${secret}` }, respond);
    expect(result.status).toBe(422);
    // 新規登録 (POST) の 422 と同じ形。
    expect(result.body).toEqual({ error: 'gate_accept_mismatch', mismatch });
    expect(raw()).toBe(before);
    expect(holder.store!.strings.get(resourceUrlClaimKey(OLD_URL))).toBe('a');
    expect(await publicIds()).toEqual(['a']);
    expect(mismatchWarns()).toEqual([
      expect.objectContaining({ id: 'a', merchant: SELLER, mismatch, resourceOrigin: 'https://victim.example' }),
    ]);
    expect(JSON.stringify(mismatchWarns())).not.toContain(secret);
  });

  it.each([
    ['404', status(404)],
    ['500', status(500)],
    ['302', status(302)],
    ['接続失敗', unreachable],
  ] as const)('替えた先を確かめられない (%s) → 200 で保存するが、公開待ちになって一覧から消える', async (_name, respond) => {
    await seedLive();
    const result = await patch({ url: NEW_URL }, respond);
    expect(result.status).toBe(200);
    expect(result.body.resource).toMatchObject({ url: NEW_URL, hidden: true, pendingFirstVerification: true });
    expect(result.fetched).toEqual([NEW_URL, NEW_URL]);
    expect(stored()).toMatchObject({ url: NEW_URL, hidden: true, pendingFirstVerification: true });
    expect(stored()).not.toHaveProperty('verification');
    expect(await publicIds()).toEqual([]);
    // ID の照会は返る (出品者のゲートが自分の掲載を引いて 402 を作れる)・owner の一覧には公開待ちとして出る。
    expect(await getPublicResource('a')).toEqual({ ok: true, resource: expect.objectContaining({ id: 'a', url: NEW_URL }) });
    expect(await listResourcesForMerchant(SELLER))
      .toEqual([expect.objectContaining({ id: 'a', hidden: true, pendingFirstVerification: true })]);
    expect(ledgerKeys()).toEqual([]);
  });

  it('替えた先が他 facilitator の 402 → 今までどおり 422 gate_not_openpay (スニペットつき)・何も保存しない', async () => {
    await seedLive();
    const before = raw();
    const result = await patch({ url: NEW_URL }, foreign402);
    expect(result.status).toBe(422);
    expect(result.body.error).toBe('gate_not_openpay');
    expect(String(result.body.paywallSnippet)).toContain('MY_RESOURCE_ID = "a"');
    expect(raw()).toBe(before);
  });

  it('替えた先が支払いなしで 200 → 今までどおり 400 resource_not_gated・何も保存しない', async () => {
    await seedLive();
    const before = raw();
    const result = await patch({ url: NEW_URL }, status(200));
    expect(result).toMatchObject({ status: 400, body: { error: 'resource_not_gated' } });
    expect(raw()).toBe(before);
  });

  it('URL と payTo を同時に替える: 期待値は保存した後の payTo。ゲートが古い payTo を返す間は 422・2 回に分ければ通る', async () => {
    await seedLive();
    const before = raw();
    const both = await patch({ url: NEW_URL, payTo: NEW_PAY_TO }, gate402(SELLER));
    expect(both).toMatchObject({ status: 422, body: { error: 'gate_accept_mismatch', mismatch: 'payTo' } });
    expect(raw()).toBe(before);

    // 1 回目 = URL だけ (ゲートは今の payTo を返すので一致)・2 回目 = payTo だけ (URL が変わらないので照合しない)。
    expect((await patch({ url: NEW_URL }, gate402(SELLER))).status).toBe(200);
    expect((await patch({ payTo: NEW_PAY_TO }, gate402(SELLER))).status).toBe(200);
    expect(stored()).toMatchObject({ url: NEW_URL, payTo: NEW_PAY_TO });
    expect(stored()).not.toHaveProperty('hidden');
    expect(await publicIds()).toEqual(['a']);
  });

  it('URL と payTo を同時に替えても、ゲートが新しい payTo を返していれば公開のまま保存する', async () => {
    await seedLive();
    const result = await patch({ url: NEW_URL, payTo: NEW_PAY_TO }, gate402(NEW_PAY_TO));
    expect(result.status).toBe(200);
    expect(stored()).toMatchObject({ url: NEW_URL, payTo: NEW_PAY_TO });
    expect(stored()).not.toHaveProperty('hidden');
  });

  // 事前の読取 (getResource) は KV の読取失敗も null にするので、route は probe せずに保存へ進む。その保存が通っても、
  // 確かめていない URL を公開のまま指させない。
  it('事前の読取が失敗して probe できなかった URL 変更も公開待ちにする (GET 0 回)', async () => {
    await seedLive();
    holder.failNextGet = true;
    const result = await patch({ url: NEW_URL }, gate402(SELLER));
    expect(result.status).toBe(200);
    expect(result.fetched).toEqual([]);
    expect(stored()).toMatchObject({ url: NEW_URL, hidden: true, pendingFirstVerification: true });
  });
});

describe('URL を替えない編集は今までどおり (照合しない・公開待ちにしない)', () => {
  const EDITS: ReadonlyArray<readonly [string, Edit]> = [
    ['説明と価格', { description: 'paid v2', priceJpyc: '250' }],
    ['payTo だけ', { payTo: NEW_PAY_TO }],
  ];
  const PROBES = [
    ['確かめられない (404)', status(404)],
    ['OpenPay の 402 で古い / 他人の payTo', gate402(OTHER)],
    ['OpenPay の 402 で一致', gate402(SELLER)],
  ] as const;
  it.each(EDITS.flatMap(([editName, edit]) => PROBES.map(([probeName, respond]) => [editName, probeName, edit, respond] as const)))(
    '%s の編集・probe が「%s」→ 200・公開のまま・確認のカウンタも残る',
    async (_editName, _probeName, edit, respond) => {
      await seedLive();
      const result = await patch(edit, respond);
      expect(result.status).toBe(200);
      expect(result.fetched).toEqual([OLD_URL, OLD_URL]);
      expect(stored()).toMatchObject({ url: OLD_URL, verification: VERIFIED, ...edit });
      expect(stored()).not.toHaveProperty('hidden');
      expect(stored()).not.toHaveProperty('pendingFirstVerification');
      expect(await publicIds()).toEqual(['a']);
      expect(mismatchWarns()).toEqual([]);
    },
  );

  it('事前の読取が失敗しても、URL を替えない編集は公開のまま', async () => {
    await seedLive();
    holder.failNextGet = true;
    expect((await patch({ description: 'paid v2' }, status(404))).status).toBe(200);
    expect(stored()).toMatchObject({ description: 'paid v2', verification: VERIFIED });
    expect(stored()).not.toHaveProperty('hidden');
  });

  it('他 facilitator の 402 は URL を替えなくても今までどおり 422 gate_not_openpay', async () => {
    await seedLive();
    const before = raw();
    expect(await patch({ description: 'paid v2' }, foreign402)).toMatchObject({ status: 422, body: { error: 'gate_not_openpay' } });
    expect(raw()).toBe(before);
  });
});

// route の 422 は事前の読取の URL で判定するが、公開待ちにするかは CAS が権威の record で判定する。事前の読取では
// 「URL は同じ」だった編集が、probe の間の並行の編集で CAS の時点では URL 変更になっても、確かめていない URL を公開の
// まま指さない。
describe('probe の間に並行の編集が URL を動かした (URL が変わったかは CAS が判定する)', () => {
  // 1 回目の GET の間に、別の編集 (照合が合った URL 変更 = 公開のまま) が掲載を NEW_URL へ動かす。
  function movedDuringProbe(respond: () => Response): () => Response | Promise<Response> {
    let moved = false;
    return async () => {
      if (!moved) {
        moved = true;
        const current = stored();
        const result = await updateResource('a', SELLER, {
          merchant: SELLER, url: NEW_URL, description: String(current.description), priceJpyc: String(current.priceJpyc),
          category: 'api', payTo: String(current.payTo),
        });
        expect(result.ok).toBe(true);
      }
      return respond();
    };
  }

  it.each([
    ['確かめられない (404)', status(404)],
    ['照合が合わない OpenPay の 402', gate402(OTHER)],
  ] as const)('%s → 元の URL を公開のまま指さず、公開待ちになる', async (_name, respond) => {
    await seedLive();
    const result = await patch({ description: 'paid v2' }, movedDuringProbe(respond));
    expect(result.status).toBe(200);
    expect(stored()).toMatchObject({ url: OLD_URL, description: 'paid v2', hidden: true, pendingFirstVerification: true });
    expect(await publicIds()).toEqual([]);
  });

  it('照合が合う OpenPay の 402 → 公開のまま', async () => {
    await seedLive();
    const result = await patch({ description: 'paid v2' }, movedDuringProbe(gate402(SELLER)));
    expect(result.status).toBe(200);
    expect(stored()).toMatchObject({ url: OLD_URL, description: 'paid v2' });
    expect(stored()).not.toHaveProperty('hidden');
    expect(await publicIds()).toEqual(['a']);
  });
});

describe('編集で公開待ちになった掲載の再検証 (新規登録の公開待ちと同じ)', () => {
  it('合わない 402 では戻らず違反にも数えない・照合が合う 402 で公開に戻る', async () => {
    await seedLive();
    await patch({ url: NEW_URL }, status(404));
    expect(await publicIds()).toEqual([]);

    expect(await reverifyAt('2026-11-12T10:00:00.000Z', gate402(OTHER)))
      .toMatchObject({ checked: 1, ok: 0, violations: 0, transient: 1, restored: 0 });
    expect(stored()).toMatchObject({ hidden: true, pendingFirstVerification: true, verification: { failures: 0 } });
    expect(holder.warn).toHaveBeenCalledWith('x402.reverify.pending_gate_mismatch', {
      runId: '2026111210', target: 'external:a', mismatch: 'payTo',
    });
    expect(ledgerKeys()).toEqual([]);
    expect(await publicIds()).toEqual([]);

    expect(await reverifyAt('2026-11-12T11:00:00.000Z', gate402(SELLER))).toMatchObject({ checked: 1, ok: 1, restored: 1 });
    expect(stored()).toMatchObject({ url: NEW_URL, hidden: false, verification: { failures: 0, probedUrl: NEW_URL } });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');
    expect(await publicIds()).toEqual(['a']);
  });

  it('公開待ちの間に元の URL へ戻す編集 (照合が合う 402) でも、公開に戻すのは再検証の ok だけ', async () => {
    await seedLive();
    await patch({ url: NEW_URL }, status(404));
    expect((await patch({ url: OLD_URL }, gate402(SELLER))).status).toBe(200);
    expect(stored()).toMatchObject({ url: OLD_URL, hidden: true, pendingFirstVerification: true });
    expect(await publicIds()).toEqual([]);
    await reverifyAt('2026-11-12T10:00:00.000Z', gate402(SELLER));
    expect(await publicIds()).toEqual(['a']);
  });
});

// PR #1081 の Codex P2: 再検証は index (x402:resources:index) の先頭 500 件 (位置 0〜499) だけを読み、cursor はその中を回る。
// 新規登録の公開待ちは CAS_CREATE の LPUSH で必ず先頭に入るが、編集は掲載の位置を動かさないので、位置 500 以降の掲載が
// URL を替えて公開待ちになると、再検証が永久に届かず一覧から消えたまま (dual-rail の USDC の中継も 404 のまま) になる。
// 公開待ちにした CAS の中で、新規登録と同じく index の先頭へ動かす。index の ほかの id は record の無い id で、再検証は
// 読むだけで probe しない (HTTP の境界に出るのは掲載 'a' だけ)。
describe('公開待ちにした編集は index の先頭へ動き、位置によらず次の巡回で再検証が届く (新規登録と同じ)', () => {
  const fillers = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => `f${String(from + i).padStart(3, '0')}`);
  const index = () => [...(holder.store!.lists.get(RESOURCES_INDEX) ?? [])];
  // 掲載 'a' を index の位置 at に置く (前に at 件・後ろに after 件)。
  function placeAt(at: number, after = 10) {
    holder.store!.lists.set(RESOURCES_INDEX, [...fillers(0, at), 'a', ...fillers(at, after)]);
  }
  // 毎時の再検証を、cursor を引き継いで (本番と同じく巡回させて) 最大 hours 回流す。掲載 'a' が公開に戻った回の番号
  // (1 始まり) を返す。戻らなければ null。
  async function reverifyUntilRestored(fromIso: string, hours: number, respond: (url: string) => Response) {
    holder.respond = respond;
    holder.fetched = [];
    for (let run = 1; run <= hours; run += 1) {
      const now = new Date(Date.parse(fromIso) + (run - 1) * 3_600_000);
      vi.setSystemTime(now);
      holder.cursor = { ...holder.cursor, directoryDate: utcDateId(now) };
      const response = await REVERIFY(new Request('https://open-pay.jp/api/cron/reverify', {
        headers: { authorization: 'Bearer test' },
      }));
      expect(response.status).toBe(200);
      if (((await response.json()) as Record<string, number>).restored === 1) return run;
    }
    return null;
  }

  it('位置 500 以降の公開中の掲載を確かめられない URL へ替える → 先頭へ動き、巡回のうちに照合つきの ok で公開に戻る', async () => {
    await seedLive();
    placeAt(510);
    const before = index();
    // cursor は先頭より後ろから始める (先頭に届くには 1 度折り返す)。500 件 / 25 件 = 20 回で 1 周。
    holder.cursor = { offset: 137 };
    expect((await patch({ url: NEW_URL }, status(404))).status).toBe(200);
    expect(stored()).toMatchObject({ url: NEW_URL, hidden: true, pendingFirstVerification: true });

    const restoredAt = await reverifyUntilRestored('2026-11-12T10:00:00.000Z', 40, gate402(SELLER));
    expect(holder.fetched).toContain(NEW_URL);
    expect(restoredAt).not.toBeNull();
    expect(restoredAt!).toBeLessThanOrEqual(20);
    expect(stored()).toMatchObject({ url: NEW_URL, hidden: false, verification: { failures: 0, probedUrl: NEW_URL } });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');
    expect(await publicIds()).toEqual(['a']);

    // 先頭へ動いただけ (同じ id は 1 つ・件数は同じ)。読まれる 500 件から外れたのは、位置 499 にあった 1 件だけ
    // (新規登録 1 件の LPUSH と同じ)。
    expect(index()).toEqual(['a', ...before.filter((id) => id !== 'a')]);
    expect(index().filter((id) => id === 'a')).toHaveLength(1);
    expect(index().slice(0, 500)).toEqual(['a', ...before.slice(0, 499)]);
  });

  it('読まれる 500 件の中にある掲載を公開待ちにしても、500 件の顔ぶれは変わらない (並びだけ変わる)', async () => {
    await seedLive();
    placeAt(40, 600);
    const before = index();
    expect((await patch({ url: NEW_URL }, status(404))).status).toBe(200);
    expect(index()).toEqual(['a', ...before.filter((id) => id !== 'a')]);
    expect(new Set(index().slice(0, 500))).toEqual(new Set(before.slice(0, 500)));
  });

  // 動かすのは「この CAS で公開待ちにした」ときだけ。
  it.each([
    ['URL を替えない編集 (確かめられない probe)', async () => patch({ description: 'paid v2' }, status(404))],
    ['照合が通った URL 変更', async () => patch({ url: NEW_URL }, gate402(SELLER))],
    ['照合が合わない URL 変更 (422・保存しない)', async () => patch({ url: NEW_URL }, gate402(OTHER))],
    ['モデレーションで隠された掲載の URL 変更', async () => {
      holder.store!.strings.set(resourceKey('a'), JSON.stringify({ ...stored(), hidden: true }));
      return patch({ url: NEW_URL }, status(404));
    }],
    ['すでに公開待ちの掲載の URL 変更', async () => {
      holder.store!.strings.set(resourceKey('a'), JSON.stringify({ ...stored(), hidden: true, pendingFirstVerification: true }));
      return patch({ url: NEW_URL }, status(404));
    }],
    ['台帳にある URL への変更', async () => {
      holder.store!.strings.set(hiddenUrlLedgerKey(NEW_URL), '1');
      return patch({ url: NEW_URL }, status(404));
    }],
  ] as const)('%s では index を触らない', async (_name, edit) => {
    await seedLive();
    placeAt(510);
    const before = index();
    await edit();
    expect(index()).toEqual(before);
  });
});

describe('すでに hidden の掲載には印を付けない (URL を替えるだけで復帰の条件が緩まない)', () => {
  const MODERATED = { hidden: true, verification: { ...VERIFIED, failures: 3 } };

  it('モデレーションで隠された掲載: 確かめられない URL へ替えても印なしの hidden のまま・ID の照会は 404・再検証は違反に数える', async () => {
    await seedLive(MODERATED);
    const result = await patch({ url: NEW_URL }, status(404));
    expect(result.status).toBe(200);
    expect(stored()).toMatchObject({ url: NEW_URL, hidden: true });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');
    expect(await getPublicResource('a')).toEqual({ ok: true, resource: null });

    // 印が無いので、合わない 402 は公開待ちの扱い (違反に数えない) にならず、確定違反に数えて台帳を立てる。
    expect(await reverifyAt('2026-11-12T10:00:00.000Z', gate402(OTHER))).toMatchObject({ ok: 0, violations: 1, restored: 0 });
    expect(stored()).toMatchObject({ hidden: true, verification: { failures: 1 } });
    expect(ledgerKeys()).toEqual([hiddenUrlLedgerKey(NEW_URL)]);
    expect(holder.warn).not.toHaveBeenCalledWith('x402.reverify.pending_gate_mismatch', expect.anything());
  });

  it('モデレーションで隠された掲載: 確かめられない URL との往復でも hidden を解除できない', async () => {
    await seedLive(MODERATED);
    await patch({ url: NEW_URL }, status(404));
    await patch({ url: OLD_URL }, status(404));
    expect(stored()).toMatchObject({ url: OLD_URL, hidden: true });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');
    expect(await publicIds()).toEqual([]);
    expect(await getPublicResource('a')).toEqual({ ok: true, resource: null });
  });

  it('台帳にある URL へ替えると、確かめられなくても台帳が勝つ (印なしの hidden)', async () => {
    await seedLive();
    holder.store!.strings.set(hiddenUrlLedgerKey(NEW_URL), '1');
    expect((await patch({ url: NEW_URL }, status(404))).status).toBe(200);
    expect(stored()).toMatchObject({ url: NEW_URL, hidden: true });
    expect(stored()).not.toHaveProperty('pendingFirstVerification');
    expect(await getPublicResource('a')).toEqual({ ok: true, resource: null });
  });
});
