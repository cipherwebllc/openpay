// /transparency「運用の透明性」の content SOT (ja/en 同梱)。
// page (app/[locale]/transparency/page.tsx) が locale で出し分けて描画する。
//
// 新しい約束を作らず、既存の実装・開示を 1 ページに集約する:
// - 手数料の数値は lib/legal.ts の DISCLOSED_* を補間する。
// - コントラクト表は lib/tokens.ts の TOKEN_DEPLOYMENTS から mainnet のみを抽出する。
// - AI ストア掲載ルールは lib/sellGuide.ts の既存 quality 文言を再利用する。

import {
  DISCLOSED_MOBILE_ORDER_FEE,
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_X402_FEE,
} from './legal';
import { sellGuideContentFor } from './sellGuide';
import { supportedChains } from './chains';
import { TOKEN_DEPLOYMENTS } from './tokens';

export type TransparencyLocale = 'ja' | 'en';

type TransparencyLink = {
  readonly label: string;
  readonly href: string;
};

export type TransparencyContract = {
  readonly token: string;
  readonly chain: string;
  readonly address: string;
};

export type TransparencyContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly title: string;
  readonly subtitle: string;
  readonly backHome: string;

  readonly custodyTitle: string;
  readonly custodyItems: readonly string[];

  readonly contractsTitle: string;
  readonly contractHeaders: {
    readonly token: string;
    readonly chain: string;
    readonly address: string;
  };
  readonly contracts: readonly TransparencyContract[];
  readonly contractNote: string;

  readonly verificationTitle: string;
  readonly verificationItems: readonly string[];
  readonly receiptEndpointLabel: string;
  readonly receiptEndpoint: string;

  readonly feesTitle: string;
  readonly fees: readonly string[];
  readonly feeDetailsLead: string;
  readonly feeLinks: readonly TransparencyLink[];

  readonly refundsTitle: string;
  readonly refundsItems: readonly string[];

  readonly uncertaintyTitle: string;
  readonly uncertaintyItems: readonly string[];

  readonly listingsTitle: string;
  readonly listings: readonly string[];

  readonly metricsTitle: string;
  readonly metricsItems: readonly string[];

  readonly legalLead: string;
  readonly legalLinks: readonly TransparencyLink[];
  readonly guidesLead: string;
  readonly guideLinks: readonly TransparencyLink[];
};

function percentFromBps(bps: number): string {
  return `${bps / 100}%`;
}

// TOKEN_DEPLOYMENTS は NETWORK_ENV に応じた deployment を持つ。表は「この配備が実際に
// 対応しているコントラクト」をそのまま見せる (本番= mainnet 行・testnet 配備= testnet 行)。
// mainnet 限定に絞ると testnet 配備で表が空になり、透明性ページとして偽の空白を作るため
// フィルタしない。アドレス・chain ID の別表は持たない (lib/tokens.ts が単一ソース)。
const MAINNET_CONTRACTS: readonly TransparencyContract[] =
  TOKEN_DEPLOYMENTS.flatMap((deployment) => {
    const chain = supportedChains.find((item) => item.id === deployment.chainId);
    if (!chain) return [];
    return [
      {
        token: deployment.displaySymbol,
        chain: chain.name,
        address: deployment.address,
      },
    ];
  });

const RECEIPT_ENDPOINT = '/api/facilitator/verify-receipt';

const jaSellGuide = sellGuideContentFor('ja');
const enSellGuide = sellGuideContentFor('en');

const ja: TransparencyContent = {
  metaTitle: '運用の透明性 — 資金・検証・手数料・掲載審査',
  metaDescription:
    'OpenPay のノンカストディ設計、対応トークンのコントラクト、決済の検証と確定、手数料、返金・取消、AI ストアの掲載審査を 1 ページで確認できます。',
  title: '運用の透明性',
  subtitle:
    'OpenPay がどのようにお金を扱い、何を保証し、何を保証しないかの事実を 1 ページにまとめています。',
  backHome: '← トップにもどる',

  custodyTitle: '1. 資金を保管しない',
  custodyItems: [
    '決済は買い手のウォレットから売り手のウォレットへ直接送金され、OpenPay は商品代金を受領・保管・精算しません。',
    'ガスレス JPYC の recover 経路では、forwarder コントラクトが 1 トランザクション内で売り手の受取分と OpenPay 利用料を原子的に分割するだけで、OpenPay が残高を保持する瞬間はありません。',
    '売上は売り手のウォレットへ直接着金するため、OpenPay による引き出し承認は不要です。',
  ],

  contractsTitle: '2. 対応トークンとコントラクト',
  contractHeaders: {
    token: 'トークン',
    chain: 'チェーン',
    address: 'コントラクトアドレス',
  },
  contracts: MAINNET_CONTRACTS,
  contractNote:
    'アドレスは、必ずこのページまたは OpenPay・各発行者の公式発表と照合してください。',

  verificationTitle: '3. 決済の検証と確定',
  verificationItems: [
    'x402 は facilitator が支払い署名を verify してから settle します。settle は売り手の受取分と利用料をオンチェーンの 1 トランザクションで原子的に分割します。',
    'facilitator で確定するすべての x402 決済には OpenPay 署名レシートが付き、オフラインでも検証できます。',
    'QR 決済は完了画面と電子レシートのブロックエクスプローラリンクから、オンチェーンのトランザクションを確認できます。画面表示だけは送金の証明ではありません。',
  ],
  receiptEndpointLabel: '署名レシート検証 API',
  receiptEndpoint: RECEIPT_ENDPOINT,

  feesTitle: '4. 手数料の決め方',
  fees: [
    `JPYC ガスレス決済（recover）: 決済額の ${percentFromBps(DISCLOSED_RECOVER_FEE.percentFromJulyBps)}・最低 ${DISCLOSED_RECOVER_FEE.floorJpyc} JPYC。店舗が負担し、利用料は店舗の受取額から決済時に差し引かれます。通常決済（ガスあり）と USDC 経路は対象外です。`,
    `モバイル注文: 店頭・券売機は決済額の ${percentFromBps(DISCLOSED_MOBILE_ORDER_FEE.storefrontBps)}、事前モバイルオーダーは ${percentFromBps(DISCLOSED_MOBILE_ORDER_FEE.preorderBps)}。ガスレス決済の利用料とは重複せず、モバイル注文ではこの料率だけを決済経路を問わず適用します。事前モバイルオーダーは店舗の選択で店舗負担または顧客上乗せです。`,
    `x402 facilitator: 決済額の ${percentFromBps(DISCLOSED_X402_FEE.bps)}・最低 ${DISCLOSED_X402_FEE.floorJpyc} JPYC。買い手側への上乗せで、売り手は表示額をそのまま受け取ります。`,
  ],
  feeDetailsLead: '正確な適用条件と支払時期は、',
  feeLinks: [
    { label: '利用規約', href: '/terms' },
    { label: '特商法表記', href: '/tokutei' },
  ],

  refundsTitle: '5. 返金・取消',
  refundsItems: [
    'ブロックチェーン送金は、確定後は原則として取り消せません。カード決済のようなチャージバックはありません。',
    '実取引の前に、少額でテスト送信し、受取先・トークン・チェーンを確認してください。',
  ],

  uncertaintyTitle: '6. 決済が不明になったとき',
  uncertaintyItems: [
    'pending は送金の証明ではありません。オンチェーンのトランザクションが確定して初めて、支払い済みとして扱えます。',
    'relay の応答が不明なときは署名済みの送信内容をラッチし、読み取り専用の状態確認で同じ送信結果を自動再確認します。新しい署名や通常決済への切り替えを止め、二重支払いを防ぎます。',
  ],

  listingsTitle: '7. 掲載の審査・通報・隔離（AI ストア）',
  listings: [
    '登録時に掲載 URL を検査し、未払いのリクエストへ実在する HTTP 402 支払いゲートが返ることを確認します。誰にでも 200 を返す URL と、OpenPay JPYC 方式でない支払い条件は掲載を拒否します。',
    ...jaSellGuide.quality,
  ],

  metricsTitle: '8. 実績の数え方',
  metricsItems: [
    '実績を公表する場合、KPI は独立した買い手数、第三者間の決済額、再購入率で数えます。',
    '自己購入と first-party の動作確認決済は、これらの実績から除外します。',
  ],

  legalLead: '法務・免責の全文:',
  legalLinks: [
    { label: '利用規約', href: '/terms' },
    { label: 'プライバシーポリシー', href: '/privacy' },
    { label: '免責事項', href: '/disclaimer' },
    { label: '特商法表記', href: '/tokutei' },
  ],
  guidesLead: '具体的な利用手順:',
  guideLinks: [
    { label: 'API を売るガイド', href: '/guide/sell' },
    { label: 'AI が支払うガイド', href: '/guide/ai-pay' },
  ],
};

const en: TransparencyContent = {
  metaTitle: 'Operational transparency — funds, verification, fees, and listings',
  metaDescription:
    'One-page reference for OpenPay’s non-custodial design, supported token contracts, payment verification and finality, fees, reversals, and AI Store listing review.',
  title: 'Operational transparency',
  subtitle:
    'This page brings together the facts about how OpenPay handles money, what it guarantees, and what it does not guarantee.',
  backHome: '← Back to home',

  custodyTitle: '1. We do not custody funds',
  custodyItems: [
    'Payments move directly from the buyer’s wallet to the seller’s wallet. OpenPay does not receive, hold, or settle the purchase principal.',
    'On the gasless JPYC recover path, the forwarder contract only splits the seller amount and the OpenPay fee atomically within one transaction. There is no moment when OpenPay holds the balance.',
    'Sales settle directly to the seller’s wallet, so no withdrawal approval from OpenPay is required.',
  ],

  contractsTitle: '2. Supported tokens and contracts',
  contractHeaders: {
    token: 'Token',
    chain: 'Network',
    address: 'Contract address',
  },
  contracts: MAINNET_CONTRACTS,
  contractNote:
    'Always compare an address with this page or an official announcement from OpenPay and the relevant issuer.',

  verificationTitle: '3. Payment verification and finality',
  verificationItems: [
    'For x402, the facilitator verifies the payment signature before settlement. Settlement atomically splits the seller amount and fee in one on-chain transaction.',
    'Every x402 payment finalized by the facilitator includes an OpenPay-signed receipt that can be verified offline.',
    'For QR payments, the completion screen and electronic receipt link to a block explorer where the on-chain transaction can be checked. The screen alone is not proof of payment.',
  ],
  receiptEndpointLabel: 'Signed-receipt verification API',
  receiptEndpoint: RECEIPT_ENDPOINT,

  feesTitle: '4. How fees are determined',
  fees: [
    `Gasless JPYC payments (recover): ${percentFromBps(DISCLOSED_RECOVER_FEE.percentFromJulyBps)} of the payment, with a ${DISCLOSED_RECOVER_FEE.floorJpyc} JPYC minimum. The merchant bears the fee, which is deducted from the merchant’s receipt at payment time. Standard payments and USDC paths are excluded.`,
    `Mobile ordering: ${percentFromBps(DISCLOSED_MOBILE_ORDER_FEE.storefrontBps)} for in-store or kiosk orders and ${percentFromBps(DISCLOSED_MOBILE_ORDER_FEE.preorderBps)} for pre-orders. It does not stack with the gasless-payment fee; only the mobile-order rate applies regardless of payment path. For pre-orders, the store selects merchant-borne or customer-added.`,
    `x402 facilitator: ${percentFromBps(DISCLOSED_X402_FEE.bps)} of the payment, with a ${DISCLOSED_X402_FEE.floorJpyc} JPYC minimum. It is added on the buyer’s side, and the seller receives the listed amount in full.`,
  ],
  feeDetailsLead: 'For exact applicability and payment timing, see the ',
  feeLinks: [
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Business Disclosure', href: '/tokutei' },
  ],

  refundsTitle: '5. Refunds and cancellation',
  refundsItems: [
    'A blockchain transfer generally cannot be reversed after confirmation. There is no card-style chargeback.',
    'Before a real transaction, send a small test amount and confirm the recipient, token, and network.',
  ],

  uncertaintyTitle: '6. When a payment outcome is unclear',
  uncertaintyItems: [
    'Pending is not proof of payment. A payment is treated as paid only after the on-chain transaction is confirmed.',
    'If the relay response is unclear, OpenPay latches the signed submission and automatically rechecks that same result through a read-only status check. It blocks a new signature and a switch to standard payment to prevent duplicate payment.',
  ],

  listingsTitle: '7. Listing review, reports, and quarantine (AI Store)',
  listings: [
    'At registration, OpenPay probes the listed URL and confirms that an unpaid request receives a real HTTP 402 payment gate. URLs that return 200 to anyone and payment requirements that do not use the OpenPay JPYC method are rejected.',
    ...enSellGuide.quality,
  ],

  metricsTitle: '8. How results are counted',
  metricsItems: [
    'When results are published, the KPIs are independent buyers, payment volume between third parties, and repeat-purchase rate.',
    'Self-purchases and first-party test payments are excluded from those results.',
  ],

  legalLead: 'Full legal and disclaimer text:',
  legalLinks: [
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Privacy Policy', href: '/privacy' },
    { label: 'Disclaimer', href: '/disclaimer' },
    { label: 'Business Disclosure', href: '/tokutei' },
  ],
  guidesLead: 'Practical guides:',
  guideLinks: [
    { label: 'Sell your API', href: '/guide/sell' },
    { label: 'How AI pays', href: '/guide/ai-pay' },
  ],
};

export const TRANSPARENCY = { ja, en } as const;

export function transparencyContentFor(locale: string): TransparencyContent {
  return locale === 'en' ? TRANSPARENCY.en : TRANSPARENCY.ja;
}

/** /transparency の indexable metadata を content SOT から組み立てる。 */
export function transparencyMetadata(locale: string): {
  title: string;
  description: string;
  robots: { index: true; follow: true };
} {
  const content = transparencyContentFor(locale);
  return {
    title: `${content.metaTitle} · OpenPay`,
    description: content.metaDescription,
    robots: { index: true, follow: true },
  };
}
