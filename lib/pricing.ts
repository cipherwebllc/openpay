// 料金ページ (/pricing) の本文 (ja/en 同梱)。page (app/[locale]/pricing/page.tsx) が locale で出し分けて描く。
//
// 新しい約束を作らず、規約・特商法に書いた料金を機能ごとにまとめ直す (/transparency と同じ型):
// - 料率・最低額・チェーン名はすべて lib/legal.ts の DISCLOSED_* から差し込む (直書きしない)。
//   import は @/lib/legal だけにする (tests/app/pricingNoHardcode.test.tsx が @/lib/legal を差し替えて、
//   ページの数字が全部追従することを確かめるため)。
// - 計算例は lib/pricingExamples.ts が実際の分け方と同じ式で出す。
// - 呼び名は規約に合わせる: 総称は「OpenPay の料金」。場合ごとに OpenPay 利用料 (ガスレス決済)・
//   モバイル注文の利用料 (規約の「モバイル注文システム利用料」)・ガス代相当 (JPYC のチップ)・
//   x402 利用料 (規約の「x402 ファシリテーター利用料」)。
// - AI エージェントが x402 で払うモバイル注文は、モバイル注文の利用料ではなく x402 利用料だけ
//   (買い手が上乗せ・お店は注文額をそのまま受け取る。規約 第 5 条 (8) のただし書き・2026-10-11 改定)。
// - 料金の種類を足したら、ここの行と tests/lib/pricingExamples.test.ts の網羅フェンスも直す。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
import {
  DISCLOSED_CCTP_FEE,
  DISCLOSED_DUAL_RAIL_USDC,
  DISCLOSED_MOBILE_ORDER_FEE,
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_STORE_GAS_WALLET,
  DISCLOSED_STORE_USDC_PAYMENT,
  DISCLOSED_TIP_FEE_MODELS,
  DISCLOSED_X402_FEE,
  cctpFeeDisclosureValues,
  disclosedStoreGasChains,
} from '@/lib/legal';
import {
  PRICING_EXAMPLE_AMOUNTS,
  digitalExample,
  formatJpycWei,
  gaslessExample,
  gaslessUnavailableUpToWei,
  mobileExample,
  percentLabel,
  preorderSplit,
  storeGasExample,
  type PricingExample,
} from '@/lib/pricingExamples';

export type PricingLocale = 'ja' | 'en';

/** 払う人のピルの色分け (お店 = emerald / お客様・送る方・買い手 = blue / どちらも = slate)。色だけに頼らず文字でも書く。 */
export type PricingPayerTone = 'shop' | 'customer' | 'either';

export type PricingPayer = {
  readonly tone: PricingPayerTone;
  readonly label: string;
  readonly note: string;
};

/** 行の並び (テストが ja/en でこの並びを確かめる)。 */
export const PRICING_ROW_IDS = ['pay', 'register', 'mobile', 'tip', 'store', 'storeGas'] as const;
export type PricingRowId = (typeof PRICING_ROW_IDS)[number];

export type PricingRow = {
  readonly id: PricingRowId;
  readonly name: string;
  /** 機能名の下の補足 (対象の範囲)。 */
  readonly scope: string | null;
  /** 通常決済のとき (お客様がガス代を払う) */
  readonly standard: string;
  /** ガスレス決済のとき (ガス代なしで払える) */
  readonly gasless: string;
  readonly payers: readonly PricingPayer[];
  /** カードの下に添える一文 (無ければ null)。 */
  readonly note: string | null;
};

export type PricingCell = {
  readonly text: string;
  /** 最低額になった行の印 (「（最低額）」)。無ければ null。 */
  readonly mark: string | null;
};

export type PricingExampleTable = {
  readonly caption: string;
  readonly headers: readonly [string, string, string];
  readonly rows: readonly (readonly [PricingCell, PricingCell, PricingCell])[];
  readonly notes: readonly string[];
};

export type PricingLink = {
  readonly label: string;
  readonly href: string;
};

export type PricingContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly backHome: string;
  readonly title: string;
  readonly lead: string;
  /** OpenPay に料金を払う場合 (4 つ)。各文に規約での呼び名と払う人を書く。 */
  readonly cases: readonly string[];
  readonly storeGasNote: string;
  readonly aside: string;

  readonly feesTitle: string;
  readonly dtStandard: string;
  readonly dtGasless: string;
  readonly dtPayer: string;
  readonly rows: readonly PricingRow[];

  readonly examplesTitle: string;
  readonly examplesLead: string;
  readonly examples: readonly PricingExampleTable[];
  readonly storeGasExample: string;

  readonly otherTitle: string;
  readonly otherItems: readonly string[];

  readonly termsTitle: string;
  readonly termsBefore: string;
  readonly termsLinks: readonly [PricingLink, PricingLink];
  readonly termsBetween: string;
  readonly termsAfter: string;
};

// ── 正本からの値 ───────────────────────────────────────────────────────────
const RECOVER_PCT = percentLabel(DISCLOSED_RECOVER_FEE.percentFromJulyBps);
const RECOVER_FLOOR = DISCLOSED_RECOVER_FEE.floorJpyc;
const STOREFRONT_PCT = percentLabel(DISCLOSED_MOBILE_ORDER_FEE.storefrontBps);
const PREORDER_PCT = percentLabel(DISCLOSED_MOBILE_ORDER_FEE.preorderBps);
const TIP_FLOOR = DISCLOSED_TIP_FEE_MODELS.jpycRelay.floorJpyc;
const X402_PCT = percentLabel(DISCLOSED_X402_FEE.bps);
const X402_FLOOR = DISCLOSED_X402_FEE.floorJpyc;
const STORE_GAS_WEI = DISCLOSED_STORE_GAS_WALLET.feeWei;
const STORE_GAS_WEI_JPYC = formatJpycWei(BigInt(DISCLOSED_STORE_GAS_WALLET.feeWei));
const STORE_USDC_CHAIN = DISCLOSED_STORE_USDC_PAYMENT.chainName;
const DUAL_RAIL_CHAIN = DISCLOSED_DUAL_RAIL_USDC.chainName;
// 定数を引数で渡す (cctpFeeDisclosureValues の既定値は自分のモジュールの定数を読み、テストの差し替えが効かないため)。
const CCTP_FEE = cctpFeeDisclosureValues(DISCLOSED_CCTP_FEE);

const jpyc = (wei: bigint) => formatJpycWei(wei);

// ── 計算例 (lib/pricingExamples.ts) ─────────────────────────────────────────
const GASLESS_ROWS = PRICING_EXAMPLE_AMOUNTS.gasless.map(gaslessExample);
const MOBILE_ROWS = PRICING_EXAMPLE_AMOUNTS.mobile.map(mobileExample);
const DIGITAL_ROWS = PRICING_EXAMPLE_AMOUNTS.digital.map(digitalExample);
// 表 A の先頭は「最低額が効く例」(tests/lib/pricingExamples.test.ts が floorApplied を確かめる)。
const GASLESS_FLOOR_ROW = gaslessExample(PRICING_EXAMPLE_AMOUNTS.gasless[0]);
const PREORDER_SPLIT = preorderSplit(PRICING_EXAMPLE_AMOUNTS.preorderSplit);
const STORE_GAS = storeGasExample(PRICING_EXAMPLE_AMOUNTS.storeGas);

function feeCell(example: PricingExample, floorMark: string): PricingCell {
  return { text: `${jpyc(example.feeWei)} JPYC`, mark: example.floorApplied ? floorMark : null };
}

function plainCell(wei: bigint): PricingCell {
  return { text: `${jpyc(wei)} JPYC`, mark: null };
}

// ── 0% の行は正本の値で分岐する (0 を直書きしない) ───────────────────────────
function storeUsdcFee(locale: PricingLocale): string {
  const bps = DISCLOSED_STORE_USDC_PAYMENT.openPayFeeBps;
  if (bps === 0) {
    return locale === 'ja' ? 'OpenPay の x402 利用料はかかりません' : 'no OpenPay x402 fee';
  }
  return locale === 'ja' ? `価格の ${percentLabel(bps)}` : `${percentLabel(bps)} of the price`;
}

function dualRailUsdcClause(locale: PricingLocale): string {
  const bps = DISCLOSED_DUAL_RAIL_USDC.openPayFeeBps;
  if (bps === 0) {
    return locale === 'ja'
      ? `USDC で売られているもの（AI ストアの第三者出品は ${DUAL_RAIL_CHAIN}）には、OpenPay の料金はかかりません。`
      : `Items sold for USDC (third-party AI Store listings use ${DUAL_RAIL_CHAIN}) carry no OpenPay charge.`;
  }
  return locale === 'ja'
    ? `AI ストアの第三者出品を USDC（${DUAL_RAIL_CHAIN}）で買うときは、価格の ${percentLabel(bps)} がかかります。`
    : `Third-party AI Store listings bought with USDC (${DUAL_RAIL_CHAIN}) carry ${percentLabel(bps)} of the price.`;
}

// チップの USDC は開示の方式名で書き分ける (方式を足すと never で型エラーになり、ここを直すまで通らない)。
function tipUsdcBase(locale: PricingLocale): string {
  const model = DISCLOSED_TIP_FEE_MODELS.usdcBase;
  switch (model) {
    case 'paymaster-usdc':
      return locale === 'ja'
        ? 'USDC (Base): 送る方がガス代を USDC で Paymaster に払います。OpenPay は受け取りません。'
        : 'USDC (Base): the sender pays gas in USDC to the Paymaster; OpenPay receives nothing.';
    default: {
      const unknown: never = model;
      return unknown;
    }
  }
}

function tipUsdcArc(locale: PricingLocale): string {
  const model = DISCLOSED_TIP_FEE_MODELS.usdcArc;
  switch (model) {
    case 'standard-usdc-network-fee-no-openpay-fee':
      return locale === 'ja'
        ? 'USDC (Arc): 送る方がネットワーク手数料を USDC で払います。OpenPay は受け取りません。'
        : 'USDC (Arc): the sender pays the network fee in USDC. OpenPay receives nothing.';
    default: {
      const unknown: never = model;
      return unknown;
    }
  }
}

function buildJa(): PricingContent {
  const floorMark = '（最低額）';
  const threshold = jpyc(gaslessUnavailableUpToWei());
  return {
    metaTitle: '料金 — 機能ごとの利用料と計算例 | OpenPay',
    metaDescription:
      'お客様がガス代を払う通常決済なら、OpenPay の料金はかかりません（モバイル注文を除く）。料金がかかる場合・料率・払う人・計算例を、決済QR・レジ・モバイル注文・チップ・デジタル商品ごとにまとめました。',
    backHome: '← OpenPay トップへ',
    title: '料金',
    lead: 'お客様がガス代を払う通常決済で受け取るなら、OpenPay の料金はかかりません（モバイル注文を除きます）。OpenPay に料金を払うのは、次の場合だけです。',
    cases: [
      'JPYC のガスレス決済（OpenPay がお客様のガス代を肩代わりする決済）を受け取るとき — OpenPay 利用料（お店が払います）',
      'お客様が注文ページで払うモバイル注文を受けるとき — モバイル注文の利用料（お店が払います。時間指定の事前注文は、お店が選べばお客様の上乗せにできます）',
      'JPYC でチップを送るとき — ガス代相当（送る方が払います）',
      'JPYC でデジタル商品や API を買うとき（AI エージェントが x402 で払うモバイル注文を含みます） — x402 利用料（買い手が払います）',
    ],
    storeGasNote: `お店がガス代を肩代わりして送るときの OpenPay 利用料は 0 円です（仕組み上、1 回につき ${STORE_GAS_WEI} wei がお客様の支払いに上乗せされ、OpenPay に届きます）。`,
    aside:
      'ネットワーク手数料（ガス代）は OpenPay の料金とは別です。代金やチップは、払う人のウォレットから受け取る人へ直接送られます。OpenPay に届くのは、このページに書いた料金の部分だけです。',

    feesTitle: '機能ごとの料金',
    dtStandard: '通常決済のとき（お客様がガス代を払う）',
    dtGasless: 'ガスレス決済のとき（ガス代なしで払える）',
    dtPayer: '払う人',
    rows: [
      {
        id: 'pay',
        name: '決済QR',
        scope: null,
        standard: 'OpenPay 利用料はかかりません。ネットワーク手数料はお客様がウォレットで払います。',
        gasless: `JPYC: 決済額の ${RECOVER_PCT}・最低 ${RECOVER_FLOOR} JPYC。USDC: OpenPay 利用料はかかりません（Paymaster に払うガス代は、お客様の上乗せにするか、お店が受け取る額から負担するかを、お店が選べます）。`,
        payers: [
          {
            tone: 'shop',
            label: 'お店',
            note: 'OpenPay 利用料は、受け取る額から差し引かれます。お客様は表示した金額だけを払います。',
          },
        ],
        note: null,
      },
      {
        id: 'register',
        name: 'レジ（POS）',
        scope: null,
        standard: 'OpenPay 利用料はかかりません。レジの機能にも料金はかかりません。',
        gasless: `JPYC: 決済額の ${RECOVER_PCT}・最低 ${RECOVER_FLOOR} JPYC。USDC: OpenPay 利用料はかかりません（決済QR と同じ）。`,
        payers: [{ tone: 'shop', label: 'お店', note: 'OpenPay 利用料は、受け取る額から差し引かれます。' }],
        note: null,
      },
      {
        id: 'mobile',
        name: 'モバイル注文',
        scope: null,
        standard: `店内・券売機は注文額の ${STOREFRONT_PCT}、時間指定の事前注文は ${PREORDER_PCT}（モバイル注文の利用料）。`,
        gasless:
          '通常決済と同じ料率です。ガスレス決済の利用料は重ねてかかりません（OpenPay が肩代わりするガス代も含みます）。',
        payers: [
          { tone: 'shop', label: 'お店', note: '店内・券売機' },
          { tone: 'either', label: 'お店かお客様', note: '時間指定の事前注文（お店が選びます）' },
        ],
        note: `AI エージェントが x402 で払うモバイル注文には、この料率ではなく x402 利用料（注文額の ${X402_PCT}・最低 ${X402_FLOOR} JPYC）がかかります。買い手が上乗せし、お店は注文額をそのまま受け取ります。`,
      },
      {
        id: 'tip',
        name: 'チップ',
        scope: null,
        standard: tipUsdcArc('ja'),
        gasless: `JPYC: 送る方がガス代相当として約 ${TIP_FLOOR} JPYC を上乗せします（決済額の ${RECOVER_PCT} はかかりません）。この分は OpenPay に届きます。${tipUsdcBase('ja')}`,
        payers: [{ tone: 'customer', label: '送る方', note: '受け取る方の手数料はありません。' }],
        note: null,
      },
      {
        id: 'store',
        name: 'デジタル商品',
        scope: null,
        standard: 'この支払い方法はありません（デジタル商品はガス代なしで買えます）。',
        gasless: `JPYC: 価格の ${X402_PCT}・最低 ${X402_FLOOR} JPYC（x402 利用料）。USDC (${STORE_USDC_CHAIN}): ${storeUsdcFee('ja')}。`,
        payers: [{ tone: 'customer', label: '買い手', note: '価格に上乗せします。売り手の手数料はありません。' }],
        note: null,
      },
      {
        id: 'storeGas',
        name: 'お店がガス代を肩代わりして送る',
        scope: `店頭レジ・画面に表示した金額指定の決済QR／JPYC（${disclosedStoreGasChains('ja')}）`,
        standard: 'この支払い方法はありません（お客様はガス代を払いません）。',
        gasless: `OpenPay 利用料は 0 円です。ガス代はお店の端末のガス用ウォレットが実費で払います。仕組み上、送金 1 回につき ${STORE_GAS_WEI} wei（${STORE_GAS_WEI_JPYC} JPYC）がお客様の支払いに上乗せされ、OpenPay に届きます。印刷・保存・URL をコピーした QR と、金額を指定しない QR は対象外です。`,
        payers: [
          { tone: 'shop', label: 'お店', note: 'ガス代の実費' },
          { tone: 'customer', label: 'お客様', note: `${STORE_GAS_WEI} wei` },
        ],
        note: null,
      },
    ],

    examplesTitle: '計算例',
    examplesLead: '1 回の支払いの金額です。上の料率から、実際の分け方と同じ計算で出しています。',
    examples: [
      {
        caption: 'ガスレス決済（決済QR・レジ・JPYC）',
        headers: ['決済額', 'OpenPay 利用料', 'お店の受け取り'],
        rows: GASLESS_ROWS.map((e) => [plainCell(e.amountWei), feeCell(e, floorMark), plainCell(e.receiverGetsWei)] as const),
        notes: [
          `${jpyc(GASLESS_FLOOR_ROW.amountWei)} JPYC の ${RECOVER_PCT} は ${jpyc(GASLESS_FLOOR_ROW.percentPartWei)} JPYC なので、最低額の ${RECOVER_FLOOR} JPYC になります。決済額が ${threshold} JPYC 以下のときは、ガスレス決済を使えません。`,
        ],
      },
      {
        caption: 'モバイル注文の利用料',
        headers: ['注文額', `店内・券売機（${STOREFRONT_PCT}）`, `事前注文（${PREORDER_PCT}）`],
        rows: MOBILE_ROWS.map((e) => [plainCell(e.storefront.amountWei), plainCell(e.storefront.feeWei), plainCell(e.preorder.feeWei)] as const),
        notes: [
          `最低額はありません。事前注文でお客様の上乗せを選ぶと、${jpyc(PREORDER_SPLIT.customerAdds.amountWei)} JPYC の注文ならお客様の支払いは ${jpyc(PREORDER_SPLIT.customerAdds.payerPaysWei)} JPYC、お店の受け取りは ${jpyc(PREORDER_SPLIT.customerAdds.receiverGetsWei)} JPYC です（お店が払う場合は、お客様 ${jpyc(PREORDER_SPLIT.shopPays.payerPaysWei)} JPYC・お店 ${jpyc(PREORDER_SPLIT.shopPays.receiverGetsWei)} JPYC）。`,
        ],
      },
      {
        caption: 'デジタル商品（JPYC）',
        headers: ['価格', 'x402 利用料', '買い手の支払い'],
        rows: DIGITAL_ROWS.map((e) => [plainCell(e.amountWei), feeCell(e, floorMark), plainCell(e.payerPaysWei)] as const),
        notes: ['売り手の受け取りは、どの場合も価格と同じです。'],
      },
    ],
    storeGasExample: `お店がガス代を肩代わりして送る場合、${jpyc(STORE_GAS.amountWei)} JPYC の決済なら、お客様の支払いは ${jpyc(STORE_GAS.amountWei)} JPYC と ${STORE_GAS.feeWei} wei、お店の受け取りは ${jpyc(STORE_GAS.receiverGetsWei)} JPYC です（ガス代はお店が別に払います）。`,

    otherTitle: 'このほかの場合',
    otherItems: [
      `AI エージェントが x402 で支払うとき（AI ストアの API やモバイル注文など）: JPYC では、買い手が x402 利用料（価格の ${X402_PCT}・最低 ${X402_FLOOR} JPYC）を上乗せし、売り手は価格をそのまま受け取ります。モバイル注文でも、モバイル注文の利用料ではなく、この x402 利用料だけがかかります。${dualRailUsdcClause('ja')}`,
      'Arc の USDC は通常決済だけで、ネットワーク手数料もお客様が USDC で払います。ほかの通常決済と同じく、OpenPay の料金はかかりません（モバイル注文を除きます）。',
      'ほかのチェーンの USDC から Arc 宛てに払うときは、Circle の転送手数料を払う側が上乗せして負担します。OpenPay はこの分を受け取りません。',
      `ほかのチェーンの USDC から Arc 以外のチェーン宛てに払うときは、Circle の転送手数料（Circle が決める額で、上限は金額の ${CCTP_FEE.cctpMaxPercent}%。${CCTP_FEE.cctpSmallBelowUsdc} USDC 未満の支払いでは ${CCTP_FEE.cctpSmallCapUsdc} USDC）がお店の受け取りから差し引かれます。払う側の支払いは増えません。OpenPay はこの分を受け取らず、OpenPay の料金もかかりません。`,
    ],

    termsTitle: 'くわしい条件',
    termsBefore: '正確な適用条件と支払時期は、',
    termsLinks: [
      { label: '利用規約', href: '/terms' },
      { label: '特商法表記', href: '/tokutei' },
    ],
    termsBetween: 'と',
    termsAfter: 'をご覧ください。',
  };
}

function buildEn(): PricingContent {
  const floorMark = ' (minimum)';
  const threshold = jpyc(gaslessUnavailableUpToWei());
  return {
    metaTitle: 'Pricing — fees by feature, with worked examples | OpenPay',
    metaDescription:
      'Standard payments, where the customer pays the gas, carry no OpenPay charge (mobile orders excepted). See when charges apply, the rates, who pays, and worked examples for payment QR, register, mobile orders, tips and digital goods.',
    backHome: '← Back to OpenPay',
    title: 'Pricing',
    lead: 'When you receive standard payments, where the customer pays the gas, there is no OpenPay charge (except for mobile orders). OpenPay charges apply only in these cases:',
    cases: [
      'When you receive a gasless JPYC payment (OpenPay covers the customer’s gas) — the OpenPay usage fee (paid by the shop)',
      'When you take a mobile order that the customer pays on the order page — the mobile order fee (paid by the shop; for time-specified pre-orders, the shop can choose to add it to the customer’s total)',
      'When someone sends a tip in JPYC — the gas equivalent (paid by the sender)',
      'When someone buys digital goods or an API with JPYC (including mobile orders an AI agent pays over x402) — the x402 fee (paid by the buyer)',
    ],
    storeGasNote: `When the shop pays the gas, the OpenPay usage fee is 0 (by design, ${STORE_GAS_WEI} wei per transfer is added to the customer’s payment and goes to OpenPay).`,
    aside:
      'Network fees (gas) are separate from OpenPay charges. The payment or tip goes straight from the payer’s wallet to the recipient; only the charges listed on this page go to OpenPay.',

    feesTitle: 'Charges by feature',
    dtStandard: 'Standard payment (the customer pays gas)',
    dtGasless: 'Gasless payment (no gas needed)',
    dtPayer: 'Who pays',
    rows: [
      {
        id: 'pay',
        name: 'Payment QR',
        scope: null,
        standard: 'No OpenPay usage fee. The customer pays the network fee from their wallet.',
        gasless: `JPYC: ${RECOVER_PCT} of the payment, minimum ${RECOVER_FLOOR} JPYC. USDC: no OpenPay usage fee (the gas paid in USDC to the Paymaster is either added for the customer or absorbed by the shop — the shop chooses).`,
        payers: [
          {
            tone: 'shop',
            label: 'Shop',
            note: 'The OpenPay usage fee is deducted from what you receive. The customer pays only the amount shown.',
          },
        ],
        note: null,
      },
      {
        id: 'register',
        name: 'Register (POS)',
        scope: null,
        standard: 'No OpenPay usage fee, and the register itself is free.',
        gasless: `JPYC: ${RECOVER_PCT} of the payment, minimum ${RECOVER_FLOOR} JPYC. USDC: no OpenPay usage fee (same as payment QR).`,
        payers: [{ tone: 'shop', label: 'Shop', note: 'The OpenPay usage fee is deducted from what you receive.' }],
        note: null,
      },
      {
        id: 'mobile',
        name: 'Mobile orders',
        scope: null,
        standard: `In-store or kiosk: ${STOREFRONT_PCT} of the order. Time-specified pre-orders: ${PREORDER_PCT} (the mobile order fee).`,
        gasless:
          'Same rates as standard payments. The gasless fee is not added on top (the gas OpenPay covers is included).',
        payers: [
          { tone: 'shop', label: 'Shop', note: 'In-store or kiosk' },
          { tone: 'either', label: 'Shop or customer', note: 'Time-specified pre-orders (the shop chooses)' },
        ],
        note: `Mobile orders an AI agent pays over x402 are charged the x402 fee (${X402_PCT} of the order, minimum ${X402_FLOOR} JPYC) instead of these rates. The buyer adds it, and the shop receives the order amount in full.`,
      },
      {
        id: 'tip',
        name: 'Tips',
        scope: null,
        standard: tipUsdcArc('en'),
        gasless: `JPYC: the sender adds about ${TIP_FLOOR} JPYC as the gas equivalent (the ${RECOVER_PCT} does not apply); this goes to OpenPay. ${tipUsdcBase('en')}`,
        payers: [{ tone: 'customer', label: 'Sender', note: 'No fee to receive.' }],
        note: null,
      },
      {
        id: 'store',
        name: 'Digital goods',
        scope: null,
        standard: 'Not available — digital goods are bought without gas.',
        gasless: `JPYC: ${X402_PCT} of the price, minimum ${X402_FLOOR} JPYC (x402 fee). USDC (${STORE_USDC_CHAIN}): ${storeUsdcFee('en')}.`,
        payers: [{ tone: 'customer', label: 'Buyer', note: 'Added to the price. No seller fee.' }],
        note: null,
      },
      {
        id: 'storeGas',
        name: 'The shop pays the gas',
        scope: `In-store register or a fixed-amount payment QR shown on screen — JPYC on ${disclosedStoreGasChains('en')}`,
        standard: 'Not available — the customer pays no gas.',
        gasless: `OpenPay usage fee: 0. The gas wallet on the shop’s device pays the actual gas. By design, ${STORE_GAS_WEI} wei (${STORE_GAS_WEI_JPYC} JPYC) is added to the customer’s payment per transfer and goes to OpenPay. QR codes that are printed, saved or copied as a URL, or that have no amount, are not eligible.`,
        payers: [
          { tone: 'shop', label: 'Shop', note: 'The actual gas' },
          { tone: 'customer', label: 'Customer', note: `The ${STORE_GAS_WEI} wei` },
        ],
        note: null,
      },
    ],

    examplesTitle: 'Worked examples',
    examplesLead:
      'Amounts for a single payment, calculated from the rates above the same way the payment is actually split.',
    examples: [
      {
        caption: 'Gasless payments (payment QR and register, JPYC)',
        headers: ['Payment', 'OpenPay usage fee', 'Shop receives'],
        rows: GASLESS_ROWS.map((e) => [plainCell(e.amountWei), feeCell(e, floorMark), plainCell(e.receiverGetsWei)] as const),
        notes: [
          `${RECOVER_PCT} of ${jpyc(GASLESS_FLOOR_ROW.amountWei)} JPYC is ${jpyc(GASLESS_FLOOR_ROW.percentPartWei)} JPYC, so the ${RECOVER_FLOOR} JPYC minimum applies. Gasless payments are not available for amounts of ${threshold} JPYC or less.`,
        ],
      },
      {
        caption: 'Mobile order fee',
        headers: ['Order', `In-store or kiosk (${STOREFRONT_PCT})`, `Pre-order (${PREORDER_PCT})`],
        rows: MOBILE_ROWS.map((e) => [plainCell(e.storefront.amountWei), plainCell(e.storefront.feeWei), plainCell(e.preorder.feeWei)] as const),
        notes: [
          `There is no minimum. If a pre-order adds the fee to the customer’s total, a ${jpyc(PREORDER_SPLIT.customerAdds.amountWei)} JPYC order costs the customer ${jpyc(PREORDER_SPLIT.customerAdds.payerPaysWei)} JPYC and the shop receives ${jpyc(PREORDER_SPLIT.customerAdds.receiverGetsWei)} JPYC (if the shop pays: customer ${jpyc(PREORDER_SPLIT.shopPays.payerPaysWei)} JPYC, shop ${jpyc(PREORDER_SPLIT.shopPays.receiverGetsWei)} JPYC).`,
        ],
      },
      {
        caption: 'Digital goods (JPYC)',
        headers: ['Price', 'x402 fee', 'Buyer pays'],
        rows: DIGITAL_ROWS.map((e) => [plainCell(e.amountWei), feeCell(e, floorMark), plainCell(e.payerPaysWei)] as const),
        notes: ['In each case, the seller receives the full price.'],
      },
    ],
    storeGasExample: `When the shop pays the gas, a ${jpyc(STORE_GAS.amountWei)} JPYC payment costs the customer ${jpyc(STORE_GAS.amountWei)} JPYC plus ${STORE_GAS.feeWei} wei, and the shop receives ${jpyc(STORE_GAS.receiverGetsWei)} JPYC (the shop pays the gas separately).`,

    otherTitle: 'Other cases',
    otherItems: [
      `When an AI agent pays over x402 (such as AI Store APIs or mobile orders): for JPYC, the buyer adds the x402 fee (${X402_PCT} of the price, minimum ${X402_FLOOR} JPYC), and the seller receives the price in full. Mobile orders paid this way are charged only this x402 fee, not the mobile order fee. ${dualRailUsdcClause('en')}`,
      'USDC on Arc supports standard payments only, and the customer pays the network fee in USDC as well. As with other standard payments, there is no OpenPay charge (mobile orders excepted).',
      'When paying to Arc with USDC from another chain, the payer adds Circle’s transfer fee. OpenPay receives none of it.',
      `When paying with USDC from another chain to a chain other than Arc, Circle’s transfer fee (set by Circle, capped at ${CCTP_FEE.cctpMaxPercent}% of the amount, or ${CCTP_FEE.cctpSmallCapUsdc} USDC for payments under ${CCTP_FEE.cctpSmallBelowUsdc} USDC) is deducted from what the shop receives. The payer pays no more. OpenPay receives none of it and charges nothing.`,
    ],

    termsTitle: 'Full terms',
    termsBefore: 'For exact conditions and payment timing, see the ',
    termsLinks: [
      { label: 'Terms of Service', href: '/terms' },
      { label: 'Business Disclosure', href: '/tokutei' },
    ],
    termsBetween: ' and the ',
    termsAfter: '.',
  };
}

export const PRICING: Readonly<Record<PricingLocale, PricingContent>> = {
  ja: buildJa(),
  en: buildEn(),
};

/** 未知ロケールは ja (ガイド群と同じ規約)。 */
export function pricingContentFor(locale: string): PricingContent {
  return locale === 'en' ? PRICING.en : PRICING.ja;
}

/** canonical /{locale}/pricing・hreflang ja/en・OG 画像は既定の og-home.webp (料金を焼き込んだ画像は作らない)。 */
export function pricingMetadata(locale: string): Metadata {
  const content = pricingContentFor(locale);
  return guidePageMetadata({
    locale,
    path: '/pricing',
    title: content.metaTitle,
    description: content.metaDescription,
  });
}
