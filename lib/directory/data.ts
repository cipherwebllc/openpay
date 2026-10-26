import type {
  DirectoryEntry,
  DirectorySourceType,
} from '@/lib/directory/types';

const VERIFIED_AT = '2026-07-13';

// 週次運用 (JPYC Service Monitor) では、再検証したエントリだけ verifiedAt を、事実を書き換えた
// エントリだけ updatedAt を per-entry で進める。更新時は lib/directory/changelogData.ts の
// MANUAL_CHANGELOG に同一 PR でイベントを追記すること (運用 runbook: plans/jpyc-service-monitor.md)。
function provenance(
  sourceUrl: string,
  attribution: string,
  sourceType: DirectorySourceType = 'official',
  dates: { verifiedAt?: string; updatedAt?: string } = {},
) {
  return {
    sourceUrl,
    sourceType,
    verifiedAt: dates.verifiedAt ?? VERIFIED_AT,
    updatedAt: dates.updatedAt ?? VERIFIED_AT,
    attribution,
  } as const;
}

/**
 * 公開データは一次ソースで確認できた事実だけを保持する。不明な capability は false / []。
 * editorial は OpenPay が本ディレクトリ向けに独自作成した文で、一次ソース本文を転載しない。
 */
export const DIRECTORY_ENTRIES = [
  {
    slug: 'jpyc-ex',
    name: 'JPYC EX',
    nameJa: 'JPYC EX',
    status: 'published',
    // 2026-08-27: Kaia 対応 (発行・償還・アドレス登録) + 発行上限 1日→1回 100万円 (PR TIMES 2026-05-15)
    // 2026-09-25: UPBOND Wallet の接続に対応 (JPYC 公式 X・第 6 回週次更新)
    // 2026-10-06: マイナウォレットが JPYC EX 連携 API で発行・償還をアプリ内で完結 (PR TIMES・第 7 回週次更新)
    // 2026-10-13 (第 8 回): JPYC EX 連携 API の提供開始 (7/13) を changelog に補充 (エントリの事実は不変)
    // 2026-10-18 (第 9 回): 10/16 の Polygon 発行遅延・10/17〜18 の臨時メンテナンスは changelog のみ (エントリの事実は不変)
    // 2026-10-21 (第 10 回): 10/19〜20 の新規アカウント開設の一時停止は changelog のみ (エントリの事実は不変)
    ...provenance('https://jpyc.co.jp/', 'JPYC株式会社', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-06',
    }),
    facts: {
      description: 'JPYCの発行と償還を受け付ける公式プラットフォーム。発行上限は1回あたり100万円。',
      category: 'exchange',
      tags: ['Japan', 'issuance', 'redemption'],
      tokens: ['jpyc'],
      chains: ['avalanche', 'ethereum', 'kaia', 'polygon'],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'JPYCの発行・償還手続きを始める際の公式窓口です。',
      summaryEn: 'The official starting point for JPYC issuance and redemption.',
    },
  },
  {
    slug: 'sbi-vc-trade',
    name: 'SBI VC Trade',
    nameJa: 'SBI VCトレード',
    status: 'published',
    // 2026-10-27 (第 11 回): Shinhan Card との基本合意 (10/21 発表) は changelog のみ (エントリの事実は不変)
    ...provenance('https://www.sbivc.co.jp/', 'SBI VCトレード株式会社', 'official', {
      verifiedAt: '2026-10-27',
    }),
    facts: {
      description: '日本円建ての取引を提供し、USDCを取り扱う国内暗号資産交換業者。',
      category: 'exchange',
      tags: ['Japan', 'JPY', 'exchange'],
      tokens: ['usdc'],
      chains: [],
      languages: ['ja'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '国内でUSDCと日本円の取引先を調べる際の候補です。',
      summaryEn: 'A Japan-based option for users researching USDC and JPY trading.',
    },
  },
  {
    slug: 'bitbank',
    name: 'bitbank',
    nameJa: 'ビットバンク',
    status: 'published',
    ...provenance('https://bitbank.cc/', 'ビットバンク株式会社'),
    facts: {
      description: '日本円建ての暗号資産取引を提供する国内暗号資産交換業者。',
      category: 'exchange',
      tags: ['Japan', 'JPY', 'exchange'],
      tokens: [],
      chains: [],
      languages: ['ja'],
      supportsJpyc: false,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '国内取引所を比較するときに確認できる公式情報源の一つです。',
      summaryEn: 'One official source to consult when comparing Japanese exchanges.',
    },
  },
  {
    slug: 'coincheck',
    name: 'Coincheck',
    nameJa: 'コインチェック',
    status: 'published',
    // 2026-08-27: 電子決済手段等取引業者に登録 (金融庁登録一覧・第00002号・取扱 USDC)。
    // 取扱開始時期は未発表のため tokens は空のまま (sourced-facts-only)。
    ...provenance('https://coincheck.com/', 'コインチェック株式会社', 'official', {
      verifiedAt: '2026-10-27',
      updatedAt: '2026-09-04',
    }),
    facts: {
      description:
        '日本国内で暗号資産の売買サービスを提供する暗号資産交換業者。2026年8月27日に電子決済手段等取引業者 (関東財務局長第00002号・取扱電子決済手段: USDC) として登録。',
      category: 'exchange',
      tags: ['Japan', 'JPY', 'exchange'],
      tokens: [],
      chains: [],
      languages: ['ja'],
      supportsJpyc: false,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '国内の暗号資産売買サービスを調べるための公式サイトです。',
      summaryEn: 'An official site for researching a Japan-based crypto trading service.',
    },
  },
  {
    slug: 'usdc-bridge',
    name: 'USDC Bridge',
    nameJa: 'USDC Bridge',
    status: 'published',
    ...provenance('https://bridge.usdc.com/', 'Circle Internet Group, Inc.'),
    facts: {
      description: 'Circleが提供するUSDCのクロスチェーン移動用Webアプリケーション。',
      category: 'bridge',
      tags: ['Circle', 'cross-chain', 'bridge'],
      tokens: ['usdc'],
      chains: [],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'USDCを別チェーンへ移す手段を確認できるCircleの公式画面です。',
      summaryEn: 'Circle\'s official interface for reviewing cross-chain USDC transfers.',
    },
  },
  {
    slug: 'openpay',
    name: 'OpenPay',
    nameJa: 'OpenPay',
    status: 'published',
    ...provenance('https://open-pay.jp/', 'OpenPay'),
    facts: {
      description: 'JPYCとUSDCの受け取り導線およびx402 APIを提供するオープンソースサービス。',
      category: 'payment',
      tags: ['Japan', 'checkout', 'x402'],
      tokens: ['jpyc', 'usdc'],
      chains: [
        'arbitrum',
        'avalanche',
        'base',
        'ethereum',
        'kaia',
        'optimism',
        'polygon',
      ],
      languages: ['en', 'ja'],
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: true,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'ステーブルコインの受け取りとAPI課金を試せる本ディレクトリの運営サービスです。',
      summaryEn: 'The directory operator\'s service for stablecoin checkout and paid APIs.',
    },
  },
  {
    slug: 'dg-sps',
    name: 'DG Stablecoin Payment Service',
    nameJa: '',
    status: 'published',
    // 2026-08-27 追加: 商用展開開始の公式リリース (2026-08-10) に基づく
    ...provenance(
      'https://www.garage.co.jp/pr/release/20260810/',
      '株式会社デジタルガレージ',
      'official',
      { verifiedAt: '2026-09-04', updatedAt: '2026-08-27' },
    ),
    facts: {
      description:
        '加盟店がAPI接続で導入するステーブルコイン決済基盤。当初はBase上のUSDCに対応し、JCBとDGFTへ先行提供。JPYC対応は計画段階。',
      category: 'payment',
      tags: ['Japan', 'payment', 'stablecoin'],
      tokens: ['usdc'],
      chains: ['base'],
      languages: ['ja'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '大手決済事業者への先行提供が公表された、加盟店向けステーブルコイン決済基盤です。',
      summaryEn: 'A merchant-facing stablecoin payment platform, first offered to major Japanese payment processors.',
    },
  },
  {
    slug: 'jpyc',
    name: 'JPYC',
    nameJa: 'JPYC',
    status: 'published',
    // 2026-08-27: Kaia 追加 = 4 チェーンで発行・流通 (PR TIMES 2026-05-15)
    // 2026-10-08 (第 7 回): αU wallet の Ponta→JPYC 交換・RatioFX との MOU は changelog のみ (エントリの事実は不変)
    // 2026-10-13 (第 8 回): 公取委への情報提供 (10/09) と、補充 2 件 (5/26 ダイナースのポイント交換・7/22 AZ-COM 丸和) も changelog のみ
    // 2026-10-27 (第 11 回): SBJ 銀行・LINE NEXT との覚書 (10/21 発表) は changelog のみ (エントリの事実は不変)
    ...provenance(
      'https://corporate.jpyc.co.jp/news/posts/jpyc-ex-launch',
      'JPYC株式会社',
      'official',
      { verifiedAt: '2026-10-27', updatedAt: '2026-08-27' },
    ),
    facts: {
      description: '日本円と連動するよう設計された電子決済手段のステーブルコイン。',
      category: 'stablecoin',
      tags: ['Japan', 'JPY', 'stablecoin'],
      tokens: ['jpyc'],
      chains: ['avalanche', 'ethereum', 'kaia', 'polygon'],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '日本円建てのオンチェーン決済手段を調べる際の基礎情報です。',
      summaryEn: 'A primary reference when researching a JPY-denominated onchain payment asset.',
    },
  },
  {
    slug: 'circle',
    name: 'Circle',
    nameJa: 'Circle',
    status: 'published',
    ...provenance('https://www.circle.com/usdc', 'Circle Internet Group, Inc.'),
    facts: {
      description: 'USDCに関する公式情報と開発者向けサービスを提供する発行者。',
      category: 'stablecoin',
      tags: ['issuer', 'stablecoin', 'developer'],
      tokens: ['usdc'],
      chains: [],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'USDCの仕様や提供サービスを一次情報で確認するための公式サイトです。',
      summaryEn: 'The official source for checking USDC information and Circle services.',
    },
  },
  {
    slug: 'base',
    name: 'Base',
    nameJa: 'Base',
    status: 'published',
    ...provenance('https://www.base.org/', 'Base'),
    facts: {
      description: 'Coinbaseが構築するEthereum互換のブロックチェーンネットワーク。',
      category: 'network',
      tags: ['EVM', 'L2', 'Coinbase'],
      tokens: ['usdc'],
      chains: ['base'],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: true,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'USDC決済やx402の構築先として参照できるEVMネットワークです。',
      summaryEn: 'An EVM network to consider for USDC payments and x402 applications.',
    },
  },
  {
    slug: 'polygon',
    name: 'Polygon',
    nameJa: 'Polygon',
    status: 'published',
    ...provenance('https://polygon.technology/', 'Polygon Labs'),
    facts: {
      description: 'Ethereum互換のアプリケーションと決済に利用されるブロックチェーンネットワーク。',
      category: 'network',
      tags: ['EVM', 'payments', 'network'],
      tokens: [],
      chains: ['polygon'],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'EVM上の決済アプリケーションを調べる際のネットワーク情報源です。',
      summaryEn: 'A network reference for researching EVM-based payment applications.',
    },
  },
  {
    slug: 'kaia',
    name: 'Kaia',
    nameJa: 'Kaia',
    status: 'published',
    // 2026-09-22: DOZN と JPYC → 韓国ウォン精算の検証 MOU (Kaia Japan 公式 X・第 6 回週次更新)
    // 2026-10-18 (第 9 回): 貢献報酬プログラム CR の対象資産に JPYC を追加 (10/14 発表) は changelog のみ (エントリの事実は不変)
    // 2026-10-27 (第 11 回): その Epoch 4 の開始 (10/21) も changelog のみ
    ...provenance('https://www.kaia.io/ja/about', 'Kaia DLT Foundation', 'official', { verifiedAt: '2026-10-27', updatedAt: '2026-09-22' }),
    facts: {
      description: 'アジア圏のステーブルコイン利用を対象に含むEVM互換レイヤー1ネットワーク。',
      category: 'network',
      tags: ['Asia', 'EVM', 'L1'],
      tokens: ['jpyc'],
      chains: ['kaia'],
      languages: ['en', 'ja'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'アジア向けのEVMネットワークとステーブルコイン動向を追うための入口です。',
      summaryEn: 'A starting point for following an Asia-focused EVM and its stablecoin ecosystem.',
    },
  },
  {
    slug: 'circle-cctp',
    name: 'Circle CCTP',
    nameJa: 'Circle CCTP',
    status: 'published',
    ...provenance(
      'https://www.circle.com/cross-chain-transfer-protocol',
      'Circle Internet Group, Inc.',
    ),
    facts: {
      description: 'USDCを対応チェーン間で移動させるためのCircle公式プロトコル。',
      category: 'bridge',
      tags: ['Circle', 'cross-chain', 'protocol'],
      tokens: ['usdc'],
      chains: [],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'USDCのチェーン間移動を実装する開発者向けの一次情報です。',
      summaryEn: 'A primary developer reference for implementing cross-chain USDC movement.',
    },
  },
  {
    slug: 'metamask',
    name: 'MetaMask',
    nameJa: 'MetaMask',
    status: 'published',
    ...provenance(
      'https://support.metamask.io/manage-crypto/tokens/how-to-display-tokens-in-metamask/',
      'MetaMask',
    ),
    facts: {
      description: 'EVMネットワーク上のERC-20トークンを追加・表示できるセルフカストディウォレット。',
      category: 'wallet',
      tags: ['self-custody', 'EVM', 'ERC-20'],
      tokens: ['jpyc', 'usdc'],
      chains: ['avalanche', 'base', 'ethereum', 'polygon'],
      languages: ['en'],
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '対応ネットワーク上のJPYCやUSDCを管理するウォレット候補です。',
      summaryEn: 'A wallet option for managing JPYC or USDC on compatible networks.',
    },
  },
  {
    slug: 'rabby-wallet',
    name: 'Rabby Wallet',
    nameJa: 'Rabby Wallet',
    status: 'published',
    ...provenance('https://rabby.io/', 'DeBank Global'),
    facts: {
      description: 'EVMエコシステム向けのセルフカストディウォレット。',
      category: 'wallet',
      tags: ['self-custody', 'EVM', 'ERC-20'],
      tokens: ['jpyc', 'usdc'],
      chains: [],
      languages: ['en'],
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'EVM上のJPYCやUSDCを扱う際に比較できるウォレットです。',
      summaryEn: 'A wallet to compare when working with JPYC or USDC on EVM networks.',
    },
  },
  {
    slug: 'coinbase-wallet',
    name: 'Coinbase Wallet',
    nameJa: 'Coinbase Wallet',
    status: 'published',
    ...provenance(
      'https://help.coinbase.com/wallet/getting-started/what-types-of-crypto-does-wallet-support',
      'Coinbase, Inc.',
    ),
    facts: {
      description: 'ERC-20トークンと複数のEVM互換ネットワークに対応するセルフカストディウォレット。',
      category: 'wallet',
      tags: ['self-custody', 'EVM', 'ERC-20'],
      tokens: ['jpyc', 'usdc'],
      chains: [
        'arbitrum',
        'avalanche',
        'base',
        'ethereum',
        'optimism',
        'polygon',
      ],
      languages: ['en'],
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '複数EVMネットワークでトークンを管理するためのウォレット候補です。',
      summaryEn: 'A wallet option for token management across several EVM networks.',
    },
  },
  {
    slug: 'aegis-ai',
    name: 'Aegis',
    nameJa: 'Aegis',
    status: 'published',
    // 2026-08-27: USDC (Base・標準 x402) 販売開始 — 実 402/実購入で確認 (dual-rail 掲載)
    ...provenance('https://aegis-ai.xyz/', 'Aegis', 'official', {
      verifiedAt: '2026-09-04',
      updatedAt: '2026-08-27',
    }),
    facts: {
      description: 'x402対応のAIエージェント向けブリーフィングAPI。JPYCとUSDC (Base) で購入できる。',
      category: 'api',
      tags: ['AI agent', 'x402', 'API'],
      tokens: ['jpyc', 'usdc'],
      chains: ['base', 'polygon'],
      languages: ['en'],
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: true,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'x402対応サービスを探す開発者が確認できるAI関連プロジェクトです。',
      summaryEn: 'An AI project for developers surveying x402-enabled services.',
    },
  },
  {
    slug: 'openpay-x402-demo-api',
    name: 'OpenPay x402 Demo API',
    nameJa: 'OpenPay x402デモAPI',
    status: 'published',
    ...provenance('https://open-pay.jp/api/paid/demo', 'OpenPay'),
    facts: {
      description: 'JPYC支払い後にJSONを返すOpenPay運営のx402デモAPI。',
      category: 'api',
      tags: ['first-party', 'x402', 'paid API'],
      tokens: ['jpyc'],
      chains: ['polygon'],
      languages: ['en'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: true,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'JPYC建てx402のchallengeから解錠までを小さく試せるAPIです。',
      summaryEn: 'A compact API for trying a JPYC x402 challenge and unlock flow.',
    },
  },
  {
    slug: 'openpay-stores-api',
    name: 'OpenPay Stores API',
    nameJa: 'OpenPay店舗データAPI',
    status: 'published',
    ...provenance('https://open-pay.jp/api/paid/stores', 'OpenPay'),
    facts: {
      description: 'JPYC支払い後に審査済みサービス一覧を返すOpenPay運営のx402 API。',
      category: 'api',
      tags: ['first-party', 'x402', 'data API'],
      tokens: ['jpyc'],
      chains: ['polygon'],
      languages: [],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: true,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '有料JSONデータ取得のx402連携を確認するためのfirst-party APIです。',
      summaryEn: 'A first-party API for testing x402 access to paid JSON data.',
    },
  },
  {
    slug: 'openpay-x402-mcp',
    name: 'openpay-x402-mcp',
    nameJa: 'openpay-x402-mcp',
    status: 'published',
    ...provenance(
      'https://www.npmjs.com/package/openpay-x402-mcp',
      'OpenPay',
    ),
    facts: {
      description: 'MCPクライアントからx402リソースの探索と支払いを扱うnpmパッケージ。',
      category: 'developer-tool',
      tags: ['MCP', 'npm', 'x402'],
      tokens: ['jpyc'],
      chains: ['polygon'],
      languages: ['en'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: true,
      supportsMcp: true,
    },
    editorial: {
      summaryJa: 'MCP対応エージェントからx402リソースを利用するための接続ツールです。',
      summaryEn: 'A connector for using x402 resources from MCP-capable agents.',
    },
  },
  {
    slug: 'hashport-wallet',
    name: 'HashPort Wallet',
    nameJa: 'HashPort Wallet',
    status: 'published',
    ...provenance('https://wallet.hashport.com/', '株式会社HashPort', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'JPYC と USDC を扱うノンカストディアルのウォレットアプリ。JPYC EX 連携 API で JPYC の発行・償還の手続きにつなげられ、ダイナース / TRUST CLUB のポイントを JPYC に交換する先にもなっている。',
      category: 'wallet',
      tags: ['Japan', 'wallet', 'non-custodial'],
      tokens: ['jpyc', 'usdc'],
      chains: [],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'JPYCとUSDCを扱える、HashPortのノンカストディアルウォレットです。',
      summaryEn:
        'HashPort\'s non-custodial wallet for JPYC and USDC.',
    },
  },
  {
    slug: 'alpha-u-wallet',
    name: 'αU wallet',
    nameJa: 'αU wallet',
    status: 'published',
    ...provenance('https://newsroom.kddi.com/news/detail/kddi_nr-1182_4741.html', 'au Coincheck Digital Assets株式会社', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        '2026年9月30日に au PAY アプリのミニアプリとして提供が始まったウォレット。Ponta ポイントを JPYC に交換でき (WBTC・ETH も)、保有する JPYC を au PAY 残高にチャージできる。',
      category: 'wallet',
      tags: ['Japan', 'wallet', 'au PAY'],
      tokens: ['jpyc'],
      chains: [],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'au PAYアプリの中でJPYCを扱える、KDDI発表のミニアプリです。',
      summaryEn:
        'A mini app inside au PAY, announced by KDDI, for handling JPYC.',
    },
  },
  {
    slug: 'unifi',
    name: 'Unifi',
    nameJa: '',
    status: 'published',
    ...provenance('https://prtimes.jp/main/html/rd/p/000000318.000054018.html', 'LINE NEXT Inc.', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'LINE NEXT のウォレット。2026年5月22日に JPYC を正式採用し、LINE アプリから Kaia 上の JPYC を使える (決済・送金は順次)。',
      category: 'wallet',
      tags: ['Japan', 'wallet', 'LINE'],
      tokens: ['jpyc'],
      chains: ['kaia'],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'LINEアプリからKaia上のJPYCを扱えるウォレットです。',
      summaryEn:
        'A wallet reachable from the LINE app for using JPYC on Kaia.',
    },
  },
  {
    slug: 'myna-wallet',
    name: 'Mina Wallet',
    nameJa: 'マイナウォレット',
    status: 'published',
    ...provenance('https://prtimes.jp/main/html/rd/p/000000013.000125732.html', 'マイナウォレット株式会社', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'マイナンバーカードで本人確認するノンカストディアルのウォレット。v1.2.2 以上で JPYC EX 連携に対応し、アプリ内で JPYC の発行・償還まで完結できる (償還の送金は Ethereum)。',
      category: 'wallet',
      tags: ['Japan', 'wallet', 'My Number Card'],
      tokens: ['jpyc'],
      chains: ['ethereum'],
      languages: ['ja', 'en'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'マイナンバーカードで始められ、JPYCの発行・償還までアプリ内で進められるウォレットです。',
      summaryEn:
        'A wallet started with a My Number Card that can take JPYC issuance and redemption inside the app.',
    },
  },
  {
    slug: 'startale-app',
    name: 'Startale App',
    nameJa: '',
    status: 'published',
    ...provenance('https://startale.com/', 'Startale Group', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'Startale のアプリ。Soneium 上で Startale USD (USDSC) のスワップ・決済に使え、Earn は USDC の入金を受け付ける。',
      category: 'wallet',
      tags: ['wallet', 'Soneium', 'USDC'],
      tokens: ['usdc'],
      chains: [],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'Soneium上のUSDSCの利用やUSDCの入金に使えるStartaleのアプリです。',
      summaryEn:
        'Startale\'s app for using USDSC on Soneium and depositing USDC.',
    },
  },
  {
    slug: 'hashport-wallet-for-biz',
    name: 'HashPort Wallet for Biz',
    nameJa: 'HashPort Wallet for Biz',
    status: 'published',
    ...provenance('https://wallet.hashport.com/news/forbiz', '株式会社HashPort', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        '店舗・事業者向けのステーブルコイン決済 (2026年1月28日提供開始)。加盟店の決済手数料・月額・登録料は無料で、JPYC は Polygon、USDC は Polygon・Base・Arbitrum (ほかに BSC) で受け取れる (2026年7月13日時点の公式情報)。',
      category: 'payment',
      tags: ['Japan', 'merchant', 'stablecoin'],
      tokens: ['jpyc', 'usdc'],
      chains: ['arbitrum', 'base', 'polygon'],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '店舗や事業者がJPYCとUSDCを受け取るための、HashPortの決済サービスです。',
      summaryEn:
        'HashPort\'s payment service for businesses accepting JPYC and USDC.',
    },
  },
  {
    slug: 'netstars-stablecoin-pay',
    name: 'Stablecoin Pay (NetStars)',
    nameJa: 'Stablecoin Pay (ネットスターズ)',
    status: 'published',
    ...provenance('https://prtimes.jp/main/html/rd/p/000000185.000019526.html', '株式会社ネットスターズ', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'StarPay 加盟店向けのステーブルコイン決済 (2026年7月13日に申込受付開始)。USDC・USDT・JPYC を 1 つのアプリで受け付け、Solana と Polygon に対応する。加盟店手数料は 0.98%。',
      category: 'payment',
      tags: ['Japan', 'merchant', 'StarPay'],
      tokens: ['jpyc', 'usdc'],
      chains: ['polygon'],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'StarPay加盟店がUSDC・USDT・JPYCをまとめて受け付けるための決済サービスです。',
      summaryEn:
        'A payment service letting StarPay merchants accept USDC, USDT and JPYC together.',
    },
  },
  {
    slug: 'hashport-card',
    name: 'HashPort Card',
    nameJa: 'HashPort カード',
    status: 'published',
    ...provenance('https://wallet.hashport.com/news/crypto_credit_card', '株式会社HashPort', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'HashPort とナッジ株式会社のクレジットカード (2025年11月21日に発行開始)。カードの利用分を JPYC で返済でき (返済の受付はナッジ)、還元は JPYC (Avalanche) で受け取れる。',
      category: 'payment',
      tags: ['Japan', 'card', 'JPYC'],
      tokens: ['jpyc'],
      chains: ['avalanche', 'polygon'],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'カードの利用分をJPYCで返済でき、還元もJPYCで受け取れるクレジットカードです。',
      summaryEn:
        'A credit card whose balance can be repaid in JPYC and whose rewards are paid in JPYC.',
    },
  },
  {
    slug: 'diners-trust-club-jpyc',
    name: 'Diners Club / TRUST CLUB points to JPYC',
    nameJa: 'ダイナースクラブ・TRUST CLUB ポイントの JPYC 交換',
    status: 'published',
    ...provenance('https://prtimes.jp/main/html/rd/p/000000320.000054018.html', '三井住友トラストクラブ株式会社', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        '2026年6月1日に始まった交換サービス。ダイナースクラブカード / TRUST CLUB カードのリワードポイントを HashPort Wallet 上で JPYC に交換でき、1,000 JPYC あたりダイナースは 2,500 ポイント、TRUST CLUB は 4,000 ポイント。三井住友トラストクラブ・JPYC・HashPort の共同。',
      category: 'exchange',
      tags: ['Japan', 'points', 'JPYC'],
      tokens: ['jpyc'],
      chains: [],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'ダイナースクラブ/TRUST CLUBのポイントをJPYCに交換できるサービスです。',
      summaryEn:
        'A service for exchanging Diners Club / TRUST CLUB points for JPYC.',
    },
  },
  {
    slug: 'uniple-checkout',
    name: 'uniple checkout',
    nameJa: 'uniple checkout',
    status: 'published',
    ...provenance('https://uniple.io/?lang=ja', '株式会社uniple', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'EC サイトに JPYC 決済を足すプラグイン (2026年7月21日提供開始・WooCommerce など)。x402 の商品同期と Hosted MCP はテクニカルプレビューの段階。',
      category: 'payment',
      tags: ['Japan', 'e-commerce', 'plugin'],
      tokens: ['jpyc'],
      chains: [],
      languages: ['ja'],
      supportsJpyc: true,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'ECサイトにJPYC決済を足せるプラグインで、x402連携はプレビュー段階です。',
      summaryEn:
        'A plugin that adds JPYC checkout to online stores; its x402 integration is still a preview.',
    },
  },
  {
    slug: 'jpysc',
    name: 'JPYSC',
    nameJa: 'JPYSC',
    status: 'published',
    ...provenance('https://www.sbivc.co.jp/jpysc', 'SBI新生信託銀行株式会社', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'SBI 新生信託銀行が発行する日本円連動のステーブルコイン (1 JPYSC = 1 円)。現在は SBI VC トレードの販売所で売買でき、保有は口座内に限られる (入出庫は未対応で、対応時のチェーンは Ethereum の予定)。',
      category: 'stablecoin',
      tags: ['Japan', 'JPY', 'stablecoin'],
      tokens: [],
      chains: [],
      languages: ['ja'],
      supportsJpyc: false,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'SBI新生信託銀行が発行する、円連動のステーブルコインです。',
      summaryEn:
        'A yen-pegged stablecoin issued by SBI Shinsei Trust Bank.',
    },
  },
  {
    slug: 'startale-usd',
    name: 'Startale USD (USDSC)',
    nameJa: '',
    status: 'published',
    ...provenance('https://usd.startale.com/', 'Startale Group', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'Startale Group が M0 の基盤で発行する米ドル連動のステーブルコイン。Soneium 上で提供される。',
      category: 'stablecoin',
      tags: ['USD', 'stablecoin', 'Soneium'],
      tokens: [],
      chains: [],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'Soneium上で提供される、米ドル連動のステーブルコインです。',
      summaryEn:
        'A USD-pegged stablecoin offered on Soneium.',
    },
  },
  {
    slug: 'arc',
    name: 'Arc',
    nameJa: '',
    status: 'published',
    ...provenance('https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet', 'Circle Internet Group, Inc.', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'Circle の L1 ブロックチェーン。パブリックメインネットは2026年9月16日に開始し、ネットワーク手数料は USDC で支払う。SBI グループと住友商事が創設バリデーターに名を連ねる。',
      category: 'network',
      tags: ['Circle', 'L1', 'USDC'],
      tokens: ['usdc'],
      chains: ['arc'],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'ネットワーク手数料をUSDCで払う、CircleのL1ブロックチェーンです。',
      summaryEn:
        'Circle\'s L1 blockchain where network fees are paid in USDC.',
    },
  },
  {
    slug: 'soneium',
    name: 'Soneium',
    nameJa: '',
    status: 'published',
    ...provenance('https://docs.soneium.org/docs/builders/overview', 'Soneium Foundation', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'Ethereum のレイヤー 2 (メインネット・chain ID 1868)。Startale USD (USDSC) が流通する。',
      category: 'network',
      tags: ['Ethereum', 'L2', 'Soneium'],
      tokens: [],
      chains: [],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'Startale USDが流通する、Ethereumのレイヤー2です。',
      summaryEn:
        'An Ethereum layer 2 where Startale USD circulates.',
    },
  },
  {
    slug: 'erpc-x402-solana-rpc',
    name: 'ERPC x402 Solana RPC',
    nameJa: '',
    status: 'published',
    ...provenance('https://prtimes.jp/main/html/rd/p/000000483.000105962.html', 'ELSOUL LABO B.V.', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'Solana の RPC を x402 で従量課金する API (USDC・2026年7月5日公開・Validators DAO と ELSOUL LABO)。決済は Coinbase CDP の facilitator を使う。',
      category: 'api',
      tags: ['x402', 'Solana', 'RPC'],
      tokens: ['usdc'],
      chains: [],
      languages: ['ja', 'en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: true,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'Solana RPCをx402とUSDCで従量課金で使えるAPIです。',
      summaryEn:
        'A Solana RPC API billed per use via x402 in USDC.',
    },
  },
  {
    slug: 'circle-gateway',
    name: 'Circle Gateway',
    nameJa: '',
    status: 'published',
    ...provenance('https://developers.circle.com/gateway', 'Circle Internet Group, Inc.', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        '複数のチェーンにまたがる 1 つの USDC 残高を扱う開発者向けサービス。Gateway Nanopayments で x402 によるガス不要の少額 USDC 支払い (最小 0.000001 ドル) を提供する。',
      category: 'developer-tool',
      tags: ['Circle', 'USDC', 'x402'],
      tokens: ['usdc'],
      chains: ['arbitrum', 'arc', 'avalanche', 'base', 'ethereum', 'optimism', 'polygon'],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: true,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '複数チェーンのUSDC残高をまとめ、x402の少額支払いにも使える開発者向けサービスです。',
      summaryEn:
        'A developer service that unifies USDC balances across chains and supports small x402 payments.',
    },
  },
  {
    slug: 'coinbase-x402-facilitator',
    name: 'Coinbase CDP x402 Facilitator',
    nameJa: '',
    status: 'published',
    ...provenance('https://docs.cdp.coinbase.com/x402/seller/facilitator', 'Coinbase', 'official', {
      verifiedAt: '2026-10-21',
      updatedAt: '2026-10-21',
    }),
    facts: {
      description:
        'x402 の支払いを検証・精算する Coinbase のホスト型 facilitator。ドル建ての価格は各ネットワークの既定の USDC で支払われ、メインネットは Base・Polygon・Arbitrum・Monad・World・Solana に対応。毎月 1,000 件まで無料、超過分は 1 件 0.001 ドル。',
      category: 'developer-tool',
      tags: ['x402', 'facilitator', 'USDC'],
      tokens: ['usdc'],
      chains: ['arbitrum', 'base', 'polygon'],
      languages: ['en'],
      supportsJpyc: false,
      supportsUsdc: true,
      supportsX402: true,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: 'x402の支払いを検証・精算するCoinbaseのホスト型facilitatorです。',
      summaryEn:
        'Coinbase\'s hosted facilitator for verifying and settling x402 payments.',
    },
  },
  {
    slug: 'directory-draft-fixture',
    name: 'Directory Draft Fixture',
    nameJa: '',
    status: 'draft',
    ...provenance('https://open-pay.jp/', 'OpenPay', 'manual'),
    facts: {
      description: '非公開フェンスの検証だけに使う手動登録のダミー。',
      category: 'developer-tool',
      tags: [],
      tokens: [],
      chains: [],
      languages: [],
      supportsJpyc: false,
      supportsUsdc: false,
      supportsX402: false,
      supportsMcp: false,
    },
    editorial: {
      summaryJa: '公開APIには出さないテスト用エントリです。',
      summaryEn: 'A test-only entry that must never reach public APIs.',
    },
  },
] as const satisfies readonly DirectoryEntry[];
