// @vitest-environment node
// lib/x402/purchaseIntent.ts (facade) の分割 (R3a〜d) 前後で変えてはいけない wire を固定する。
// 期待値は分割前のコード (origin/main 7fe944c3) で採取した snapshot。抽出に合わせて作り直さない。
//   - facade の実行時 export 一覧
//   - KV key 文字列と intentSalt 判定
//   - 13 本の Lua 呼び出しの script 名 (SHA)・KEYS・ARGV の順序と中身 (保存 JSON の property 順を含む)
//   - 保存 record の parser (intent / ownership / purchase record) の出力 (property 順) と拒否
// Lua 本文の byte 同一性は tests/lib/license/digitalCompatibility.test.ts が別に固定する。
// 末尾の 'module structure' だけは分割後に足した構造フェンス (分割先 → facade の逆向き import 禁止など)。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import fixture from '../../fixtures/x402/purchaseIntent.json';

const h = vi.hoisted(() => ({
  reads: new Map<string, (string | null)[]>(),
  gets: [] as string[],
  sets: [] as unknown[][],
  evals: [] as { name: string; keys: string[]; args: string[] }[],
  replies: new Map<string, unknown>(),
  kvGet: vi.fn(), kvSet: vi.fn(), kvEval: vi.fn(), warn: vi.fn(),
  client: { readContract: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getLogs: vi.fn(), getTransactionReceipt: vi.fn() },
}));
vi.mock('node:crypto', async (original) => ({
  ...await original<typeof import('node:crypto')>(),
  // attemptId / reconcile lease id / newPurchaseIntentSalt を決定的にする。
  randomBytes: (size: number) => Buffer.alloc(size, 0xcd),
}));
vi.mock('@/lib/kv', () => ({ kvGet: h.kvGet, kvSet: h.kvSet, kvEval: h.kvEval }));
vi.mock('@/lib/logger', () => ({ logger: { warn: h.warn } }));
vi.mock('@/lib/chains', () => ({ chainObjectForId: () => ({}), transportForChain: () => ({}) }));
// license 商品 (h_ id) だけ実物と同じ contentRef 形式にする (license 定義の contentRef と一致させるため)。
// 既存 fixture ('creator-item') の key は従来どおりで、既存 snapshot は変わらない。
vi.mock('@/lib/x402/hostedStore', () => ({
  hostedContentKey: (id: string, rev: number) =>
    id.startsWith('h_') ? `x402:hosted:${id}:content:${rev}` : `store:hosted:content:${id}:${rev}`,
}));
// license 経路 (licenseLuaVariant + ARGV[#ARGV] の context) を通すため flag だけ ON にする。
// 既存の digital fixture は productKind を持たないので、この flag を参照しない。
vi.mock('@/lib/license/config', async (original) => ({
  ...await original<typeof import('@/lib/license/config')>(),
  licenseNftEnabled: () => true,
}));
vi.mock('@/lib/x402/facilitatorSettle', () => ({ parseFacilitatorRequest: vi.fn() }));
vi.mock('@/lib/x402/paymentRedelivery', () => ({ paymentRedeliveryIdentity: vi.fn() }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => h.client }));

import * as facade from '@/lib/x402/purchaseIntent';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { createLicenseDefinition } from '@/lib/license/definition';
import { licenseLuaVariant } from '@/lib/license/stock';
import { JPYC_V3_ASSET } from '@/lib/x402/types';
import {
  checkPurchaseQuoteRateLimit, claimPurchaseSettlement, claimSignedPurchaseIntent,
  createQuotedPurchaseIntent, finalizeHostedPurchase, hostedPurchaseRecordKey,
  isPurchaseIntentSalt, listPendingPurchaseIntents, markPurchaseFailedPrebroadcast,
  markPurchaseIndeterminate, newPurchaseIntentSalt, parseHostedPurchaseRecord,
  parsePurchaseIntent, parsePurchaseOwnership, purchaseIntentKey, purchaseLibraryKey,
  purchaseOwnershipKey, purchasePendingIndexKey, reconcilePendingPurchases,
  reconcilePurchaseIntent, recordPurchaseTransaction,
  type PurchaseAuthorizationClaim, type PurchaseReconcileChain, type QuotedPurchaseIntent,
  type SettledPurchaseIntent, type SettlingPurchaseIntent, type SignedPurchaseIntent,
} from '@/lib/x402/purchaseIntent';

// digitalCompatibility.test.ts と同じ SHA-256 (script 本文) → 定数名。未知の script は UNKNOWN で落ちる。
const SCRIPT_NAMES: Record<string, string> = {
  '0baade60485a021d23ba6d27acc8f7ac52ceed14f3bf3b80c914e84fd9f19113': 'QUOTE_RATE_LIMIT',
  '341bec0178e7032279f3879a8b21b89cf9c6f84803443372af8f9bc07721921a': 'CLAIM_SIGNED_INTENT',
  '7b201a3779490d00e2260c736f12237d6b65e10dfc567d9bb123533002e77c2a': 'CLAIM_SETTLEMENT',
  'd80ebc0fe8baa3a2b61ef2eecda30d688391262f69234f0cc42d656b907acee4': 'CAS_PENDING_INTENT',
  'a6bd96b8cd6205d8019322a7103f8b9a6744209955155265a6ca4eb921ebd989': 'RECORD_PURCHASE_TRANSACTION',
  '71eed7aacf97e5750e64f916f1a918c4621b54fc3074a38c7d537259125e9ec4': 'ADOPT_RECONCILED_TRANSACTION',
  'e65ef51e1e05ae2af000ef3ae409009e64b2f61294fdef04ad3a864190dde323': 'MARK_PURCHASE_INDETERMINATE',
  'b2d954adb5bb5ec8e57857782334dfe045f4907149dd8462975e586c180ee66b': 'MARK_PURCHASE_FAILED_PREBROADCAST',
  '423015d67f326783925405ba001608457f6334702fc72bdcb56ec65dc9f1449a': 'FINALIZE_PURCHASE',
  'd53af4dba82c29d6233a029895ada37af892fe301e51f013770d6dcc7578d294': 'READ_LIBRARY_SCORE',
  'ebc0aa83da3ec1d2b2a7d62bc3c0526e3960b1b028b6d41600faf1c75f63f8ee': 'LIST_PENDING_INTENTS',
  '2ed9113e68b2a73df3561f865523449aa8de3fae45416f8e27616eff1173b291': 'REMOVE_TERMINAL_PENDING_MEMBER',
  'fff5b143e7f894679d9c6f47f3f4e9261265c9236fcb45550e52b15fc53cb11d': 'QUARANTINE_PENDING_MEMBER',
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
// license 商品は licenseLuaVariant(digital script) を EVAL する (R3b で追加した pin)。内側の digital script を
// 取り出して SHA で名前を引き、production の wrapper で包み直すと元の script と byte 一致することまで確認する。
const LICENSE_OPEN = 'local function transition() ';
const LICENSE_CLOSE = ' end; local result=transition(); ';
function scriptName(script: string): string {
  const digital = SCRIPT_NAMES[sha256(script)];
  if (digital) return digital;
  const open = script.indexOf(LICENSE_OPEN);
  const close = script.lastIndexOf(LICENSE_CLOSE);
  if (open < 0 || close < open) return 'UNKNOWN';
  const inner = script.slice(open + LICENSE_OPEN.length, close);
  const name = SCRIPT_NAMES[sha256(inner)];
  return name && licenseLuaVariant(inner) === script ? `license(${name})` : 'UNKNOWN';
}

const quoted = fixture.quoted as QuotedPurchaseIntent;
const active = fixture.active as SettlingPurchaseIntent;
const settled = fixture.settled as SettledPurchaseIntent;
const signed = { ...active, state: 'signed' as const };
const SALT = active.intentSalt;
const TX = settled.txHash;
const OTHER_TX = `0x${'b'.repeat(64)}` as Hex;
const NOW = active.leaseUntil + 10_000;
const KEY = `store:intent:${SALT}`;
const OWN_KEY = `store:own:${active.claim.payer.toLowerCase()}:${active.resourceId}`;
const RECORD_KEY = `store:purchase:${active.chainId}:${TX}`;
const hash = (value: unknown) => sha256(JSON.stringify(value));

function reads(key: string, ...values: unknown[]) {
  h.reads.set(key, values.map((value) => value === null ? null : JSON.stringify(value)));
}
function chain(overrides: Partial<PurchaseReconcileChain> = {}): PurchaseReconcileChain {
  return {
    authorizationUsed: vi.fn(async () => true), latestBlock: vi.fn(async () => BigInt(active.anchorBlock)),
    authorizationUsedTransactions: vi.fn(async () => []), receiptMatches: vi.fn(async () => false),
    ...overrides,
  };
}
// 1 操作が発行した KV 呼び出しを、呼び出し順のまま 1 つの記録にまとめる。
function trace() {
  return { gets: [...h.gets], sets: h.sets.map((call) => [...call]), evals: h.evals.map((call) => ({ ...call })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reads.clear();
  h.gets.length = 0;
  h.sets.length = 0;
  h.evals.length = 0;
  h.replies.clear();
  h.kvGet.mockReset().mockImplementation(async (key: string) => {
    h.gets.push(key);
    const replies = h.reads.get(key);
    const value = replies && replies.length > 1 ? replies.shift()! : replies?.[0] ?? null;
    return { ok: true, value };
  });
  h.kvSet.mockReset().mockImplementation(async (...call: unknown[]) => {
    h.sets.push(call);
    return { ok: true, value: 'OK' };
  });
  h.kvEval.mockReset().mockImplementation(async (script: string, keys: string[], args: string[]) => {
    const name = scriptName(script);
    h.evals.push({ name, keys: [...keys], args: [...args] });
    return { ok: true, value: h.replies.has(name) ? h.replies.get(name) : 1 };
  });
  for (const mock of Object.values(h.client)) mock.mockReset();
});

describe('purchaseIntent facade exports', () => {
  it('keeps exactly the existing runtime exports', () => {
    expect(Object.keys(facade).sort()).toEqual([
      'PURCHASE_DEPLOYMENT_VERSION', 'PURCHASE_EXPIRY_SAFETY_SEC', 'PURCHASE_INTENT_VERSION',
      'PURCHASE_QUOTE_GRACE_SEC', 'PURCHASE_QUOTE_IP_MAX', 'PURCHASE_QUOTE_RATE_WINDOW_SEC',
      'PURCHASE_QUOTE_RESOURCE_MAX', 'PURCHASE_QUOTE_TTL_SEC', 'PURCHASE_QUOTE_WALLET_MAX',
      'PURCHASE_RECONCILE_BATCH_SIZE', 'PURCHASE_RECONCILE_LEASE_SEC', 'PURCHASE_RECONCILE_MAX_PAGES',
      'PURCHASE_RECONCILE_PAGE_BLOCKS', 'PURCHASE_RECONCILE_RETRY_MS', 'PURCHASE_REVISION_POLICY',
      'PURCHASE_SETTLEMENT_LEASE_SEC', 'buildPurchaseAuthorizationClaim', 'checkPurchaseQuoteRateLimit',
      'claimPurchaseSettlement', 'claimSignedPurchaseIntent', 'createQuotedPurchaseIntent',
      'defaultPurchaseReconcileChain', 'extractPurchaseIntentSalt', 'finalizeHostedPurchase',
      'getPurchaseIntent', 'hostedPurchaseRecordKey', 'isPurchaseIntentSalt',
      'listPendingPurchaseIntents', 'markPurchaseFailedPrebroadcast', 'markPurchaseIndeterminate',
      'newPurchaseIntentSalt', 'parseHostedPurchaseRecord', 'parsePurchaseIntent',
      'parsePurchaseOwnership', 'purchaseAuthorizationMatches', 'purchaseIntentKey',
      'purchaseLibraryKey', 'purchaseOwnershipKey', 'purchasePendingIndexKey',
      'readPurchaseAnchorBlock', 'readSettledPurchaseAccess', 'reconcilePendingPurchases',
      'reconcilePurchaseIntent', 'recordPurchaseTransaction',
    ]);
  });

  it('keeps every exported constant value', () => {
    const constants = Object.fromEntries(Object.entries(facade)
      .filter(([name]) => name.startsWith('PURCHASE_'))
      .map(([name, value]) => [name, typeof value === 'bigint' ? `${value}n` : value]));
    expect(constants).toMatchSnapshot();
  });
});

describe('purchase KV keys and intentSalt identity', () => {
  it('keeps key strings (lower-casing only the address / salt / txHash parts)', () => {
    const mixedSalt = `0x${'Ab'.repeat(32)}`;
    const mixedPayer = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    expect({
      intent: purchaseIntentKey(mixedSalt),
      pending: purchasePendingIndexKey(),
      ownership: purchaseOwnershipKey(mixedPayer, 'Res-ID_1'),
      library: purchaseLibraryKey(mixedPayer),
      record: hostedPurchaseRecordKey(137, `0x${'Cd'.repeat(32)}`),
    }).toEqual({
      intent: `store:intent:0x${'ab'.repeat(32)}`,
      pending: 'store:intent:pending',
      ownership: 'store:own:0xabcdef0123456789abcdef0123456789abcdef01:Res-ID_1',
      library: 'store:lib:0xabcdef0123456789abcdef0123456789abcdef01',
      record: `store:purchase:137:0x${'cd'.repeat(32)}`,
    });
  });

  it('keeps the intentSalt predicate and generator', () => {
    const cases: [string, unknown][] = [
      ['lower', `0x${'a'.repeat(64)}`], ['upper', `0x${'A'.repeat(64)}`], ['upper-prefix', `0X${'a'.repeat(64)}`],
      ['short', `0x${'a'.repeat(63)}`], ['long', `0x${'a'.repeat(65)}`], ['non-hex', `0x${'g'.repeat(64)}`],
      ['no-prefix', 'a'.repeat(64)], ['number', 1], ['null', null], ['undefined', undefined],
    ];
    expect(Object.fromEntries(cases.map(([label, value]) => [label, isPurchaseIntentSalt(value)]))).toEqual({
      lower: true, upper: true, 'upper-prefix': true, short: false, long: false, 'non-hex': false,
      'no-prefix': false, number: false, null: false, undefined: false,
    });
    expect(newPurchaseIntentSalt()).toBe(`0x${'cd'.repeat(32)}`);
  });
});

describe('Lua call sites: script, KEYS and ARGV order', () => {
  it('quote creation (SET NX) and the quote rate limiter', async () => {
    await createQuotedPurchaseIntent({
      ...quoted, payer: quoted.payerHint, merchantValue: BigInt(quoted.merchantValue),
      feeValue: BigInt(quoted.feeValue), anchorBlock: BigInt(quoted.anchorBlock), now: quoted.createdAt,
    });
    await checkPurchaseQuoteRateLimit({ payer: active.claim.payer, resourceId: active.resourceId, ipHash: 'ip-hash' });
    await checkPurchaseQuoteRateLimit({ payer: active.claim.payer, resourceId: active.resourceId, ipHash: null });
    expect(trace()).toMatchSnapshot();
  });

  it('claimSignedPurchaseIntent (quoted → signed)', async () => {
    reads(KEY, quoted);
    await claimSignedPurchaseIntent({
      intentSalt: SALT, claim: active.claim, authorizationHash: hash(active.claim),
      reservationToken: 'reservation-token', now: quoted.createdAt + 1_000,
    });
    expect(trace()).toMatchSnapshot();
  });

  it('claimPurchaseSettlement (signed → settling)', async () => {
    reads(KEY, signed);
    await claimPurchaseSettlement({ intentSalt: SALT, claim: active.claim, now: active.settlementStartedAt });
    expect(trace()).toMatchSnapshot();
  });

  it('recordPurchaseTransaction / markPurchaseIndeterminate / markPurchaseFailedPrebroadcast', async () => {
    const input = { intentSalt: SALT, attemptId: active.attemptId, now: NOW };
    await recordPurchaseTransaction({ ...input, txHash: TX.toUpperCase().replace('0X', '0x') as Hex });
    await markPurchaseIndeterminate({ ...input, txHash: TX });
    await markPurchaseIndeterminate(input);
    await markPurchaseFailedPrebroadcast({ ...input, reason: 'prebroadcast_rejection' });
    expect(trace()).toMatchSnapshot();
  });

  it('finalizeHostedPurchase: first purchase (no ownership/record yet) and verified access read', async () => {
    reads(KEY, active, settled);
    reads(OWN_KEY, null, fixture.ownership);
    reads(RECORD_KEY, null, fixture.purchase);
    h.replies.set('READ_LIBRARY_SCORE', String(settled.settledAt));
    await finalizeHostedPurchase({ intentSalt: SALT, txHash: TX, settledAt: settled.settledAt });
    expect(trace()).toMatchSnapshot();
  });

  it('finalizeHostedPurchase: existing ownership/record are passed through as CAS inputs', async () => {
    reads(KEY, active, settled);
    reads(OWN_KEY, fixture.ownership);
    reads(RECORD_KEY, fixture.purchase);
    h.replies.set('READ_LIBRARY_SCORE', String(settled.settledAt));
    await finalizeHostedPurchase({ intentSalt: SALT, txHash: TX, settledAt: settled.settledAt });
    expect(trace()).toMatchSnapshot();
  });

  it('listPendingPurchaseIntents clamps the limit into ARGV', async () => {
    h.replies.set('LIST_PENDING_INTENTS', []);
    await listPendingPurchaseIntents(NOW, 7);
    await listPendingPurchaseIntents(NOW, 500);
    await listPendingPurchaseIntents(NOW, 0);
    expect(trace()).toMatchSnapshot();
  });

  it('reconcile: lease CAS then reschedule CAS when the authorization is unused', async () => {
    reads(KEY, active);
    await reconcilePurchaseIntent(SALT, { now: NOW, chain: chain({ authorizationUsed: vi.fn(async () => false) }) });
    expect(trace()).toMatchSnapshot();
  });

  it('reconcile: adopts a receipt-matched replacement hash under the lease', async () => {
    reads(KEY, { ...active, txHash: OTHER_TX }, { ...active, txHash: TX }, settled);
    reads(OWN_KEY, fixture.ownership);
    reads(RECORD_KEY, fixture.purchase);
    await reconcilePurchaseIntent(SALT, {
      now: NOW,
      chain: chain({
        authorizationUsedTransactions: vi.fn(async () => [TX]),
        receiptMatches: vi.fn(async (_intent, tx) => tx === TX),
      }),
    });
    expect(trace()).toMatchSnapshot();
  });

  it('reconcile: removes a terminal pending member and quarantines an invalid member', async () => {
    reads(KEY, quoted);
    await reconcilePurchaseIntent(SALT, { now: NOW, chain: chain() });
    h.replies.set('LIST_PENDING_INTENTS', ['invalid-salt']);
    await reconcilePendingPurchases({ now: NOW, limit: 3 });
    expect(trace()).toMatchSnapshot();
  });
});

// R3b で追加 (分割前のコード 86e98b1a で採取): license 商品の EVAL は licenseLuaVariant で包んだ script を使い、
// 末尾 ARGV (Lua 側の ARGV[#ARGV]) に licenseEvalContext の JSON を足す。claim/settle/fail/finalize の
// 4 hook について、包む script・KEYS・ARGV (末尾 context の JSON を含む) を固定する。
describe('license Lua call sites: licenseLuaVariant script and trailing ARGV[#ARGV] context', () => {
  const L_ID = `h_${'a'.repeat(32)}`;
  const L_SALT = `0x${'0'.repeat(63)}7` as Hex;
  const L_KEY = `store:intent:${L_SALT}`;
  const L_MERCHANT = '0x4444444444444444444444444444444444444444' as const;
  const L_FORWARDER = '0x3333333333333333333333333333333333333333' as const;
  const L_FEE = '0x5555555555555555555555555555555555555555' as const;
  const L_PAYER = '0x1111111111111111111111111111111111111111' as const;
  const L_TX = `0x${'e'.repeat(64)}` as Hex;
  const L_NOW = quoted.createdAt;
  const definition = createLicenseDefinition(L_ID, {
    supply: 2, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: 'v1',
  }, 80002, '0x6666666666666666666666666666666666666666');

  // 実際の関数を順に通し、各段で保存される JSON を次段の入力にする (KV は mock・EVAL は既定で 1 を返す)。
  async function licenseStates() {
    const q = await createQuotedPurchaseIntent({
      resourceId: L_ID, contentRevision: 1,
      metadata: {
        productKind: 'license', license: definition, owner: L_MERCHANT, payTo: L_MERCHANT,
        title: 'License', priceJpyc: '1000', contentKind: 'text', label: 'prompt',
      },
      payer: L_PAYER, token: JPYC_V3_ASSET.address, chainId: 80002, forwarder: L_FORWARDER,
      merchant: L_MERCHANT, merchantValue: 1000n * 10n ** 18n, feeReceiver: L_FEE,
      feeValue: 10n * 10n ** 18n, anchorBlock: 10000n, now: L_NOW, intentSalt: L_SALT,
    });
    if (!q.ok) throw new Error(`license quote: ${q.reason}`);
    const i = q.intent;
    const claim: PurchaseAuthorizationClaim = {
      payer: L_PAYER, token: i.token, chainId: i.chainId, forwarder: i.forwarder,
      commitVersion: i.commitVersion, merchant: i.merchant, merchantValue: i.merchantValue,
      feeReceiver: i.feeReceiver, feeValue: i.feeValue, validAfter: '0',
      validBefore: i.authorizationValidBeforeMax,
      nonce: buildForwarderNonce({
        from: i.payerHint, merchant: i.merchant, merchantValue: BigInt(i.merchantValue),
        feeReceiver: i.feeReceiver, feeValue: BigInt(i.feeValue), validAfter: 0n,
        validBefore: BigInt(i.authorizationValidBeforeMax), intentSalt: i.intentSalt,
      }, i.chainId, i.forwarder),
      signatureFingerprint: 'a'.repeat(64), resourceId: L_ID, contentRevision: 1,
      deploymentVersion: i.deploymentVersion, anchorBlock: i.anchorBlock,
    };
    return { quoted: i, claim };
  }
  const lastEval = (name: string) => h.evals.filter((call) => call.name === name).at(-1)!;

  it('claimSignedPurchaseIntent / claimPurchaseSettlement / markPurchaseFailedPrebroadcast (claim, settle, fail hooks)', async () => {
    const { quoted: q, claim } = await licenseStates();
    reads(L_KEY, q);
    expect(await claimSignedPurchaseIntent({
      intentSalt: L_SALT, claim, authorizationHash: hash(claim),
      reservationToken: 'reservation-token', now: L_NOW + 1_000,
    })).toMatchObject({ ok: true, kind: 'claimed' });
    const signedL = JSON.parse(lastEval('license(CLAIM_SIGNED_INTENT)').args[8]!) as SignedPurchaseIntent;
    reads(L_KEY, signedL);
    const settlingResult = await claimPurchaseSettlement({ intentSalt: L_SALT, claim, now: L_NOW + 2_000 });
    expect(settlingResult).toMatchObject({ ok: true, kind: 'claimed' });
    const settlingL = JSON.parse(lastEval('license(CLAIM_SETTLEMENT)').args[10]!) as SettlingPurchaseIntent;
    expect(await markPurchaseFailedPrebroadcast({
      intentSalt: L_SALT, attemptId: settlingL.attemptId, reason: 'prebroadcast_rejection',
      now: L_NOW + 3_000, licenseIntent: settlingL,
    })).toBe('updated');
    // licenseIntent を渡さない fail は digital script のまま (context なし)。
    await markPurchaseFailedPrebroadcast({
      intentSalt: L_SALT, attemptId: settlingL.attemptId, reason: 'prebroadcast_rejection', now: L_NOW + 3_000,
    });
    const snapshot = trace();
    expect(snapshot.evals.map((call) => call.name)).toEqual([
      'license(CLAIM_SIGNED_INTENT)', 'license(CLAIM_SETTLEMENT)',
      'license(MARK_PURCHASE_FAILED_PREBROADCAST)', 'MARK_PURCHASE_FAILED_PREBROADCAST',
    ]);
    // 末尾 ARGV が context (hook 名と now) で、digital 版の ARGV の後ろにだけ足されている。
    expect(snapshot.evals.slice(0, 3).map((call) => JSON.parse(call.args.at(-1)!).hook)).toEqual(['claim', 'settle', 'fail']);
    expect(snapshot.evals[2]!.args.slice(0, -1)).toEqual(snapshot.evals[3]!.args);
    expect(snapshot).toMatchSnapshot();
  });

  it('finalizeHostedPurchase (finalize hook: obligation context) and the verified access read', async () => {
    const { quoted: q, claim } = await licenseStates();
    reads(L_KEY, q);
    await claimSignedPurchaseIntent({ intentSalt: L_SALT, claim, authorizationHash: hash(claim), now: L_NOW + 1_000 });
    reads(L_KEY, JSON.parse(lastEval('license(CLAIM_SIGNED_INTENT)').args[8]!));
    await claimPurchaseSettlement({ intentSalt: L_SALT, claim, now: L_NOW + 2_000 });
    const settlingL = JSON.parse(lastEval('license(CLAIM_SETTLEMENT)').args[10]!) as SettlingPurchaseIntent;
    const ownKey = `store:own:${L_PAYER}:${L_ID}`;
    const recordKey = `store:purchase:80002:${L_TX}`;
    reads(L_KEY, settlingL);
    // finalize の EVAL が保存する値を、その後の access 読み取りで返す (Lua 成功後の KV を再現)。
    h.kvEval.mockImplementation(async (script: string, keys: string[], args: string[]) => {
      const name = scriptName(script);
      h.evals.push({ name, keys: [...keys], args: [...args] });
      if (name === 'license(FINALIZE_PURCHASE)') {
        h.reads.set(L_KEY, [args[22]!]);
        h.reads.set(ownKey, [args[13]!]);
        h.reads.set(recordKey, [args[21]!]);
      }
      return { ok: true, value: name === 'READ_LIBRARY_SCORE' ? String(L_NOW + 4_000) : 1 };
    });
    h.gets.length = 0;
    h.sets.length = 0;
    h.evals.length = 0;
    const result = await finalizeHostedPurchase({ intentSalt: L_SALT, txHash: L_TX, settledAt: L_NOW + 4_000 });
    expect(result).toMatchObject({ ok: true, kind: 'finalized' });
    const snapshot = trace();
    expect(snapshot.evals.map((call) => call.name)).toEqual(['license(FINALIZE_PURCHASE)', 'READ_LIBRARY_SCORE']);
    const context = JSON.parse(snapshot.evals[0]!.args.at(-1)!);
    expect(context).toMatchObject({ hook: 'finalize', now: L_NOW + 4_000, obligation: { txHash: L_TX, purchasedAt: L_NOW + 4_000 } });
    expect(snapshot).toMatchSnapshot();
  });
});

describe('stored record parsers: exact outputs (property order) and rejections', () => {
  const out = (value: unknown) => value === null ? null : JSON.stringify(value);
  const claim = active.claim;
  const intentCases: [string, unknown][] = [
    ['quoted', quoted],
    ['quoted + unknown field', { ...quoted, extra: 'dropped' }],
    ['signed (attempt fields dropped)', signed],
    ['signed without reservationToken', (() => { const { reservationToken: _drop, ...rest } = signed; return rest; })()],
    ['settling', active],
    ['settling + upper-case txHash', { ...active, txHash: TX.toUpperCase().replace('0X', '0x') }],
    ['indeterminate + txHash', { ...active, state: 'indeterminate', indeterminateAt: NOW, txHash: TX }],
    ['settled', settled],
    ['failed_prebroadcast', { ...active, state: 'failed_prebroadcast', failedAt: NOW, failureReason: 'prebroadcast_rejection' }],
    ['failed_prebroadcast expired unused + txHash', { ...active, state: 'failed_prebroadcast', failedAt: NOW, failureReason: 'authorization_expired_unused', txHash: TX }],
    ['optional reconcile fields', { ...active, lastCheckedAt: 5, nextReconcileAt: 'bad', reconcileFromBlock: '12000', reconcileLeaseId: 'e'.repeat(64), reconcileLeaseUntil: 7 }],
    ['non-string raw', 42],
    ['broken JSON', '{broken'],
    ['array', []],
    ['version 2', { ...quoted, version: 2 }],
    ['unknown state', { ...active, state: 'unknown' }],
    ['tampered merchantValue (binding)', { ...quoted, merchantValue: '101' }],
    ['non-canonical decimal', { ...quoted, anchorBlock: '010000' }],
    ['decimal above uint256', { ...quoted, anchorBlock: (1n << 256n).toString() }],
    ['wrong contentRef', { ...quoted, contentRef: 'wrong' }],
    ['metadata productKind other', { ...quoted, metadata: { ...quoted.metadata, productKind: 'other' } }],
    ['metadata license without productKind', { ...quoted, metadata: { ...quoted.metadata, license: {} } }],
    ['metadata desc non-string', { ...quoted, metadata: { ...quoted.metadata, desc: 1 } }],
    ['metadata unknown label', { ...quoted, metadata: { ...quoted.metadata, label: 'nope' } }],
    ['bad reconcileFromBlock', { ...active, reconcileFromBlock: '01' }],
    ['bad reconcileLeaseId', { ...active, reconcileLeaseId: 'bad' }],
    ['empty reservationToken', { ...active, reservationToken: '' }],
    ['authorizationHash mismatch', { ...active, authorizationHash: 'f'.repeat(64) }],
    ['bad attemptId', { ...active, attemptId: 'bad' }],
    ['attempt 0', { ...active, attempt: 0 }],
    ['settling bad txHash', { ...active, txHash: 'bad' }],
    ['settled without txHash', { ...settled, txHash: undefined }],
    ['indeterminate without indeterminateAt', { ...active, state: 'indeterminate' }],
    ['failed wrong reason with txHash', { ...active, state: 'failed_prebroadcast', failedAt: NOW, failureReason: 'prebroadcast_rejection', txHash: TX }],
    ['failed empty reason', { ...active, state: 'failed_prebroadcast', failedAt: NOW, failureReason: '' }],
    ...Object.keys(claim).map((field): [string, unknown] => [`claim.${field} missing`, { ...active, claim: { ...claim, [field]: undefined } }]),
    ['claim payer differs from payerHint', { ...active, claim: { ...claim, payer: '0x6666666666666666666666666666666666666666' } }],
  ];

  it('parsePurchaseIntent', () => {
    expect(Object.fromEntries(intentCases.map(([label, value]) => [
      label, out(parsePurchaseIntent(typeof value === 'string' || typeof value === 'number' ? value : JSON.stringify(value))),
    ]))).toMatchSnapshot();
  });

  it('parsePurchaseOwnership', () => {
    const own = fixture.ownership;
    const grant = own.latestGrant;
    const second = { ...grant, intentSalt: `0x${'2'.repeat(64)}`, contentRevision: 4, contentRef: 'store:hosted:content:creator-item:4', purchasedAt: grant.purchasedAt + 10 };
    const cases: [string, unknown][] = [
      ['fixture', own],
      ['two revisions', { ...own, grants: [grant, second], latestGrant: second, updatedAt: second.purchasedAt }],
      ['unknown fields', { ...own, extra: 1, latestGrant: { ...grant, extra: 2 } }],
      ['non-string', 42], ['broken JSON', '{broken'],
      ['version 2', { ...own, version: 2 }], ['other policy', { ...own, policy: 'latest' }],
      ['empty grants', { ...own, grants: [] }], ['duplicate grant', { ...own, grants: [grant, grant] }],
      ['wrong firstPurchasedAt', { ...own, firstPurchasedAt: 1 }],
      ['stale latestGrant', { ...own, grants: [grant, second] }],
      ['grant contentRef mismatch', { ...own, grants: [{ ...grant, contentRef: 'x' }] }],
      ['grant bad txHash', { ...own, grants: [{ ...grant, txHash: 'bad' }], latestGrant: { ...grant, txHash: 'bad' } }],
      ['grant bad chainId', { ...own, grants: [{ ...grant, chainId: 0 }] }],
    ];
    expect(Object.fromEntries(cases.map(([label, value]) => [
      label, out(parsePurchaseOwnership(typeof value === 'string' || typeof value === 'number' ? value : JSON.stringify(value))),
    ]))).toMatchSnapshot();
  });

  it('parseHostedPurchaseRecord', () => {
    const record = fixture.purchase;
    const cases: [string, unknown][] = [
      ['fixture', record],
      ['unknown fields', { ...record, extra: 1 }],
      ['non-string', 42], ['broken JSON', '{broken'],
      ['version 2', { ...record, version: 2 }],
      ['merchant differs from metadata.payTo', { ...record, merchant: '0x6666666666666666666666666666666666666666' }],
      ['non-canonical feeValue', { ...record, feeValue: '02' }],
      ['contentRef mismatch', { ...record, contentRef: 'x' }],
      ['empty deploymentVersion', { ...record, deploymentVersion: '' }],
      ['bad commitVersion', { ...record, commitVersion: '0x12' }],
    ];
    expect(Object.fromEntries(cases.map(([label, value]) => [
      label, out(parseHostedPurchaseRecord(typeof value === 'string' || typeof value === 'number' ? value : JSON.stringify(value))),
    ]))).toMatchSnapshot();
  });
});

describe('module structure (R3a/R3b/R3c split)', () => {
  const PURCHASE_DIR = 'lib/x402/purchase';
  const LEAVES = readdirSync(PURCHASE_DIR).sort();
  const specifiersOf = (source: string) => {
    return [
      ...[...source.matchAll(/^(?:import|export)[^'"]*?from '([^']+)'|^import '([^']+)'/gm)]
        .map((match) => match[1] ?? match[2]!),
      // leaf を直接指す vi.mock も facade をすり抜ける (利用側の mock が効かない) ので同じ検査に含める。
      // R3c: vi.doMock / vi.importActual / vi.importMock と二重引用符・template の specifier も拾う (R3b レビュー nit 2)。
      ...[...source.matchAll(/\bvi\.(?:mock|doMock|importActual|importMock)(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/g)]
        .map((match) => match[1]!),
    ];
  };
  const specifiers = (file: string) => specifiersOf(readFileSync(file, 'utf8'));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(?:ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });

  it('keeps the leaves below the facade: no leaf imports the facade, and the leaf graph is acyclic', () => {
    expect(LEAVES).toEqual([
      'claim.ts', 'finalize.ts', 'keys.ts', 'library.ts', 'lua.ts', 'parse.ts', 'quote.ts', 'read.ts',
      'records.ts', 'transitions.ts', 'types.ts',
    ]);
    const edges = Object.fromEntries(LEAVES.map((leaf) => [
      leaf, specifiers(`${PURCHASE_DIR}/${leaf}`).filter((spec) => spec.startsWith('.') || spec.includes('purchaseIntent')),
    ]));
    // R3b: read は types/keys/parse の上・quote/claim/transitions の下。facade (purchaseIntent) への辺は無い。
    // R3c: finalize → library (settled access) → records (grant/record builder) の一方向。builder は両者の下。
    expect(edges).toEqual({
      'claim.ts': ['./types', './keys', './parse', './lua', './read'],
      'finalize.ts': ['./types', './keys', './parse', './lua', './read', './records', './library'],
      'keys.ts': ['./types'],
      'library.ts': ['./types', './keys', './parse', './lua', './read', './records'],
      'lua.ts': [],
      'parse.ts': ['./types'],
      'quote.ts': ['./types', './keys', './parse', './lua'],
      'read.ts': ['./types', './keys', './parse'],
      'records.ts': ['./types'],
      'transitions.ts': ['./types', './keys', './parse', './lua'],
      'types.ts': [],
    });
    // R3c の循環の罠: finalize は access 読み取りを呼び、access 読み取りは builder を使う。builder と access 読み取りは
    // finalize を (builder は access 読み取りも) import しない。
    expect(edges['records.ts']!.filter((dep) => dep === './library' || dep === './finalize')).toEqual([]);
    expect(edges['library.ts']).not.toContain('./finalize');
    // 閉路検査: 依存の無い leaf から順に取り除いて全件が消えること。
    const remaining = new Map(Object.entries(edges).map(([leaf, deps]) => [leaf, deps.map((dep) => `${dep.slice(2)}.ts`)]));
    while (remaining.size > 0) {
      const ready = [...remaining].filter(([, deps]) => deps.every((dep) => !remaining.has(dep))).map(([leaf]) => leaf);
      expect(ready.length, `cycle among ${[...remaining.keys()].join(', ')}`).toBeGreaterThan(0);
      for (const leaf of ready) remaining.delete(leaf);
    }
  });

  it('routes every consumer outside the split through the facade (vi.mock interception)', () => {
    // 検査器の自己検査: facade 自身の分割先 import は検出できる。
    expect(specifiers('lib/x402/purchaseIntent.ts')).toEqual(expect.arrayContaining([
      './purchase/types', './purchase/keys', './purchase/parse', './purchase/lua',
      './purchase/read', './purchase/quote', './purchase/claim', './purchase/transitions',
      './purchase/finalize', './purchase/library',
    ]));
    // vi.mock の specifier も拾える (この file は @/lib/logger を import せず vi.mock だけする)。
    expect(specifiers('tests/lib/x402/purchaseIntentCompatibility.test.ts')).toContain('@/lib/logger');
    // vi.doMock / 型引数付き vi.importActual / vi.importMock と二重引用符・template も拾える
    // (この file 自身が deep path を含まないよう P/ を後から置換する)。
    expect(specifiersOf([
      'vi.doMock("P/read", () => ({}));',
      'await vi.importActual<typeof import(\'x\')>(`P/finalize`);',
      "vi.importMock('P/library');",
    ].join('\n').replaceAll('P/', '@/lib/x402/purchase/'))).toEqual([
      '@/lib/x402/purchase/read', '@/lib/x402/purchase/finalize', '@/lib/x402/purchase/library',
    ]);
    const deep = ['app', 'components', 'lib', 'scripts', 'tests'].flatMap(walk)
      .filter((file) => file !== 'lib/x402/purchaseIntent.ts' && !file.startsWith(`${PURCHASE_DIR}/`))
      .filter((file) => specifiers(file).some((spec) => /(?:^|\/)x402\/purchase\/|^\.\/purchase\//.test(spec)));
    expect(deep).toEqual([]);
  });
});
