// JPYC Service Monitor / Japan Stablecoin Payment Monitor の **応答 byte を凍結する golden** (R9a/R9b・2026-09-24)。
//
// 対象: 無料 teaser 2 本 (/api/jpyc/services/teaser・/api/stablecoin-payments/teaser) と有料 Monitor 4 本
// (JPYC 版 /api/paid/jpyc/services・/api/paid/stablecoin-payments = facilitator gate 経由、USDC 版
// /api/paid/usdc/jpyc/services・/api/paid/usdc/stablecoin-payments = test mode)。
//
// なぜ意味比較 (toEqual) では足りないか: 有料 Monitor は売っている商品で、キー順・省略と null の区別・
// 並び順が変わるだけで買い手エージェントの diff/dedupe が壊れ得る。既存の monitor/teaser test は構造と
// 振る舞いを見るもので、応答全体の byte は固定していない。ここでは **未整列の raw text の sha256** を固定する。
//
// データは固定の fixture (changelogData / data / paymentProviders を mock) — 週次更新で実データが
// 増えても本 golden は動かない。golden が落ちたら「応答を変えた」ことの証明であり、期待値を合わせて
// 通してはいけない (意図して wire を変える PR だけが更新してよい。理由を commit に書く)。
// 生成: GOLDEN_RECORD=<出力 path> で実行すると期待値を assert せず実測の map を書き出す。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { NextResponse } from 'next/server';

type FixtureEvent = Record<string, unknown>;
type FixtureEntry = { slug: string; sourceUrl: string } & Record<string, unknown>;

const fixture = vi.hoisted(() => ({
  changelog: [] as FixtureEvent[],
  entries: [] as FixtureEntry[],
  providers: [] as Record<string, unknown>[],
  snapshot: {} as Record<string, unknown> | null,
}));

vi.mock('@/lib/directory/changelogData', () => ({
  get MANUAL_CHANGELOG() {
    return fixture.changelog;
  },
  BASELINE_DATE: '2026-07-13',
}));
vi.mock('@/lib/directory/data', () => ({
  get DIRECTORY_ENTRIES() {
    return fixture.entries;
  },
}));
vi.mock('@/lib/directory/paymentProviders', async (original) => ({
  ...(await original<typeof import('@/lib/directory/paymentProviders')>()),
  get PAYMENT_PROVIDERS() {
    return fixture.providers;
  },
}));
vi.mock('@/lib/directory/verification', () => ({
  readDirectoryVerificationSnapshot: async () => fixture.snapshot,
}));

const paidMocks = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn(), lookup: vi.fn(), promote: vi.fn() }));
vi.mock('@/app/api/facilitator/verify/route', () => ({ POST: paidMocks.verify }));
vi.mock('@/app/api/facilitator/settle/route', () => ({ POST: paidMocks.settle }));
vi.mock('@/lib/x402/paymentRedelivery', async (original) => ({
  ...(await original<typeof import('@/lib/x402/paymentRedelivery')>()),
  lookupPaymentRedelivery: paidMocks.lookup,
  claimPaymentRedelivery: async () => ({ kind: 'unavailable' }),
  promotePaymentRedelivery: paidMocks.promote,
}));

const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const JPYC_AMOY = getAddress('0x00000000000000000000000000000000000Ca11a');
const SETTLEMENT = { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:80002', payer: SELLER };
const NOW = '2026-09-24T03:04:05.678Z';

function entry(slug: string, status: string, extra: { tokens?: string[]; chains?: string[]; nameJa?: string } = {}): FixtureEntry {
  return {
    slug,
    name: `Name ${slug}`,
    nameJa: extra.nameJa ?? '',
    status,
    sourceUrl: `https://example.com/${slug}`,
    sourceType: 'official',
    verifiedAt: '2026-07-13',
    updatedAt: '2026-07-13',
    attribution: `Attr ${slug.length % 2}`,
    facts: {
      description: 'd',
      category: 'payment',
      tags: [],
      tokens: extra.tokens ?? ['jpyc'],
      chains: extra.chains ?? ['polygon'],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: (extra.tokens ?? []).includes('usdc'),
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: { summaryJa: 's', summaryEn: 's' },
  };
}

function provider(name: string, announcedAt: string, slug?: string): Record<string, unknown> {
  return {
    provider: name,
    ...(slug ? { slug } : {}),
    stage: 'pilot',
    assets: ['JPYC'],
    chains: [],
    settlementCurrency: null,
    merchantFee: null,
    integrations: [],
    posIntegration: null,
    region: 'Japan',
    announcedAt,
    startedAt: null,
    plannedPeriod: null,
    sourceUrl: `https://example.com/p/${name.length}`,
    verifiedAt: '2026-08-01',
  };
}

// 小さな履歴: backfill (collectedAt > date)・同じ実効日の複数イベント・複数スコープのイベント・
// slug だけのイベント (有料版は entry から provider/assets/chains を投影するが teaser は投影しない)・
// archived の removed・別スコープの 'added' が baseline を消す癖、を含む。
const SMALL_CHANGELOG: FixtureEvent[] = [
  { date: '2026-07-01', scopes: ['stablecoin-payments'], provider: 'Alpha Pay', changeType: 'added', changeCategory: 'partnership', assets: ['JPYC'], summary: 'Alpha added.', summaryJa: 'Alpha 追加。', sourceUrl: 'https://example.com/alpha' },
  { date: '2026-07-13', collectedAt: '2026-08-20', scopes: ['jpyc-services'], slug: 'svc-b', changeType: 'updated', changeCategory: 'chains_change', summary: 'B chains.', summaryJa: 'B チェーン。', diffs: [{ field: 'chains', previousValue: ['polygon'], currentValue: ['polygon', 'kaia'] }] },
  { date: '2026-08-10', scopes: ['stablecoin-payments'], slug: 'svc-a', changeType: 'added', changeCategory: 'service_launch', summary: 'A launched.', summaryJa: 'A 開始。' },
  { date: '2026-08-10', scopes: ['jpyc-services', 'stablecoin-payments'], slug: 'svc-a', changeType: 'updated', summary: 'A updated.', summaryJa: 'A 更新。', sourceUrl: 'https://example.com/a-news' },
  { date: '2026-08-12', collectedAt: '2026-08-20', scopes: ['stablecoin-payments'], provider: 'Beta Wallet', changeType: 'updated', changeCategory: 'fee_change', assets: ['USDC'], chains: ['base'], summary: 'Beta fee.', summaryJa: 'Beta 手数料。', sourceUrl: 'https://example.com/beta', diffs: [{ field: 'fee', previousValue: '1%', currentValue: '0.5%', effectiveAt: '2026-09-01' }] },
  { date: '2026-08-20', scopes: ['jpyc-services'], slug: 'svc-c', changeType: 'verified', summary: 'C verified.', summaryJa: 'C 再確認。' },
  { date: '2026-08-25', scopes: ['stablecoin-payments'], provider: 'Alpha Pay', changeType: 'verified', assets: ['JPYC'], summary: 'Alpha verified.', summaryJa: 'Alpha 再確認。', sourceUrl: 'https://example.com/alpha' },
  { date: '2026-08-26', collectedAt: '2026-08-26', scopes: ['jpyc-services'], slug: 'svc-gone', changeType: 'removed', summary: 'Gone removed.', summaryJa: 'Gone 削除。' },
];
const SMALL_ENTRIES: FixtureEntry[] = [
  entry('svc-a', 'published', { tokens: ['usdc', 'jpyc'], chains: ['base', 'polygon'], nameJa: 'A 社' }),
  entry('svc-b', 'published'),
  entry('svc-c', 'published'),
  entry('svc-d', 'published'),
  entry('svc-gone', 'archived'),
];
const SMALL_PROVIDERS = [provider('Alpha Pay', '2026-07-01'), provider('Beta Wallet', '2026-08-12'), provider('Name svc-a', '2026-08-10', 'svc-a'), provider('Gamma', '2026-06-01')];

// 有料版の上限 (SERVICE_MONITOR_MAX_LIMIT=200) を超える履歴: baseline 250 件 (全て 2026-07-13) +
// date は古いが記録は最新の backfill。snapshot view (date 順の末尾 200 件) から backfill が落ちても、
// teaser の latestRecordedAt/totalEvents は全履歴から出ることを固定する。
const LONG_CHANGELOG: FixtureEvent[] = [
  { date: '2026-01-05', collectedAt: '2026-09-10', scopes: ['jpyc-services', 'stablecoin-payments'], slug: 'syn-001', changeType: 'updated', summary: 'Old news recorded late.', summaryJa: '古い発表を後から記録。' },
  ...SMALL_CHANGELOG,
];
const LONG_ENTRIES: FixtureEntry[] = [
  ...SMALL_ENTRIES,
  ...Array.from({ length: 250 }, (_, i) => entry(`syn-${String(i).padStart(3, '0')}`, 'published')),
];

const HISTORIES = {
  small: { changelog: SMALL_CHANGELOG, entries: SMALL_ENTRIES, providers: SMALL_PROVIDERS },
  empty: { changelog: [], entries: [], providers: [] },
  long: { changelog: LONG_CHANGELOG, entries: LONG_ENTRIES, providers: SMALL_PROVIDERS },
} as const;
type HistoryName = keyof typeof HISTORIES;

const QUERIES = [
  '',
  '?limit=2',
  '?changedSince=2020-01-01',
  '?changedSince=2020-01-01&limit=1',
  '?changedSince=2026-08-10',
  '?changedSince=2026-08-11&limit=1',
  '?changedSince=2026-08-20',
  '?changedSince=2026-08-21',
  '?changedSince=2026-09-11',
];

// 期待値 = 分割前 (origin b13da8c2 のロジック) で記録した raw text の sha256 (GOLDEN_RECORD で生成)。
const GOLDEN: Record<string, string> = {
  'empty /api/jpyc/services/teaser':
    'b824d113487f6e33fd43b8adfd1578d3194aaa8e44ef6e652f2cb9c3178e66ad',
  'empty /api/paid/usdc/jpyc/services':
    'c048e3a79d15174fce1fbf989b3ae866b2540bce152c33d55a21e2686fc1b0e0',
  'empty /api/paid/usdc/jpyc/services?changedSince=2020-01-01':
    '24037fc08998a5b8b54acb3c29a828d9971b135e916f123ff38505f751668f13',
  'empty /api/paid/usdc/jpyc/services?changedSince=2020-01-01&limit=1':
    '40a581abe878607a8156eace54d8edd8f8d001cdb63c21b658df4f674e5aa13d',
  'empty /api/paid/usdc/jpyc/services?changedSince=2026-08-10':
    '8f82115bd4bcc79d7b6e4bc636f5e24eee63d7b0e11c4f25501083eee17cba56',
  'empty /api/paid/usdc/jpyc/services?changedSince=2026-08-11&limit=1':
    'a6b69318601254083c1b75876738a77734f9e70772de513feb88ad8267939d0a',
  'empty /api/paid/usdc/jpyc/services?changedSince=2026-08-20':
    '878838d555a468a83cc502848f1a1ffd96b4a45f292338cf1d85218243c6dbc4',
  'empty /api/paid/usdc/jpyc/services?changedSince=2026-08-21':
    'f78855c545a77a509efb3e5f80bf8ff07ed6b9339fa0b5d0caa900dcd68b56b9',
  'empty /api/paid/usdc/jpyc/services?changedSince=2026-09-11':
    'f1bd78027182cbce24238b31983f021f6704acbe885249f1c356ff6a5c1a0868',
  'empty /api/paid/usdc/jpyc/services?limit=2':
    'd20cf6121626b616cffefdbc60e1755a169e45e81d2232883624f99400295d2b',
  'empty /api/paid/usdc/stablecoin-payments':
    'e9547ec9c422b1251a1145acded3f2a40af4714f68070a4fb656b77133b8b66f',
  'empty /api/paid/usdc/stablecoin-payments?changedSince=2020-01-01':
    '26322abe02d2757a197cbca6fb72de8f05ab5a45f7b07ee3cb0ba77e53ded85a',
  'empty /api/paid/usdc/stablecoin-payments?changedSince=2020-01-01&limit=1':
    'f461365d898153c417dc32c262d6ab8bd1d1a72f91de8bbbf05344a7e3379231',
  'empty /api/paid/usdc/stablecoin-payments?changedSince=2026-08-10':
    '7ca50629875035af04530ccfec7c806b82542af21c04376ec74e22f0bd97c520',
  'empty /api/paid/usdc/stablecoin-payments?changedSince=2026-08-11&limit=1':
    'f4a0441f4e0f5c058ce93f589619a83dd1d3a5fe141a0be73541c5fdcecff425',
  'empty /api/paid/usdc/stablecoin-payments?changedSince=2026-08-20':
    '06ea844189d1f88ffaa3e20808a4cf3c2c58a6f3f82132f492528f106f5c1d2a',
  'empty /api/paid/usdc/stablecoin-payments?changedSince=2026-08-21':
    'ef400b3dc9af6373cf3112874a3eb7ce79d7518aa00174c35f87b52e67486e66',
  'empty /api/paid/usdc/stablecoin-payments?changedSince=2026-09-11':
    'eeb25f06065cebb52637a619a94dc1743f721ed2e62eeb7e5b4041c79cf821f0',
  'empty /api/paid/usdc/stablecoin-payments?limit=2':
    '1311e01f9f865b10d25a8c42cda706e40309b63d59a7d643e56da8e1a6e1f0f3',
  'empty /api/stablecoin-payments/teaser':
    'b8e66b10e1ccb728e2d7af82a0759e7d0642782613529f1b381f0b216a39fb6c',
  'long /api/jpyc/services/teaser':
    '49c70329b7dbc3da5a35ce6d327a7cef77a8819886452262c5243def37ca01e9',
  'long /api/paid/usdc/jpyc/services':
    '2c5b3cdaca49cc2255e41aca36887c6ea7ac0ff9e46488dbb74c889085303a4d',
  'long /api/paid/usdc/jpyc/services?changedSince=2020-01-01':
    'afafd2958656f1ed62741b30035c84601b84c269a0d800d4b95af471846f58c6',
  'long /api/paid/usdc/jpyc/services?changedSince=2020-01-01&limit=1':
    '1a711f5ba8e232155c8887bc211931b1baf920fde0697544776a85e951b98006',
  'long /api/paid/usdc/jpyc/services?changedSince=2026-08-10':
    '8566cefb8bc9dd0e33151823021c7199b450a744b95e27422f9683c6af757a92',
  'long /api/paid/usdc/jpyc/services?changedSince=2026-08-11&limit=1':
    'c965c63c2ca17cb045d3f1cb9765c53781c4afc0876155481fc287f01747e7c1',
  'long /api/paid/usdc/jpyc/services?changedSince=2026-08-20':
    '4e39c85d42d5999bef937cfb485e429375109ef7f0285a66961532fc451622ca',
  'long /api/paid/usdc/jpyc/services?changedSince=2026-08-21':
    'eb24c8544706d8e30dd63f5557e22117d3a8422fc79a81e52a71a5ba4bdd0a41',
  'long /api/paid/usdc/jpyc/services?changedSince=2026-09-11':
    '4a14550685f3b1fe3b30789528a0de3bef432d9e300ea7bf2d11a80eeb738242',
  'long /api/paid/usdc/jpyc/services?limit=2':
    '30072bc8583efc1356e1cdee27b3b933da38274eb16191a3d51b08d6e8a13edc',
  'long /api/paid/usdc/stablecoin-payments':
    '9aa903c65067f5c972585d5114790fdf4a2e3a486113b6febf6f1f3ee4745934',
  'long /api/paid/usdc/stablecoin-payments?changedSince=2020-01-01':
    'b1c2af66f81073492f1eab46ce71592a09bf70245120b6589527dae000d8e4c1',
  'long /api/paid/usdc/stablecoin-payments?changedSince=2020-01-01&limit=1':
    'c6841f0413e547fcb06cbbf786da3623962b442c658099b35e0c2ff9fc4bcc2f',
  'long /api/paid/usdc/stablecoin-payments?changedSince=2026-08-10':
    'b50fbddd998f3ea8d5c262c82fb564744490e2b579607b52481532461d88c451',
  'long /api/paid/usdc/stablecoin-payments?changedSince=2026-08-11&limit=1':
    'f0d568090b4a01acddec443929fb1082181220db95f3a86b45ed9d7c6ff00140',
  'long /api/paid/usdc/stablecoin-payments?changedSince=2026-08-20':
    'd8a2e4b349104d391319c654d3efe34fa554aa81ed48c02cf1bb62086a76a60a',
  'long /api/paid/usdc/stablecoin-payments?changedSince=2026-08-21':
    '7af09af43177d3801a0ad15c5e8d6d92de4e46eb8f23791315e1d3c4c8032854',
  'long /api/paid/usdc/stablecoin-payments?changedSince=2026-09-11':
    'c45663696754d6a90ff51f9243ae85a992e257954f6c325166781480c7a5d661',
  'long /api/paid/usdc/stablecoin-payments?limit=2':
    '7bf4363670d9b811ad2b3f17103f1f8fdafbec18fa4133cee1063f342a6c6106',
  'long /api/stablecoin-payments/teaser':
    '169c41a21f67fddb9d9a8e6c7f9dbfc8b3dbbc964073bd6bf821841153dbedf9',
  'small /api/jpyc/services/teaser':
    '7ac96b885cc88c63a6d2a5b4bfb618559009d7526d5c08e94dc9a210ff0e46eb',
  'small /api/paid/usdc/jpyc/services':
    'ebe12c47e90a4551d146db265c9319c37e60718c6e5cb17a81981fefe7dcfad9',
  'small /api/paid/usdc/jpyc/services?changedSince=2020-01-01':
    '29740f3a13e65c0b67394e3cfc17c5a0db4777c079bb9e517b1b15502844758b',
  'small /api/paid/usdc/jpyc/services?changedSince=2020-01-01&limit=1':
    'c33cb3386eab1cfdea85355e901e1accaa2e8f4f014881f6d636f2daaf51e7c6',
  'small /api/paid/usdc/jpyc/services?changedSince=2026-08-10':
    '001be34f726a1c2c5033f4d07b91bd72b36ebb6042e83c74a829cb5ee7401212',
  'small /api/paid/usdc/jpyc/services?changedSince=2026-08-11&limit=1':
    '798ea1580b6e744082cd2bed7b82952917eaac7735784789c853221b1126c6ce',
  'small /api/paid/usdc/jpyc/services?changedSince=2026-08-20':
    '64cafbffd842cbd384c713c79cbba72431e49c9b07f5f07478e0331f90821835',
  'small /api/paid/usdc/jpyc/services?changedSince=2026-08-21':
    '56dda43fdcd263dfc91ef485002d735944b627cde5771f251e99be7a6ee9b270',
  'small /api/paid/usdc/jpyc/services?changedSince=2026-09-11':
    'c2c42e31c3016926fd123b9d3a8e403a3ca4d6e1d3a8fe4b24088662f50807dd',
  'small /api/paid/usdc/jpyc/services?limit=2':
    'dcb2a2364806f51eca814ca7b59c68700e58b453430cdb28b999a21f900a0b47',
  'small /api/paid/usdc/stablecoin-payments':
    '3a81c6e0b03c43a7c5df23442a30daae905bb71d13e60339a70247282777420e',
  'small /api/paid/usdc/stablecoin-payments?changedSince=2020-01-01':
    'c42bec3bace5c80872703d4e90646c4b41f584bd5d8ce520d201a6b9c6c4d69d',
  'small /api/paid/usdc/stablecoin-payments?changedSince=2020-01-01&limit=1':
    '352f380ef116ee906454a33e86108b75b5303f2c4388b6223ff0026cd2419e85',
  'small /api/paid/usdc/stablecoin-payments?changedSince=2026-08-10':
    'f6f5f95ba8c6f416a6c9526e3b7ded874c2bb5695311c881b77b32b53be63b7a',
  'small /api/paid/usdc/stablecoin-payments?changedSince=2026-08-11&limit=1':
    '0aa736786af7e27e87e39ca5edda93e1b558189a2aa8e84124fa8ad34c90243b',
  'small /api/paid/usdc/stablecoin-payments?changedSince=2026-08-20':
    '48df98b3202d5d76d616d3abcc17e737f39087da3d3e621c1ff663ae0ae1a1b4',
  'small /api/paid/usdc/stablecoin-payments?changedSince=2026-08-21':
    '0654539bb913b9943c41e47a2a7792528f1837d4631bf1a4424925ceb216b29b',
  'small /api/paid/usdc/stablecoin-payments?changedSince=2026-09-11':
    '8961f0650836b88f4c580149355acd4d2d00fdab89d88d9bd18aa2393c971869',
  'small /api/paid/usdc/stablecoin-payments?limit=2':
    '8149806b3135aead3dc9b5080441151327c19dbfb57f1b0c722e6407936a2416',
  'small /api/stablecoin-payments/teaser':
    'f1ad9474e0de4c4218a0d718fd21eb1562aeafd94d6d2f1ecd2084fa499bd998',
};

type Route = { GET: (req?: Request) => Promise<Response> };
const ROUTES: Record<string, () => Promise<unknown>> = {
  '/api/jpyc/services/teaser': () => import('@/app/api/jpyc/services/teaser/route'),
  '/api/stablecoin-payments/teaser': () => import('@/app/api/stablecoin-payments/teaser/route'),
  '/api/paid/usdc/jpyc/services': () => import('@/app/api/paid/usdc/jpyc/services/route'),
  '/api/paid/jpyc/services': () => import('@/app/api/paid/jpyc/services/route'),
  '/api/paid/usdc/stablecoin-payments': () => import('@/app/api/paid/usdc/stablecoin-payments/route'),
  '/api/paid/stablecoin-payments': () => import('@/app/api/paid/stablecoin-payments/route'),
};
const actual: Record<string, string> = {};

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function useHistory(name: HistoryName): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const h = HISTORIES[name];
  fixture.changelog = [...h.changelog];
  fixture.entries = [...h.entries];
  fixture.providers = [...h.providers];
  // 検証スナップショット: 一致 (ok:true) / sourceUrl 不一致 (行では null になる) / 判定不能 (ok:null)。
  fixture.snapshot = h.entries.length > 0
    ? {
      'svc-a': { checkedAt: '2026-09-20T00:00:00.000Z', ok: true, sourceUrl: 'https://example.com/svc-a' },
      'svc-b': { checkedAt: '2026-09-20T00:00:00.000Z', ok: false, sourceUrl: 'https://mismatch.example/' },
      'svc-c': { checkedAt: '2026-09-21T00:00:00.000Z', ok: null, sourceUrl: 'https://example.com/svc-c' },
    }
    : {};
  paidMocks.verify.mockImplementation(async () => NextResponse.json({ isValid: true, payer: SELLER }));
  paidMocks.settle.mockImplementation(async () => NextResponse.json(SETTLEMENT));
  paidMocks.lookup.mockResolvedValue({ kind: 'missing' });
  paidMocks.promote.mockResolvedValue({ kind: 'unavailable' });
}

async function load(path: string, rail: 'free' | 'usdc' | 'jpyc'): Promise<Route> {
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '1');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  if (rail === 'usdc') {
    vi.stubEnv('X402_NETWORK', 'base');
    vi.stubEnv('X402_TEST_MODE', 'true');
  }
  if (rail === 'jpyc') {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
    vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
    vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
    vi.stubEnv('X402_FEE_BPS', '100');
    vi.stubEnv('X402_FEE_FLOOR_JPYC', '1');
  }
  vi.resetModules();
  return (await ROUTES[path]()) as unknown as Route;
}

/** JPYC 版は facilitator gate を通して content を得る (verify/settle は mock)。 */
async function paidJpyc(route: Route, url: string): Promise<Response> {
  const challenge = await route.GET(new Request(url));
  expect(challenge.status).toBe(402);
  const required = JSON.parse(Buffer.from(challenge.headers.get('PAYMENT-REQUIRED')!, 'base64').toString());
  const payload = {
    signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}21b`,
    authorization: { from: SELLER, validAfter: '0', validBefore: '9999999999', intentSalt: `0x${'22'.repeat(32)}` },
  };
  const payment = { x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload };
  return route.GET(new Request(url, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') } }));
}

function pin(key: string, text: string): void {
  actual[key] = sha(text);
  if (process.env.GOLDEN_RECORD) return;
  expect(actual[key], `${key}\n${text}`).toBe(GOLDEN[key]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
  if (process.env.GOLDEN_RECORD) {
    const sorted = Object.fromEntries(Object.keys(actual).sort().map((k) => [k, actual[k]]));
    writeFileSync(process.env.GOLDEN_RECORD, JSON.stringify(sorted, null, 2));
  }
});

describe.each(Object.keys(HISTORIES) as HistoryName[])('monitor wire golden (%s history)', (history) => {
  it.each([
    ['/api/jpyc/services/teaser'],
    ['/api/stablecoin-payments/teaser'],
  ])('teaser %s', async (path) => {
    useHistory(history);
    const route = await load(path, 'free');
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=300, stale-while-revalidate=600');
    pin(`${history} ${path}`, await res.text());
  });

  it.each([
    ['/api/paid/usdc/jpyc/services', '/api/paid/jpyc/services'],
    ['/api/paid/usdc/stablecoin-payments', '/api/paid/stablecoin-payments'],
  ])('paid %s (JPYC 版 %s と byte 一致)', async (usdcPath, jpycPath) => {
    useHistory(history);
    const usdc = await load(usdcPath, 'usdc');
    const usdcTexts: string[] = [];
    for (const qs of QUERIES) {
      const res = await usdc.GET(new Request(`https://open-pay.jp${usdcPath}${qs}`));
      expect(res.status).toBe(200);
      const text = await res.text();
      usdcTexts.push(text);
      pin(`${history} ${usdcPath}${qs}`, text);
    }
    // JPYC 版は同じ envelope を別の支払い経路で返す = content の byte は USDC 版と同一でなければならない。
    const jpyc = await load(jpycPath, 'jpyc');
    for (const [i, qs] of QUERIES.entries()) {
      const res = await paidJpyc(jpyc, `https://open-pay.jp${jpycPath}${qs}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(usdcTexts[i]);
    }
  });
});

// 読める形の補助 assert (golden の sha だけでは意図が読めないので、R9b で守る区別を明示する)。
describe('teaser の意味 (small history)', () => {
  it('stablecoin teaser は scope を除いた raw event を返す — 有料版の provider 投影行とは別物', async () => {
    useHistory('small');
    const teaser = await (await (await load('/api/stablecoin-payments/teaser', 'free')).GET()).json();
    const paid = await (await (await load('/api/paid/usdc/stablecoin-payments', 'usdc')).GET(
      new Request('https://open-pay.jp/api/paid/usdc/stablecoin-payments'),
    )).json();
    // 実効日順 (08-10 A updated → 08-20 Beta (backfill) → 08-25 Alpha verified) の末尾 3 件。
    expect(teaser.latestChanges.map((e: { date: string }) => e.date)).toEqual(['2026-08-10', '2026-08-12', '2026-08-25']);
    const rawA = teaser.latestChanges[0];
    expect(rawA).toEqual({ date: '2026-08-10', slug: 'svc-a', changeType: 'updated', summary: 'A updated.', summaryJa: 'A 更新。', sourceUrl: 'https://example.com/a-news' });
    const rowA = paid.changes.find((c: { date: string; changeType: string }) => c.date === '2026-08-10' && c.changeType === 'updated');
    expect(rowA).toMatchObject({ provider: 'Name svc-a', assets: ['USDC', 'JPYC'], chains: ['base', 'polygon'] });
    expect(rowA).not.toHaveProperty('slug');
    expect(teaser.latestRecordedAt).toBe('2026-08-25');
    expect(teaser.totalEvents).toBe(paid.totalEvents);
    expect(teaser.totalEvents).toBe(5);
  });

  it('jpyc teaser: 同じ実効日のイベントは changelog 順のまま・latestRecordedAt は backfill の記録日', async () => {
    useHistory('small');
    const teaser = await (await (await load('/api/jpyc/services/teaser', 'free')).GET()).json();
    expect(teaser.latestChanges.map((e: { slug: string; date: string }) => `${e.slug}|${e.date}`)).toEqual([
      'svc-b|2026-07-13',
      'svc-c|2026-08-20',
      'svc-gone|2026-08-26',
    ]);
    expect(teaser.latestRecordedAt).toBe('2026-08-26');
    for (const event of teaser.latestChanges) expect(event).not.toHaveProperty('scopes');
  });

  it('long history: 有料 snapshot view から落ちる backfill でも teaser は全履歴から最新と数える', async () => {
    useHistory('long');
    const teaser = await (await (await load('/api/jpyc/services/teaser', 'free')).GET()).json();
    const paid = await (await (await load('/api/paid/usdc/jpyc/services', 'usdc')).GET(
      new Request('https://open-pay.jp/api/paid/usdc/jpyc/services'),
    )).json();
    expect(paid.hasMore).toBe(true);
    expect(paid.changes).toHaveLength(200);
    expect(paid.changes.some((c: { slug: string; date: string }) => c.slug === 'syn-001' && c.date === '2026-01-05')).toBe(false);
    expect(teaser.totalEvents).toBeGreaterThan(200);
    expect(teaser.latestRecordedAt).toBe('2026-09-10');
    expect(teaser.latestChanges.at(-1)).toMatchObject({ slug: 'syn-001', date: '2026-01-05', collectedAt: '2026-09-10' });
  });

  it('empty history: latestChanges [] / latestRecordedAt null / totalEvents 0', async () => {
    useHistory('empty');
    for (const path of ['/api/jpyc/services/teaser', '/api/stablecoin-payments/teaser']) {
      const body = await (await (await load(path, 'free')).GET()).json();
      expect(body.latestChanges).toEqual([]);
      expect(body.latestRecordedAt).toBeNull();
      expect(body.totalEvents).toBe(0);
    }
  });
});
