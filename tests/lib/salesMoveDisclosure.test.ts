// 「売上をほかのウォレットへ移す」(内部名「売上の移動」) の開示ドリフト・フェンス (掟 14)。
// lib/disclosedSalesMove.ts (DISCLOSED_SALES_MOVE) から期待文字列を **導出** し、
// ① 実装 (route /api/relay/jpyc/move が Polygon で強制する利用料・最低額) ② 受け付けるチェーン = 開示のチェーン
// ③ 施行日 ④ 各開示面 (規約・特商法・免責・LP・料金ページ・/transparency・public/llms.txt) の一致を固定する。
// 数値は直書きしない (直書きするとフェンス自体がドリフト源になる)。
// llms.txt の「型」(送金 1 回につき N JPYC の全一致) は tests/lib/llmsTxtDisclosure.test.ts が持つ。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import { getAddress, type Hex } from 'viem';
import { avalanche, avalancheFuji, base, kaia, kairos, mainnet, polygon, polygonAmoy } from 'viem/chains';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import {
  DISCLOSED_SALES_MOVE as D,
  LANDING_PAYMENT_FEE_VALUES,
  LEGAL_ENTITY,
  disclosedSalesMoveChains,
} from '@/lib/legal';
import { SALES_MOVE_CHAIN_IDS, SALES_MOVE_MIN_VALUE_WEI } from '@/lib/relay/salesMove';
import { PRICING, PRICING_ROW_GROUPS, PRICING_SUMMARY_IDS } from '@/lib/pricing';
import { transparencyContentFor } from '@/lib/transparency';

const WEI_PER_JPYC = 10n ** 18n;
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

describe('② チェーン: route が受け付ける mainnet = 開示のチェーン', () => {
  it('SALES_MOVE_CHAIN_IDS から testnet を除いたもの = chainIds・名前も同じ並び', () => {
    const mainnet = SALES_MOVE_CHAIN_IDS.filter((id) => chainById(id)?.testnet !== true);
    expect(mainnet).toEqual([...D.chainIds]);
    expect(D.chainNames).toEqual(D.chainIds.map((id) => chainById(id)?.name));
  });
});

describe('③ 施行日', () => {
  it('新設日は route を足した日以降で、改定した 3 文書 (規約・特商法・免責) の施行日は新設日以降', () => {
    expect(D.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(D.effectiveDate >= ROUTE_INTRODUCED).toBe(true);
    for (const date of [LEGAL_ENTITY.termsEffectiveDate, LEGAL_ENTITY.tokuteiEffectiveDate, LEGAL_ENTITY.disclaimerEffectiveDate]) {
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
      'JPYC EX redemption address or an exchange deposit address',
      'cannot be cancelled',
      EN_DATE,
    ]) {
      expect(en12, w).toContain(w);
    }
    // 利用条件は事実の主張にしない (当社が送り先を確かめる・確認済み等と書かない)。
    expect(ja12).not.toMatch(/当社が(?:確認|確かめ)/);
    expect(en12).not.toMatch(/Company (?:verifies|confirms|checks)/);
  });

  it('特商法 (役務の内容・役務の対価・対価以外の費用・返品)', () => {
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

  it('LP の料金の欄 (supportFeeMoveNote) は開示値を補間する', () => {
    expect(LANDING_PAYMENT_FEE_VALUES.salesMoveFee).toBe(D.feeJpyc);
    const tJa = createTranslator({ locale: 'ja', messages: ja, namespace: 'Landing' });
    const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'Landing' });
    const noteJa = tJa('supportFeeMoveNote', LANDING_PAYMENT_FEE_VALUES);
    const noteEn = tEn('supportFeeMoveNote', LANDING_PAYMENT_FEE_VALUES);
    for (const w of ['「売上をほかのウォレットへ移す」', `JPYC・${CH_JA} のみ`, `送金 1 回につき ${FEE}`, '移す額に上乗せ']) expect(noteJa, w).toContain(w);
    for (const w of ['“Move sales to another wallet”', `JPYC on ${CH_EN} only`, `${FEE} per transfer`, 'added on top of the amount moved']) expect(noteEn, w).toContain(w);
    // 数字は messages に直書きしない (ICU で差し込む)。
    expect(ja.Landing.supportFeeMoveNote).toContain('{salesMoveFee}');
    expect(en.Landing.supportFeeMoveNote).toContain('{salesMoveFee}');
  });

  it('料金ページ: お店のまとまりの行 (決済ではないので冒頭の 4 つの場合には入れない)', () => {
    expect(PRICING_ROW_GROUPS.find((g) => g.id === 'shop')?.rowIds).toContain('salesMove');
    expect(PRICING_SUMMARY_IDS as readonly string[]).not.toContain('salesMove');
    for (const [locale, value, words] of [
      ['ja', `1 回 ${FEE}`, [`送金 1 回につき ${FEE}`, '移す額に上乗せ', 'そのまま届きます', `${MIN} 以上`, 'ご自分のウォレットの間']],
      ['en', `${FEE} per transfer`, [`${FEE} per transfer`, 'added on top of the amount moved', 'in full', `at least ${MIN}`, 'own wallets']],
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
});
