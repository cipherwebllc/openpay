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
  formatJpycWei,
  gaslessExample,
  gaslessUnavailableUpToWei,
  percentLabel,
} from '@/lib/pricingExamples';

export type PricingLocale = 'ja' | 'en';

/** 払う人のピルの色分け (お店 = emerald / お客様・送る方・買い手 = blue / どちらも = slate)。色だけに頼らず文字でも書く。 */
export type PricingPayerTone = 'shop' | 'customer' | 'either';

export type PricingPayer = {
  readonly tone: PricingPayerTone;
  readonly label: string;
  /** ピルの横の補足 (無ければ null)。 */
  readonly note: string | null;
};

/** 冒頭の「料金がかかるのは、この 4 つだけ」のカード。 */
export const PRICING_SUMMARY_IDS = ['gasless', 'mobile', 'tip', 'digital'] as const;
export type PricingSummaryId = (typeof PRICING_SUMMARY_IDS)[number];

export type PricingSummaryCase = {
  readonly id: PricingSummaryId;
  /** 場面の名前 (カードの見出し) */
  readonly name: string;
  /** 大きく出す料率 */
  readonly focal: string;
  /** 料率の下の補足 (最低額など・無ければ null) */
  readonly focalSub: string | null;
  /** 規約での呼び名 */
  readonly feeName: string;
  readonly payer: PricingPayer;
  /** 1 行の説明 */
  readonly detail: string;
};

/** 行の並び (テストが ja/en でこの並びを確かめる)。 */
export const PRICING_ROW_IDS = ['pay', 'mobile', 'tip', 'store', 'storeGas'] as const;
export type PricingRowId = (typeof PRICING_ROW_IDS)[number];

/** 表の 1 マスの値。rail = 決済の種類 (JPYC・USDC など・無ければ null)・value = OpenPay に届く料金。 */
export type PricingValue = {
  readonly rail: string | null;
  readonly value: string;
};

export type PricingRow = {
  readonly id: PricingRowId;
  readonly name: string;
  /** 機能名の下の補足 (対象の範囲)。 */
  readonly scope: string | null;
  /** 通常決済のとき (お客様がガス代を払う) */
  readonly standard: readonly PricingValue[];
  /** ガスレス決済のとき (ガス代なしで払える) */
  readonly gasless: readonly PricingValue[];
  readonly payers: readonly PricingPayer[];
  /** 「くわしく」の中の文 */
  readonly details: readonly string[];
};

/** 計算機の 4 つの場面 (lib/pricingMath.ts の式と 1 対 1)。 */
export const PRICING_CALC_MODE_IDS = ['gasless', 'storefront', 'preorder', 'digital'] as const;
export type PricingCalcModeId = (typeof PRICING_CALC_MODE_IDS)[number];

export type PricingCalcMode = {
  readonly id: PricingCalcModeId;
  readonly name: string;
  readonly payer: PricingPayer;
  /** 式の 3 つの欄の名前 (左 − / + 中 = 右) */
  readonly labels: readonly [string, string, string];
  /** 結果の下の一文 (無ければ null) */
  readonly note: string | null;
};

export type PricingCalcCopy = {
  readonly title: string;
  readonly lead: string;
  readonly amountLabel: string;
  readonly unit: string;
  readonly presetsLabel: string;
  readonly floorMark: string;
  readonly modes: readonly PricingCalcMode[];
  /** ガスレス決済を使えない額のとき */
  readonly unavailable: string;
  /** 事前注文をお客様の上乗せにした場合の 1 行 (lead payer 額 sep receiver 額) */
  readonly preorderAltLead: string;
  readonly preorderAltSep: string;
  readonly preorderAltPayer: string;
  readonly preorderAltReceiver: string;
  /** 金額が空のとき */
  readonly emptyHint: string;
  /** 最低額の説明 (計算機の下・静的) */
  readonly floorNote: string;
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

  readonly summaryTitle: string;
  readonly summary: readonly PricingSummaryCase[];
  /** ガス代は別・代金は直接届く */
  readonly trust: readonly string[];

  readonly calc: PricingCalcCopy;

  readonly feesTitle: string;
  readonly feesLead: string;
  readonly colFeature: string;
  readonly dtStandard: string;
  readonly dtStandardDef: string;
  readonly dtGasless: string;
  readonly dtGaslessDef: string;
  readonly dtPayer: string;
  readonly detailsLabel: string;
  readonly rows: readonly PricingRow[];

  readonly otherTitle: string;
  readonly otherTitles: readonly string[];
  readonly otherItems: readonly string[];

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
const DUAL_RAIL_ARC_CHAIN = DISCLOSED_DUAL_RAIL_USDC.arcChainName;
// 定数を引数で渡す (cctpFeeDisclosureValues の既定値は自分のモジュールの定数を読み、テストの差し替えが効かないため)。
const CCTP_FEE = cctpFeeDisclosureValues(DISCLOSED_CCTP_FEE);

const jpyc = (wei: bigint) => formatJpycWei(wei);

// ── 最低額の説明 (計算機の下の静的な一文) ──────────────────────────────────────
// gasless の先頭は「最低額が効く例」(tests/lib/pricingExamples.test.ts が floorApplied を確かめる)。
const GASLESS_FLOOR_ROW = gaslessExample(PRICING_EXAMPLE_AMOUNTS.gasless[0]);

// ── 0% の行は正本の値で分岐する (0 を直書きしない) ───────────────────────────
function storeUsdcFee(locale: PricingLocale): string {
  const bps = DISCLOSED_STORE_USDC_PAYMENT.openPayFeeBps;
  if (bps === 0) {
    return locale === 'ja' ? 'OpenPay の x402 利用料はかかりません' : 'no OpenPay x402 fee';
  }
  return locale === 'ja' ? `価格の ${percentLabel(bps)}` : `${percentLabel(bps)} of the price`;
}

/** 表のマスに入れる短い値 (0 なら「なし」)。 */
function storeUsdcValue(locale: PricingLocale): string {
  const bps = DISCLOSED_STORE_USDC_PAYMENT.openPayFeeBps;
  if (bps === 0) return locale === 'ja' ? 'なし' : 'None';
  return percentLabel(bps);
}

function dualRailUsdcClause(locale: PricingLocale): string {
  const bps = DISCLOSED_DUAL_RAIL_USDC.openPayFeeBps;
  if (bps === 0) {
    return locale === 'ja'
      ? `USDC で売られているもの（AI ストアの第三者出品は ${DUAL_RAIL_CHAIN}。出品者が有効にしていれば ${DUAL_RAIL_ARC_CHAIN} も）には、OpenPay の料金はかかりません。`
      : `Items sold for USDC (third-party AI Store listings use ${DUAL_RAIL_CHAIN}, plus ${DUAL_RAIL_ARC_CHAIN} where the seller enables it) carry no OpenPay charge.`;
  }
  return locale === 'ja'
    ? `AI ストアの第三者出品を USDC（${DUAL_RAIL_CHAIN}。出品者が有効にしていれば ${DUAL_RAIL_ARC_CHAIN} も）で買うときは、価格の ${percentLabel(bps)} がかかります。`
    : `Third-party AI Store listings bought with USDC (${DUAL_RAIL_CHAIN}, or ${DUAL_RAIL_ARC_CHAIN} where the seller enables it) carry ${percentLabel(bps)} of the price.`;
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
  const threshold = jpyc(gaslessUnavailableUpToWei());
  const shop = (note: string | null = null): PricingPayer => ({ tone: 'shop', label: 'お店が払う', note });
  return {
    metaTitle: '料金 — 機能ごとの利用料と計算例 | OpenPay',
    metaDescription:
      'お客様がガス代を払う通常決済なら、OpenPay の料金はかかりません（モバイル注文を除く）。料金がかかる場合・料率・払う人・計算例を、決済QR・レジ・モバイル注文・チップ・デジタル商品ごとにまとめました。',
    backHome: '← OpenPay トップへ',
    title: '料金',
    lead: 'お客様がガス代を払う通常決済なら、OpenPay の料金はかかりません（モバイル注文を除きます）。',

    summaryTitle: '料金がかかるのは、この 4 つです',
    summary: [
      {
        id: 'gasless',
        name: 'JPYC のガスレス決済',
        focal: RECOVER_PCT,
        focalSub: `最低 ${RECOVER_FLOOR} JPYC`,
        feeName: 'OpenPay 利用料',
        payer: shop(),
        detail: 'お客様のガス代を OpenPay が肩代わりする決済（決済QR・レジ）',
      },
      {
        id: 'mobile',
        name: 'モバイル注文',
        focal: STOREFRONT_PCT,
        focalSub: `事前注文は ${PREORDER_PCT}`,
        feeName: 'モバイル注文の利用料',
        payer: shop(),
        detail: '注文ページで払う注文。事前注文はお客様の上乗せにもできます',
      },
      {
        id: 'tip',
        name: 'JPYC のチップ',
        focal: `約 ${TIP_FLOOR} JPYC`,
        focalSub: null,
        feeName: 'ガス代相当',
        payer: { tone: 'customer', label: '送る方が払う', note: null },
        detail: '送る方が上乗せします。受け取る方の手数料はありません',
      },
      {
        id: 'digital',
        name: 'JPYC のデジタル商品・API',
        focal: X402_PCT,
        focalSub: `最低 ${X402_FLOOR} JPYC`,
        feeName: 'x402 利用料',
        payer: { tone: 'customer', label: '買い手が払う', note: null },
        detail: '買い手が価格に上乗せ。AI エージェントが x402 で払うモバイル注文も含みます',
      },
    ],
    trust: [
      'ガス代（ネットワーク手数料）は、OpenPay の料金とは別です。',
      '代金やチップは、払う人から受け取る人へ直接届きます。',
    ],

    calc: {
      title: '金額を入れて計算',
      lead: '1 回の支払いを、実際の分け方と同じ式で計算します。',
      amountLabel: '金額',
      unit: 'JPYC',
      presetsLabel: '例',
      floorMark: '最低額',
      modes: [
        {
          id: 'gasless',
          name: 'ガスレス決済（決済QR・レジ）',
          payer: shop(),
          labels: ['お客様の支払い', 'OpenPay 利用料', 'お店の受け取り'],
          note: null,
        },
        {
          id: 'storefront',
          name: 'モバイル注文（店内・券売機）',
          payer: shop(),
          labels: ['注文額', '利用料', 'お店の受け取り'],
          note: null,
        },
        {
          id: 'preorder',
          name: 'モバイル注文（事前注文）',
          payer: { tone: 'either', label: 'お店かお客様が払う', note: null },
          labels: ['注文額', '利用料', 'お店の受け取り'],
          note: null,
        },
        {
          id: 'digital',
          name: 'デジタル商品（JPYC）',
          payer: { tone: 'customer', label: '買い手が払う', note: null },
          labels: ['価格', 'x402 利用料', '買い手の支払い'],
          note: '売り手は価格をそのまま受け取ります。',
        },
      ],
      unavailable: `${threshold} JPYC 以下は、ガスレス決済を使えません。`,
      preorderAltLead: 'お客様の上乗せなら',
      preorderAltSep: '・',
      preorderAltPayer: 'お客様',
      preorderAltReceiver: 'お店',
      emptyHint: '金額を入れると、ここに計算結果が出ます。',
      floorNote: `ガスレス決済の利用料は、${RECOVER_PCT} が ${RECOVER_FLOOR} JPYC に満たないときは ${RECOVER_FLOOR} JPYC です（例: ${jpyc(GASLESS_FLOOR_ROW.amountWei)} JPYC の ${RECOVER_PCT} は ${jpyc(GASLESS_FLOOR_ROW.percentPartWei)} JPYC）。${threshold} JPYC 以下は、ガスレス決済を使えません。`,
    },

    feesTitle: '機能ごとの料金',
    feesLead: '金額は OpenPay に届く料金です（ガス代は含みません）。',
    colFeature: '機能',
    dtStandard: '通常決済',
    dtStandardDef: 'お客様がガス代を払う',
    dtGasless: 'ガスレス決済',
    dtGaslessDef: 'ガス代なしで払える',
    dtPayer: '払う人',
    detailsLabel: 'くわしく',
    rows: [
      {
        id: 'pay',
        name: '決済QR・レジ（POS）',
        scope: null,
        standard: [{ rail: null, value: 'なし' }],
        gasless: [
          { rail: 'JPYC', value: `${RECOVER_PCT}・最低 ${RECOVER_FLOOR} JPYC` },
          { rail: 'USDC', value: 'なし' },
        ],
        payers: [shop()],
        details: [
          '利用料はお店の受け取りから差し引かれ、お客様は表示した金額だけを払います。',
          'USDC のガスレス決済で Paymaster に払うガス代は、お客様の上乗せにするかお店が負担するかを、お店が選べます。',
          'レジの機能そのものに料金はかかりません。',
        ],
      },
      {
        id: 'mobile',
        name: 'モバイル注文',
        scope: null,
        standard: [
          { rail: '店内・券売機', value: STOREFRONT_PCT },
          { rail: '事前注文', value: PREORDER_PCT },
        ],
        gasless: [{ rail: null, value: '通常決済と同じ' }],
        payers: [shop('店内・券売機'), { tone: 'either', label: 'お店かお客様が払う', note: '事前注文' }],
        details: [
          '時間指定の事前注文は、お店が選べばお客様の上乗せにできます。',
          'ガスレス決済の利用料は重ねてかかりません（OpenPay が肩代わりするガス代も含みます）。',
          `AI エージェントが x402 で払う注文には、この料率ではなく x402 利用料（注文額の ${X402_PCT}・最低 ${X402_FLOOR} JPYC）がかかります。買い手が上乗せし、お店は注文額をそのまま受け取ります。`,
        ],
      },
      {
        id: 'tip',
        name: 'チップ',
        scope: null,
        standard: [{ rail: 'USDC (Arc)', value: 'なし' }],
        gasless: [
          { rail: 'JPYC', value: `約 ${TIP_FLOOR} JPYC` },
          { rail: 'USDC (Base)', value: 'なし' },
        ],
        payers: [{ tone: 'customer', label: '送る方が払う', note: null }],
        details: [
          `JPYC: 送る方がガス代相当として約 ${TIP_FLOOR} JPYC を上乗せし、この分は OpenPay に届きます（決済額の ${RECOVER_PCT} はかかりません）。`,
          tipUsdcBase('ja'),
          tipUsdcArc('ja'),
          '受け取る方の手数料はありません。',
        ],
      },
      {
        id: 'store',
        name: 'デジタル商品',
        scope: null,
        standard: [{ rail: null, value: '提供なし' }],
        gasless: [
          { rail: 'JPYC', value: `${X402_PCT}・最低 ${X402_FLOOR} JPYC` },
          { rail: `USDC (${STORE_USDC_CHAIN})`, value: storeUsdcValue('ja') },
        ],
        payers: [{ tone: 'customer', label: '買い手が払う', note: null }],
        details: [
          'デジタル商品はガス代なしで買えます（通常決済はありません）。',
          'JPYC の x402 利用料は、買い手が価格に上乗せします。売り手の手数料はありません。',
          `USDC (${STORE_USDC_CHAIN}): ${storeUsdcFee('ja')}。`,
        ],
      },
      {
        id: 'storeGas',
        name: 'お店がガス代を肩代わりして送る',
        scope: `店頭レジ・画面に表示した金額指定の決済QR／JPYC（${disclosedStoreGasChains('ja')}）`,
        standard: [{ rail: null, value: '提供なし' }],
        gasless: [{ rail: 'JPYC', value: `${STORE_GAS_WEI} wei` }],
        payers: [{ tone: 'customer', label: 'お客様が払う', note: null }],
        details: [
          'OpenPay 利用料は 0 円です。ガス代は、お店の端末のガス用ウォレットが実費で払います。',
          `仕組み上、送金 1 回につき ${STORE_GAS_WEI} wei（${STORE_GAS_WEI_JPYC} JPYC）がお客様の支払いに上乗せされ、OpenPay に届きます。`,
          '印刷・保存・URL をコピーした QR と、金額を指定しない QR は対象外です。',
        ],
      },
    ],

    otherTitle: 'このほかの場合',
    otherTitles: [
      'AI エージェントが x402 で払うとき',
      'Arc の USDC で払うとき',
      'USDC を別のチェーンから Arc へ払うとき',
      'USDC を別のチェーンから Arc 以外へ払うとき',
    ],
    otherItems: [
      `JPYC では、買い手が x402 利用料（価格の ${X402_PCT}・最低 ${X402_FLOOR} JPYC）を上乗せし、売り手は価格をそのまま受け取ります（AI ストアの API やモバイル注文など）。モバイル注文でも、モバイル注文の利用料ではなく、この x402 利用料だけがかかります。${dualRailUsdcClause('ja')}`,
      'QR やチップなどの支払いは通常決済だけで、ネットワーク手数料もお客様が USDC で払います。OpenPay の料金はかかりません（モバイル注文を除きます）。AI エージェントが x402 で払うときは Circle Gateway を通すので、支払いのたびのネットワーク手数料はかかりません（Circle Gateway への USDC の出し入れには、別に費用がかかることがあります）。',
      'Circle の転送手数料は、払う側が上乗せして負担します。OpenPay はこの分を受け取りません。',
      `Circle の転送手数料（Circle が決める額で、上限は金額の ${CCTP_FEE.cctpMaxPercent}%。${CCTP_FEE.cctpSmallBelowUsdc} USDC 未満の支払いでは ${CCTP_FEE.cctpSmallCapUsdc} USDC）が、お店の受け取りから差し引かれます。払う側の支払いは増えません。OpenPay はこの分を受け取らず、料金もかかりません。`,
    ],

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
  const threshold = jpyc(gaslessUnavailableUpToWei());
  const shop = (note: string | null = null): PricingPayer => ({ tone: 'shop', label: 'Shop pays', note });
  return {
    metaTitle: 'Pricing — fees by feature, with worked examples | OpenPay',
    metaDescription:
      'Standard payments, where the customer pays the gas, carry no OpenPay charge (mobile orders excepted). See when charges apply, the rates, who pays, and worked examples for payment QR, register, mobile orders, tips and digital goods.',
    backHome: '← Back to OpenPay',
    title: 'Pricing',
    lead: 'Standard payments, where the customer pays the gas, carry no OpenPay charge (mobile orders excepted).',

    summaryTitle: 'Charges apply in these 4 cases',
    summary: [
      {
        id: 'gasless',
        name: 'Gasless JPYC payments',
        focal: RECOVER_PCT,
        focalSub: `minimum ${RECOVER_FLOOR} JPYC`,
        feeName: 'OpenPay usage fee',
        payer: shop(),
        detail: 'OpenPay covers the customer’s gas (payment QR and register)',
      },
      {
        id: 'mobile',
        name: 'Mobile orders',
        focal: STOREFRONT_PCT,
        focalSub: `pre-orders ${PREORDER_PCT}`,
        feeName: 'Mobile order fee',
        payer: shop(),
        detail: 'Orders paid on the order page. Pre-orders can add it to the customer’s total',
      },
      {
        id: 'tip',
        name: 'JPYC tips',
        focal: `about ${TIP_FLOOR} JPYC`,
        focalSub: null,
        feeName: 'Gas equivalent',
        payer: { tone: 'customer', label: 'Sender pays', note: null },
        detail: 'The sender adds it. No fee to receive',
      },
      {
        id: 'digital',
        name: 'JPYC digital goods and APIs',
        focal: X402_PCT,
        focalSub: `minimum ${X402_FLOOR} JPYC`,
        feeName: 'x402 fee',
        payer: { tone: 'customer', label: 'Buyer pays', note: null },
        detail: 'Added to the price by the buyer, including mobile orders an AI agent pays over x402',
      },
    ],
    trust: [
      'Gas (network fees) is separate from OpenPay charges.',
      'Payments and tips go straight from the payer to the recipient.',
    ],

    calc: {
      title: 'Try an amount',
      lead: 'A single payment, calculated the same way the payment is actually split.',
      amountLabel: 'Amount',
      unit: 'JPYC',
      presetsLabel: 'e.g.',
      floorMark: 'minimum',
      modes: [
        {
          id: 'gasless',
          name: 'Gasless payment (payment QR and register)',
          payer: shop(),
          labels: ['Customer pays', 'OpenPay usage fee', 'Shop receives'],
          note: null,
        },
        {
          id: 'storefront',
          name: 'Mobile order (in-store or kiosk)',
          payer: shop(),
          labels: ['Order', 'Fee', 'Shop receives'],
          note: null,
        },
        {
          id: 'preorder',
          name: 'Mobile order (pre-order)',
          payer: { tone: 'either', label: 'Shop or customer pays', note: null },
          labels: ['Order', 'Fee', 'Shop receives'],
          note: null,
        },
        {
          id: 'digital',
          name: 'Digital goods (JPYC)',
          payer: { tone: 'customer', label: 'Buyer pays', note: null },
          labels: ['Price', 'x402 fee', 'Buyer pays'],
          note: 'The seller receives the full price.',
        },
      ],
      unavailable: `Gasless payments are not available for ${threshold} JPYC or less.`,
      preorderAltLead: 'If added to the customer’s total:',
      preorderAltSep: ' / ',
      preorderAltPayer: 'customer',
      preorderAltReceiver: 'shop',
      emptyHint: 'Enter an amount to see the result here.',
      floorNote: `The gasless fee is ${RECOVER_FLOOR} JPYC when ${RECOVER_PCT} comes to less than that (e.g. ${RECOVER_PCT} of ${jpyc(GASLESS_FLOOR_ROW.amountWei)} JPYC is ${jpyc(GASLESS_FLOOR_ROW.percentPartWei)} JPYC). Gasless payments are not available for ${threshold} JPYC or less.`,
    },

    feesTitle: 'Charges by feature',
    feesLead: 'Amounts are what goes to OpenPay (gas not included).',
    colFeature: 'Feature',
    dtStandard: 'Standard',
    dtStandardDef: 'the customer pays gas',
    dtGasless: 'Gasless',
    dtGaslessDef: 'no gas needed',
    dtPayer: 'Who pays',
    detailsLabel: 'Details',
    rows: [
      {
        id: 'pay',
        name: 'Payment QR and register (POS)',
        scope: null,
        standard: [{ rail: null, value: 'None' }],
        gasless: [
          { rail: 'JPYC', value: `${RECOVER_PCT}, minimum ${RECOVER_FLOOR} JPYC` },
          { rail: 'USDC', value: 'None' },
        ],
        payers: [shop()],
        details: [
          'The fee is deducted from what the shop receives; the customer pays only the amount shown.',
          'For gasless USDC payments, the shop chooses whether the gas paid to the Paymaster is added for the customer or absorbed by the shop.',
          'The register itself is free.',
        ],
      },
      {
        id: 'mobile',
        name: 'Mobile orders',
        scope: null,
        standard: [
          { rail: 'In-store or kiosk', value: STOREFRONT_PCT },
          { rail: 'Pre-order', value: PREORDER_PCT },
        ],
        gasless: [{ rail: null, value: 'Same as standard' }],
        payers: [shop('In-store or kiosk'), { tone: 'either', label: 'Shop or customer pays', note: 'Pre-order' }],
        details: [
          'For time-specified pre-orders, the shop can choose to add the fee to the customer’s total.',
          'The gasless fee is not added on top (the gas OpenPay covers is included).',
          `Mobile orders an AI agent pays over x402 are charged the x402 fee (${X402_PCT} of the order, minimum ${X402_FLOOR} JPYC) instead of these rates. The buyer adds it, and the shop receives the order amount in full.`,
        ],
      },
      {
        id: 'tip',
        name: 'Tips',
        scope: null,
        standard: [{ rail: 'USDC (Arc)', value: 'None' }],
        gasless: [
          { rail: 'JPYC', value: `about ${TIP_FLOOR} JPYC` },
          { rail: 'USDC (Base)', value: 'None' },
        ],
        payers: [{ tone: 'customer', label: 'Sender pays', note: null }],
        details: [
          `JPYC: the sender adds about ${TIP_FLOOR} JPYC as the gas equivalent, which goes to OpenPay (the ${RECOVER_PCT} does not apply).`,
          tipUsdcBase('en'),
          tipUsdcArc('en'),
          'No fee to receive.',
        ],
      },
      {
        id: 'store',
        name: 'Digital goods',
        scope: null,
        standard: [{ rail: null, value: 'Not offered' }],
        gasless: [
          { rail: 'JPYC', value: `${X402_PCT}, minimum ${X402_FLOOR} JPYC` },
          { rail: `USDC (${STORE_USDC_CHAIN})`, value: storeUsdcValue('en') },
        ],
        payers: [{ tone: 'customer', label: 'Buyer pays', note: null }],
        details: [
          'Digital goods are bought without gas (there is no standard payment).',
          'The buyer adds the JPYC x402 fee to the price. No seller fee.',
          `USDC (${STORE_USDC_CHAIN}): ${storeUsdcFee('en')}.`,
        ],
      },
      {
        id: 'storeGas',
        name: 'The shop pays the gas',
        scope: `In-store register or a fixed-amount payment QR shown on screen — JPYC on ${disclosedStoreGasChains('en')}`,
        standard: [{ rail: null, value: 'Not offered' }],
        gasless: [{ rail: 'JPYC', value: `${STORE_GAS_WEI} wei` }],
        payers: [{ tone: 'customer', label: 'Customer pays', note: null }],
        details: [
          'OpenPay usage fee: 0. The gas wallet on the shop’s device pays the actual gas.',
          `By design, ${STORE_GAS_WEI} wei (${STORE_GAS_WEI_JPYC} JPYC) is added to the customer’s payment per transfer and goes to OpenPay.`,
          'QR codes that are printed, saved or copied as a URL, or that have no amount, are not eligible.',
        ],
      },
    ],

    otherTitle: 'Other cases',
    otherTitles: [
      'When an AI agent pays over x402',
      'Paying with USDC on Arc',
      'USDC from another chain to Arc',
      'USDC from another chain to a chain other than Arc',
    ],
    otherItems: [
      `For JPYC, the buyer adds the x402 fee (${X402_PCT} of the price, minimum ${X402_FLOOR} JPYC), and the seller receives the price in full (such as AI Store APIs or mobile orders). Mobile orders paid this way are charged only this x402 fee, not the mobile order fee. ${dualRailUsdcClause('en')}`,
      'Payments by QR, tips and the like are standard payments only; the customer pays the network fee in USDC as well. There is no OpenPay charge (mobile orders excepted). When an AI agent pays over x402, the payment goes through Circle Gateway, so there is no network fee per payment (moving USDC into or out of Circle Gateway may cost extra).',
      'The payer adds Circle’s transfer fee. OpenPay receives none of it.',
      `Circle’s transfer fee (set by Circle, capped at ${CCTP_FEE.cctpMaxPercent}% of the amount, or ${CCTP_FEE.cctpSmallCapUsdc} USDC for payments under ${CCTP_FEE.cctpSmallBelowUsdc} USDC) is deducted from what the shop receives. The payer pays no more. OpenPay receives none of it and charges nothing.`,
    ],

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
