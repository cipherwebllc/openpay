// 「売上をほかのウォレットへ移す」(内部名「売上の移動」) の開示ドリフト・フェンス (掟 14)。
// lib/disclosedSalesMove.ts (DISCLOSED_SALES_MOVE) から期待文字列を **導出** し、
// ① 実装 (route /api/relay/jpyc/move が Polygon で強制する利用料・最低額) ② 受け付けるチェーン = 開示のチェーン
// ③ 施行日 ④ 各開示面 (規約・特商法・免責・プライバシー・LP と料金ページの 5 つの場合のカード・料金ページの行・/transparency・
// public/llms.txt・README・docs/FEATURES.md) の一致を固定する。⑤ 利用料の解決の順 (env の上書きで開示とずれることを見える形にする)。
// 数値は直書きしない (直書きするとフェンス自体がドリフト源になる)。
// llms.txt の「型」(送金 1 回につき N JPYC の全一致) は tests/lib/llmsTxtDisclosure.test.ts が持つ。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { avalanche, avalancheFuji, base, kaia, kairos, mainnet, polygon, polygonAmoy } from 'viem/chains';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import {
  DISCLOSED_SALES_MOVE as D,
  LEGAL_ENTITY,
  disclosedSalesMoveChains,
} from '@/lib/legal';
import { SALES_MOVE_CHAIN_IDS, SALES_MOVE_MIN_VALUE_WEI } from '@/lib/relay/salesMove';
import { PRICING, PRICING_ROW_GROUPS, PRICING_SUMMARY_IDS } from '@/lib/pricing';
import { transparencyContentFor } from '@/lib/transparency';

const WEI_PER_JPYC = 10n ** 18n;
const DISCLOSED_FEE_WEI = BigInt(D.feeJpyc) * WEI_PER_JPYC;
const FEE = `${D.feeJpyc} JPYC`;
const MIN = `${D.minJpyc} JPYC`;
const CH_JA = disclosedSalesMoveChains('ja');
const CH_EN = disclosedSalesMoveChains('en');
const [y, m, d] = D.effectiveDate.split('-').map(Number);
const JA_DATE = `${y} 年 ${m} 月 ${d} 日`;
const EN_DATE = `${new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${d}, ${y}`;
// route (#1039) を足した日。開示の施行日はこれより前にならない (機能が無い日付で新設したことにしない)。
const ROUTE_INTRODUCED = '2026-11-07';

// JPYC の relay に関わるチェーン。route がここに無いチェーンを受け付け始めたら、下の ② が名前を引けずに落ちる (開示を足す合図)。
const KNOWN_CHAINS: readonly { id: number; name: string; testnet?: boolean }[] = [
  polygon,
  polygonAmoy,
  kaia,
  kairos,
  avalanche,
  avalancheFuji,
  mainnet,
  base,
];
const chainById = (id: number) => KNOWN_CHAINS.find((c) => c.id === id);
const DEST_FOR_KEYS = '0x000000000000000000000000000000000000D357';
const SENDER_FOR_KEYS = '0x0000000000000000000000000000000000000DeF';

describe('① 実装: route が Polygon で強制する利用料・最低額 = 開示', () => {
  const FORWARDER = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
  const FEE_RECEIVER = getAddress('0x428483FbA62eDCef1E3a100d3799F6d71759c560');
  const FROM = getAddress('0x0000000000000000000000000000000000000def');
  const DEST = getAddress('0x000000000000000000000000000000000000d357');
  const settle = vi.fn();
  let POST: (req: Request) => Promise<Response>;

  // 利用料は route と同じ relayGasFeeValue の実物で求める (env の Polygon の上書きを外した既定 = 開示の値)。
  // 入口の部品 (admission・hosted gate・settle・記録) だけを差し替え、route は 1 回だけ動的に import する。
  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '');
    vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_POLYGON', '');
    vi.resetModules();
    vi.doMock('@/lib/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/env')>();
      return { ...actual, env: { ...actual.env, enableSalesMove: true, enableJpycEip3009: true } };
    });
    vi.doMock('@/lib/relay/relayProvider', () => ({
      PROVIDER: 'self-host',
      MAINNET_CHAINS: new Set([137, 8217, 43114]),
      RELAYER_ADDRESS: null,
      jpycAddressFor: () => '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
      relayMaxGasCostWei: () => 1n,
    }));
    vi.doMock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
      jpycForwarderFor: () => FORWARDER,
    }));
    vi.doMock('@/lib/relay/forwarderSettleService', () => ({
      settleViaForwarder: (input: unknown) => settle(input),
      feeReceiverFor: () => FEE_RECEIVER,
    }));
    vi.doMock('@/lib/x402/purchaseSettleGate', () => ({ checkHostedIntentSettleAdmission: async () => 'allow' }));
    vi.doMock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: async () => true }));
    vi.doMock('@/lib/kv', () => ({ isKvConfigured: () => true }));
    vi.doMock('@/lib/metrics', () => ({ recordMetricAfterResponse: () => {} }));
    vi.doMock('@/lib/relay/salesMoveAbuse', () => ({ recordSalesMoveSenderAfterResponse: () => {} }));
    vi.doMock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
    ({ POST } = await import('@/app/api/relay/jpyc/move/route'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const path of [
      '@/lib/env',
      '@/lib/relay/relayProvider',
      '@/lib/relay/forwarderConfig',
      '@/lib/relay/forwarderSettleService',
      '@/lib/x402/purchaseSettleGate',
      '@/lib/relay/relayGuards',
      '@/lib/kv',
      '@/lib/metrics',
      '@/lib/relay/salesMoveAbuse',
      '@/lib/logger',
    ]) {
      vi.doUnmock(path);
    }
  });

  function post(chainId: number, merchantValue: bigint): Promise<Response> {
    return POST(
      new Request('http://localhost/api/relay/jpyc/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chainId,
          from: FROM,
          merchant: DEST,
          merchantValue: merchantValue.toString(),
          feeValue: (BigInt(D.feeJpyc) * WEI_PER_JPYC).toString(),
          validAfter: '0',
          validBefore: String(Math.floor(Date.now() / 1000) + 600),
          intentSalt: `0x${'22'.repeat(32)}`,
          signature: `0x${'b'.repeat(130)}` as Hex,
        }),
      }),
    );
  }

  it('Polygon (137) で settle に渡す利用料 = feeJpyc × 10^18 (移す額に上乗せの floor・1% ではない)', async () => {
    settle.mockReset();
    settle.mockResolvedValue({ kind: 'success', txHash: `0x${'ab'.repeat(32)}` });
    const res = await post(137, 1_000n * WEI_PER_JPYC);
    expect(res.status).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
    const input = settle.mock.calls[0]![0] as { expectedFeeValue: bigint; callerFeeFloorValue: bigint; params: { merchantValue: bigint } };
    expect(input.expectedFeeValue).toBe(BigInt(D.feeJpyc) * WEI_PER_JPYC);
    expect(input.callerFeeFloorValue).toBe(input.expectedFeeValue);
    // 1,000 JPYC を移しても利用料は増えない (決済額の 1% は適用しない)。
    expect(input.params.merchantValue).toBe(1_000n * WEI_PER_JPYC);
  });

  it('移す額の下限 = minJpyc (1 wei 下は 400 amount_below_minimum・ちょうどは通る)', async () => {
    expect(SALES_MOVE_MIN_VALUE_WEI).toBe(BigInt(D.minJpyc) * WEI_PER_JPYC);
    settle.mockReset();
    settle.mockResolvedValue({ kind: 'success', txHash: `0x${'ab'.repeat(32)}` });
    const below = await post(137, SALES_MOVE_MIN_VALUE_WEI - 1n);
    expect(below.status).toBe(400);
    expect(await below.json()).toEqual({ ok: false, error: 'amount_below_minimum' });
    expect(settle).not.toHaveBeenCalled();
    expect((await post(137, SALES_MOVE_MIN_VALUE_WEI)).status).toBe(200);
  });

  // ⚠️ route は開示の定数を読まず、relayGasFeeValue(137) をそのまま求める。env の上書きがあると開示とずれる
  // (feeDisclosureDivergence はこの route では動かない) → 点灯の前に Production の上書きを確かめる (DEPLOY_CHECKLIST §18.2 の 0.)。
  // ここでは global の上書き (呼び出しのたびに読む) を入れ、route がそれに従う = 開示とずれることを見える形にする。
  it('env の上書きがあると route はその額を求める (開示とずれる・点灯の前の確認が要る)', async () => {
    settle.mockReset();
    settle.mockResolvedValue({ kind: 'success', txHash: `0x${'ab'.repeat(32)}` });
    const override = BigInt(D.feeJpyc) + 1n;
    vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', String(override));
    try {
      expect((await post(137, 1_000n * WEI_PER_JPYC)).status).toBe(200);
      const input = settle.mock.calls[0]![0] as { expectedFeeValue: bigint };
      expect(input.expectedFeeValue).toBe(override * WEI_PER_JPYC);
      expect(input.expectedFeeValue).not.toBe(DISCLOSED_FEE_WEI);
    } finally {
      vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', '');
    }
  });

  it('開示していない mainnet のチェーン (Kaia・Avalanche・Ethereum・Base) は 400 unsupported_chain', async () => {
    settle.mockReset();
    for (const chainId of [8217, 43114, 1, 8453]) {
      const res = await post(chainId, 10n * WEI_PER_JPYC);
      expect(res.status, String(chainId)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'unsupported_chain' });
    }
    expect(settle).not.toHaveBeenCalled();
  });
});

// lib/relay/forwarderConfig.ts の relayGasFeeValue の解決の順: Polygon の上書き (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_POLYGON・module の
// 読み込み時に読む) → Polygon の per-chain 既定 (今は無い) → global の上書き (NEXT_PUBLIC_RELAY_GAS_FEE_JPYC・呼び出し時に読む)
// → 既定 2 JPYC。どの段の上書きでも、開示 (DISCLOSED_SALES_MOVE.feeJpyc) と違えば route の利用料が開示とずれる。
// 既定 (上書きなし) だけが開示と一致することと、上書きの優先を固定する (点灯の前に Production の上書きを確かめる理由)。
describe('⑤ 利用料の解決の順 (Polygon の上書き → per-chain 既定 → global の上書き → 2 JPYC)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function feeWith(polygonEnv: string, globalEnv: string): Promise<bigint> {
    vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_POLYGON', polygonEnv);
    vi.stubEnv('NEXT_PUBLIC_RELAY_GAS_FEE_JPYC', globalEnv);
    vi.resetModules();
    const { relayGasFeeValue } = await import('@/lib/relay/forwarderConfig');
    return relayGasFeeValue(137);
  }

  const other = String(D.feeJpyc + 1);

  it('上書きが無い (既定・Polygon の per-chain 既定も無い) ときだけ開示と一致する', async () => {
    expect(await feeWith('', '')).toBe(DISCLOSED_FEE_WEI);
  });

  it('global の上書きは Polygon の上書きが無いときに効き、開示とずれる', async () => {
    const fee = await feeWith('', other);
    expect(fee).toBe(BigInt(other) * WEI_PER_JPYC);
    expect(fee).not.toBe(DISCLOSED_FEE_WEI);
  });

  it('Polygon の上書きは global より先に効く (Polygon が開示と違えば、global が開示どおりでもずれる)', async () => {
    expect(await feeWith(other, String(D.feeJpyc))).toBe(BigInt(other) * WEI_PER_JPYC);
    expect(await feeWith(String(D.feeJpyc), other)).toBe(DISCLOSED_FEE_WEI);
  });

  it('0 や数字でない上書きは次の段へ倒れる (Polygon が 0 → global・global も 0 → 既定 2 JPYC)', async () => {
    expect(await feeWith('0', other)).toBe(BigInt(other) * WEI_PER_JPYC);
    expect(await feeWith('abc', '')).toBe(DISCLOSED_FEE_WEI);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await feeWith('0', '0')).toBe(2n * WEI_PER_JPYC);
  });
});

describe('② チェーン: route が受け付ける mainnet = 開示のチェーン', () => {
  it('SALES_MOVE_CHAIN_IDS から testnet を除いたもの = chainIds・名前も同じ並び', () => {
    const mainnet = SALES_MOVE_CHAIN_IDS.filter((id) => chainById(id)?.testnet !== true);
    expect(mainnet).toEqual([...D.chainIds]);
    expect(D.chainNames).toEqual(D.chainIds.map((id) => chainById(id)?.name));
  });
});

describe('③ 施行日', () => {
  it('新設日は route を足した日以降で、改定した 4 文書 (規約・特商法・免責・プライバシー) の施行日は新設日以降', () => {
    expect(D.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(D.effectiveDate >= ROUTE_INTRODUCED).toBe(true);
    for (const date of [
      LEGAL_ENTITY.termsEffectiveDate,
      LEGAL_ENTITY.tokuteiEffectiveDate,
      LEGAL_ENTITY.disclaimerEffectiveDate,
      LEGAL_ENTITY.privacyEffectiveDate,
    ]) {
      expect(date >= D.effectiveDate, `${date} は新設日 ${D.effectiveDate} 以降`).toBe(true);
    }
  });
});

describe('④ 開示面', () => {
  it('規約 第 5 条 (12): 対象・署名と中継・利用料 (上乗せ・同一取引・1% なし)・非カストディ・利用条件・JPYC EX と取引所・取消不可・新設日', () => {
    for (const body of [ja.Terms.article5.body, en.Terms.article5.body]) expect(body.match(/\(12\)/g)).toHaveLength(1);
    const ja12 = ja.Terms.article5.body.split('(12)')[1];
    const en12 = en.Terms.article5.body.split('(12)')[1];
    for (const w of [
      '「売上をほかのウォレットへ移す」',
      `${CH_JA} の JPYC`,
      '1 回署名し、当社が当該送金を中継してネットワーク手数料を肩代わり',
      `送金 1 回につき ${FEE} の利用料`,
      '移す額に上乗せ',
      '指定した額がそのまま届き',
      '同一の取引内で当社指定ウォレットへ分割',
      '(1) の OpenPay 利用料 (決済額の 1%・最低 2 JPYC) を適用しません',
      '受領・保管・精算しません',
      '店主ご自身のウォレットの間の移動に限り',
      '当社は、送り先が店主ご自身のウォレットであるかを確かめることはできません。',
      'この条件に反する利用が疑われる場合、当社は第 7 条に基づき、本サービスの利用を制限することがあります。',
      'JPYC EX の償還の送り先や取引所の入金アドレスへは直接送らないでください',
      '取り消すことができません',
      JA_DATE,
    ]) {
      expect(ja12, w).toContain(w);
    }
    for (const w of [
      '“Move sales to another wallet”',
      `JPYC on ${CH_EN}`,
      'signs the transfer once',
      'relays that transfer and sponsors the Network Fee',
      `${FEE} per transfer`,
      'added on top of the amount moved',
      'receives the amount the Merchant specified in full',
      'split to a wallet designated by the Company within the same transaction',
      'paragraph (1) (1% of the payment, minimum 2 JPYC) does not apply',
      'does not receive, hold or settle',
      'only to move JPYC between the Merchant’s own wallets',
      'The Company cannot verify whether a destination is the Merchant’s own wallet.',
      'If use contrary to this condition is suspected, the Company may restrict use of the Service under Article 7.',
      'JPYC EX redemption address or an exchange deposit address',
      'cannot be cancelled',
      EN_DATE,
    ]) {
      expect(en12, w).toContain(w);
    }
    // 利用条件は事実の主張にしない (当社が送り先を確かめている・確認済みとは書かず、確かめられないと書く)。
    expect(ja12).not.toMatch(/確かめています|確認しています|確認済み/);
    expect(en12).not.toMatch(/Company (?:verifies|confirms|checks)\b/);
    // 利用の制限の根拠は第 7 条 (禁止事項・利用の制限) にある。
    expect(ja.Terms.article7.body).toContain('本サービスの利用を制限し');
    expect(en.Terms.article7.title).toContain('Article 7');
  });

  it('特商法 (役務の内容・役務の対価・対価以外の費用・支払時期・返品)', () => {
    const tj = ja.Tokutei.rows;
    const te = en.Tokutei.rows;
    expect(tj.serviceContent.value).toContain(`${CH_JA} の JPYC を、店主ご自身が管理する別のウォレットへ移す「売上をほかのウォレットへ移す」`);
    expect(te.serviceContent.value).toContain(`“Move sales to another wallet”, which moves JPYC on ${CH_EN}`);
    for (const w of ['「売上をほかのウォレットへ移す」', CH_JA, '店主ご自身のウォレットの間の移動に限ります', `送金 1 回につき ${FEE} の利用料`, '移す額に上乗せ', '同一の取引内で当社指定ウォレットへ分割', '1% の OpenPay 利用料は適用しません']) {
      expect(tj.price.value, w).toContain(w);
    }
    for (const w of ['“Move sales to another wallet”', CH_EN, 'limited to moves between the Merchant’s own wallets', `${FEE} per transfer`, 'added on top of the amount moved', 'within the same transaction', 'The 1% OpenPay usage fee on payments does not apply']) {
      expect(te.price.value, w).toContain(w);
    }
    expect(tj.additionalFees.value).toContain(`「売上をほかのウォレットへ移す」では、当社がネットワーク手数料を肩代わりするため、店主は上記の利用料 (送金 1 回につき ${FEE}) のほかにネットワーク手数料を負担しません`);
    expect(te.additionalFees.value).toContain(`the Merchant pays no Network Fee beyond the fee above (${FEE} per transfer)`);
    expect(tj.returnPolicy.value).toContain(`「売上をほかのウォレットへ移す」の利用料 (送金 1 回につき ${FEE}) および移した JPYC も、送金の確定後は取り消し・返金できません`);
    expect(te.returnPolicy.value).toContain(`The fee for “Move sales to another wallet” (${FEE} per transfer) and the JPYC moved also cannot be cancelled or refunded`);
    // 支払時期: 送金の実行時に同一の取引内で分割 (Polygon の JPYC・移す額に上乗せ)。
    expect(tj.paymentTiming.value).toContain(
      `「売上をほかのウォレットへ移す」の利用料 (送金 1 回につき ${FEE}) は、${CH_JA} の JPYC で移す額に上乗せされ、送金の実行時 (オンチェーン精算時) に、当該送金と同一の取引内で店主のウォレットから当社指定ウォレットへ分割して申し受けます。`,
    );
    expect(te.paymentTiming.value).toContain(
      `The fee for “Move sales to another wallet” (${FEE} per transfer; JPYC on ${CH_EN}, added on top of the amount moved) is taken at the time the transfer is executed (at on-chain settlement), split from the Merchant's wallet to a wallet designated by the Company within the same transaction.`,
    );
  });

  // 濫用の集計 (lib/relay/salesMoveAbuse.ts) の実装と一致する: 送り先と送り元の組・送り先ごとの月の送り元の数を TTL 100 日で KV に置き、
  // 閾値に届くと送り先のアドレスを含む warn (logger → console と Sentry) を出す。1% 回避の集計の warn (受取先のアドレスを含む) も
  // エラー監視のただし書きの例に挙げる。
  it('プライバシー (1-(11) 取得・2-(9) エラー監視のただし書き・2-(13) 目的と保存・4. 保管期間)', async () => {
    const abuse = await import('@/lib/relay/salesMoveAbuse');
    const days = abuse.SALES_MOVE_SENDERS_TTL_SEC / (24 * 3600);
    const keys = abuse.salesMoveSenderKeys('2026-11', 137, DEST_FOR_KEYS, SENDER_FOR_KEYS);
    // 組 (送り先 + 送り元) と送り先ごとの数を置く (実装の key の形)。
    expect(keys.pair).toContain(DEST_FOR_KEYS.toLowerCase());
    expect(keys.pair).toContain(SENDER_FOR_KEYS.toLowerCase());
    expect(keys.senders.endsWith(':senders')).toBe(true);
    const avoid = await import('@/lib/relay/recoverFeeAvoidance');
    expect(avoid.FEE_AVOIDANCE_TTL_SEC).toBe(abuse.SALES_MOVE_SENDERS_TTL_SEC);

    const pj = ja.Privacy;
    const pe = en.Privacy;
    expect(pj.section1.body).toContain('(11) 「売上をほかのウォレットへ移す」をご利用の場合の、送り先と送り元のウォレットアドレスの組み合わせ (チェーン・月ごと) と、送り先ごと・月ごとの送り元の数。');
    expect(pe.section1.body).toContain('(11) When “Move sales to another wallet” is used, the pairs of destination and sender wallet addresses (per chain and month) and the number of senders per destination per month.');
    expect(pj.section2.body).toContain(`(13) 「売上をほかのウォレットへ移す」の不正利用を見つけるため、送り先と送り元のアドレスの組み合わせと、月ごとの件数を、最長 ${days} 日保存します。送り先ごとの送り元の数が多いときは、送り先のアドレスを含む警告をエラー監視に送ります。`);
    expect(pe.section2.body).toContain(`(13) To detect misuse of “Move sales to another wallet”, the Company keeps the pairs of destination and sender addresses and the monthly counts for up to ${days} days. When a destination has many senders, the Company sends a warning that includes the destination address to error monitoring.`);
    // 2-(9) の「個人を特定する情報を送信しない設定」のただし書き (例として 2 つの警告・ほかにもあるので「例」)。
    for (const w of ['ただし、障害の調査や不正利用の確認のため、ウォレットアドレスを含む警告をエラー監視に送ることがあります', '(例: 「売上をほかのウォレットへ移す」', '送り先のアドレス・チェーン・月・送り元の数', '受取先のアドレス・チェーン・月・件数・1% との差額']) {
      expect(pj.section2.body, w).toContain(w);
    }
    for (const w of ['However, to investigate failures or check for misuse, the Company may send warnings that include wallet addresses', '(for example, a warning when a destination of “Move sales to another wallet”', 'destination address, chain, month and number of senders', 'receiving address, chain, month, count and the difference from the 1%']) {
      expect(pe.section2.body, w).toContain(w);
    }
    // ただし書きは「個人を特定する情報を送信しない設定」の文の後ろ (その文の範囲を示す)。
    expect(pj.section2.body.indexOf('ただし、障害の調査')).toBeGreaterThan(pj.section2.body.indexOf('個人を特定する情報を送信しない設定'));
    expect(pe.section2.body.indexOf('However, to investigate')).toBeGreaterThan(pe.section2.body.indexOf('not to send personally identifying information'));
    expect(pj.section4.body).toContain(`「売上をほかのウォレットへ移す」の不正利用を見つけるための記録 (送り先と送り元のアドレスの組み合わせ・月ごとの件数) は、最長 ${days} 日で自動的に削除します。`);
    expect(pe.section4.body).toContain(`are deleted automatically within ${days} days.`);
  });

  it('免責 (§2 取消不可・送り先・JPYC EX と取引所 / §7 利用料)', () => {
    for (const w of ['「売上をほかのウォレットへ移す」で移した JPYC も取り消せません', 'ご自分のウォレットを指定', 'JPYC EX の償還の送り先や取引所の入金アドレスへ直接送ると', '送り先の誤り']) {
      expect(ja.Disclaimer.section2.body, w).toContain(w);
    }
    for (const w of ['cannot be cancelled either', 'Choose your own wallet', 'JPYC EX redemption address or an exchange deposit address', 'wrong destination']) {
      expect(en.Disclaimer.section2.body, w).toContain(w);
    }
    for (const w of ['「売上をほかのウォレットへ移す」', CH_JA, `送金 1 回につき ${FEE} の利用料を、移す額に上乗せ`, '決済額の 1% は適用しません']) {
      expect(ja.Disclaimer.section7.body, w).toContain(w);
    }
    for (const w of ['“Move sales to another wallet”', CH_EN, `${FEE} per transfer, added on top of the amount moved`]) {
      expect(en.Disclaimer.section7.body, w).toContain(w);
    }
  });

  // LP の料金の欄 (components/LandingSupport.tsx) は料金ページと同じ summary のカードを出す (別の 1 行は置かない)。
  it('料金ページと LP の冒頭のカード: 5 つ目の場合 (売上をほかのウォレットへ移す・お店が払う・送金 1 回)', () => {
    expect(PRICING_SUMMARY_IDS).toContain('salesMove');
    expect(PRICING.ja.summaryTitle).toBe(`料金がかかるのは、この ${PRICING_SUMMARY_IDS.length} つです`);
    expect(PRICING.en.summaryTitle).toBe(`Charges apply in these ${PRICING_SUMMARY_IDS.length} cases`);
    const cardJa = PRICING.ja.summary.find((c) => c.id === 'salesMove');
    const cardEn = PRICING.en.summary.find((c) => c.id === 'salesMove');
    expect(cardJa).toMatchObject({ name: '売上をほかのウォレットへ移す', focal: FEE, focalSub: '送金 1 回', feeName: '利用料', payer: { tone: 'shop' } });
    expect(cardEn).toMatchObject({ name: 'Move sales to another wallet', focal: FEE, focalSub: 'per transfer', feeName: 'Fee', payer: { tone: 'shop' } });
    expect(cardJa?.detail).toBe(`ご自分の別のウォレットへ移すとき。移す額に上乗せします（${CH_JA} の JPYC）`);
    expect(cardEn?.detail).toBe(`When moving to another wallet of your own. Added on top of the amount (JPYC on ${CH_EN})`);
    // metadata の説明にも売上の移動を入れる。
    expect(PRICING.ja.metaDescription).toContain('売上の移動');
    expect(PRICING.en.metaDescription).toContain('moving sales to another wallet');
    // LP に別の 1 行は無い (カードと二重にしない)。
    expect('supportFeeMoveNote' in ja.Landing).toBe(false);
    expect('supportFeeMoveNote' in en.Landing).toBe(false);
  });

  it('料金ページ: お店のまとまりの行 (最低額・上限は数字を書かず画面に出す旨)', () => {
    expect(PRICING_ROW_GROUPS.find((g) => g.id === 'shop')?.rowIds).toContain('salesMove');
    for (const [locale, value, words] of [
      ['ja', `1 回 ${FEE}`, [`送金 1 回につき ${FEE}`, '移す額に上乗せ', 'そのまま届きます', `${MIN} 以上`, '1 回に移せる額には上限があり、署名の前に画面に表示します。', 'ご自分のウォレットの間']],
      ['en', `${FEE} per transfer`, [`${FEE} per transfer`, 'added on top of the amount moved', 'in full', `at least ${MIN}`, 'There is a limit on how much can be moved at once, shown on screen before you sign.', 'own wallets']],
    ] as const) {
      const row = PRICING[locale].rows.find((r) => r.id === 'salesMove');
      expect(row?.gasless).toEqual([{ rail: 'JPYC', value }]);
      expect(row?.payers.map((p) => p.tone)).toEqual(['shop']);
      expect(row?.scope).toContain(disclosedSalesMoveChains(locale));
      const details = row?.details.join('\n') ?? '';
      for (const w of words) expect(details, w).toContain(w);
    }
  });

  it('/transparency の「手数料の決め方」', () => {
    const jaFee = transparencyContentFor('ja').fees.find((f) => f.startsWith('売上をほかのウォレットへ移す')) ?? '';
    const enFee = transparencyContentFor('en').fees.find((f) => f.startsWith('Move sales to another wallet')) ?? '';
    for (const w of [`JPYC・${CH_JA}`, `送金 1 回につき ${FEE}`, '移す額に上乗せ', 'ご自分のウォレットの間の移動に限ります', 'JPYC EX の償還の送り先']) expect(jaFee, w).toContain(w);
    for (const w of [`JPYC on ${CH_EN}`, `${FEE} per transfer`, 'added on top of the amount moved', 'between the shop’s own wallets', 'JPYC EX redemption address']) expect(enFee, w).toContain(w);
  });

  it('public/llms.txt の「- 売上の移動:」の行', () => {
    const llms = readFileSync(join(process.cwd(), 'public/llms.txt'), 'utf8');
    const lines = llms.split('\n').filter((l) => l.startsWith('- 売上の移動:'));
    expect(lines).toHaveLength(1);
    const [line] = lines;
    for (const w of [
      `${CH_JA} の JPYC`,
      '「売上をほかのウォレットへ移す」',
      `送金 1 回につき ${FEE}`,
      '移す額に上乗せ',
      '決済額の 1% は適用しない',
      `1 回 ${MIN} 以上`,
      '1 回に移せる額には上限があり、署名の前に画面に表示する',
      'ご自分のウォレットの間の移動に限る',
      'JPYC EX の償還の送り先や取引所の入金アドレスへは直接送らない',
      '取り消せない',
    ]) {
      expect(line, w).toContain(w);
    }
    // チップ・お店がガス代を肩代わりの行のフェンスが数える語を、この行に入れない (tests/lib/llmsTxtDisclosure.test.ts・
    // tests/lib/storeGasWalletDisclosure.test.ts)。
    for (const w of ['チップは', '徴収はありません', 'お店がガス代を肩代わりして送る']) expect(line).not.toContain(w);
  });

  it('README・docs/FEATURES.md の Fees の 1 文 (利用料・チェーン・上乗せ・1% なし)', () => {
    for (const file of ['README.md', 'docs/FEATURES.md']) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      const lines = text.split('\n').filter((l) => l.includes('“Move sales to another wallet”'));
      expect(lines, file).toHaveLength(1);
      const [line] = lines;
      for (const w of [`JPYC on ${CH_EN} only`, `**${FEE} per transfer**`, 'added on top of the amount moved', 'the destination receives the amount in full', 'the 1% does not apply']) {
        expect(line, `${file}: ${w}`).toContain(w);
      }
    }
  });
});
