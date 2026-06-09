// /explore ページの curated dApp/取引所カタログ。
//
// SOT は本ファイル。lib/links.ts (offramp 用 home compatible view) とは別物 (簡素な
// shape で十分なため重複は許容)。
// URL 生存確認はリポジトリ運用で 月次目視 (lib/links.ts と同じ運用方針)。
//
// Categories:
// - exchange: 法定通貨 ↔ stablecoin (CEX、JP 居住者向け off-ramp 含む)
// - dex:      on-chain DEX
// - dapp:     stablecoin 利用 Web3 サービス
// - bridge:   cross-chain bridging
// - resource: explorer / analytics / 情報サイト

import type { TokenSymbol } from './tokens';

export type ExploreCategory = 'exchange' | 'dex' | 'dapp' | 'bridge' | 'resource';

export type ExploreBadge = 'jp-only' | 'global' | 'beta';

export type ExploreEntry = {
  /** 一意 ID (kebab-case)、表示には使わず deduplication / test key 用。 */
  id: string;
  /** 表示名。locale で出し分けず単一値 (例 "Uniswap")。 */
  name: string;
  /** 外部 URL (https 必須)。 */
  url: string;
  category: ExploreCategory;
  description: { ja: string; en: string };
  badges?: readonly ExploreBadge[];
  /** 関連 token (該当する場合)。chip 表示で利用。 */
  tokens?: readonly TokenSymbol[];
  /**
   * アフィリエイトリンク (成果報酬を得る広告リンク) か。true のとき UI は
   * 景表法 (ステマ規制) 準拠の「広告」開示チップを出し、rel に sponsored を付す。
   * 既定 (undefined/false) は通常の curated 紹介リンク (非広告)。
   */
  affiliate?: boolean;
};

export const EXPLORE_ENTRIES: readonly ExploreEntry[] = [
  // ─── exchange (JP off-ramp 中心、global 取引所も含む) ───────────────
  {
    id: 'jpyc-official',
    name: 'JPYC 公式',
    url: 'https://jpyc.co.jp/',
    category: 'exchange',
    description: {
      ja: '日本円ステーブルコイン JPYC を 1:1 で発行・償還する公式サイト。日本居住者向け。',
      en: 'Official site of the JPY-pegged stablecoin JPYC, with 1:1 issuance and redemption. For Japan residents.',
    },
    badges: ['jp-only'],
    tokens: ['jpyc'],
  },
  {
    id: 'sbi-vc-trade',
    name: 'SBI VC トレード',
    url: 'https://www.sbivc.co.jp/',
    category: 'exchange',
    description: {
      ja: 'USDC を含む暗号資産を JPY と直接売買できる国内取引所 (SBI グループ)。',
      en: 'A Japanese exchange (SBI Group) that supports direct JPY trading of USDC and other crypto assets.',
    },
    badges: ['jp-only'],
    tokens: ['usdc'],
  },
  {
    id: 'bitbank',
    name: 'bitbank',
    url: 'https://bitbank.cc/',
    category: 'exchange',
    description: {
      ja: 'Polygon ネットワークの USDC を扱う国内取引所。出庫対応チェーンは事前確認推奨。',
      en: 'A Japanese exchange supporting USDC on Polygon. Confirm supported withdrawal chains before use.',
    },
    badges: ['jp-only'],
    tokens: ['usdc'],
  },
  {
    id: 'coincheck',
    name: 'Coincheck',
    url: 'https://coincheck.com/',
    category: 'exchange',
    description: {
      ja: '国内大手暗号資産取引所。マネックスグループ運営。',
      en: 'A major Japanese crypto exchange operated by Monex Group.',
    },
    badges: ['jp-only'],
  },
  {
    id: 'gmo-coin',
    name: 'GMOコイン',
    // A8.net 計測リンク (アフィリエイト)。成果は redirect の a8mat クッキーで成立。
    url: 'https://px.a8.net/svt/ejp?a8mat=2ZL5EQ+2DQLAI+3VI8+5YJRM',
    category: 'exchange',
    description: {
      ja: 'GMOインターネットグループが運営する国内大手暗号資産取引所。日本円での暗号資産売買・送金に対応。',
      en: 'A major Japanese crypto exchange operated by GMO Internet Group, supporting JPY trading and transfers of crypto assets.',
    },
    badges: ['jp-only'],
    affiliate: true,
  },
  {
    id: 'coinbase',
    name: 'Coinbase',
    url: 'https://www.coinbase.com/',
    category: 'exchange',
    description: {
      ja: '米国大手取引所。日本居住者は新規登録不可 (2023 撤退)。',
      en: 'A major US exchange. Currently does not accept new Japan-resident sign-ups (withdrew in 2023).',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'binance',
    name: 'Binance',
    url: 'https://www.binance.com/',
    category: 'exchange',
    description: {
      ja: 'グローバル最大級の暗号資産取引所。日本居住者は Binance Japan を利用 (別アカウント)。',
      en: 'One of the largest global crypto exchanges. Japan residents use Binance Japan (separate account).',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'bitget',
    name: 'Bitget',
    // Bitget アフィリエイトリンク (clacCode 紹介コード)。成果報酬型のため affiliate 扱い (広告開示)。
    url: 'https://www.bitget.com/ja/events/rewards-pack?clacCode=09J57KDA&utmSource=rewardsnew',
    category: 'exchange',
    description: {
      ja: 'スポット・デリバティブ・コピートレードを提供するグローバル暗号資産取引所。USDC など主要通貨を取扱う。',
      en: 'A global crypto exchange offering spot, derivatives and copy trading, supporting USDC and other major assets.',
    },
    badges: ['global'],
    tokens: ['usdc'],
    affiliate: true,
  },
  {
    id: 'zoomex',
    name: 'Zoomex',
    // Zoomex 招待リンク (ref 紹介コード)。成果報酬型のため affiliate 扱い (広告開示)。
    url: 'https://www.zoomex.com/ja-JP/invite/?ref=RJ6XOV',
    category: 'exchange',
    description: {
      ja: '暗号資産デリバティブ (先物・コピートレード) を中心としたグローバル取引所。',
      en: 'A global crypto exchange focused on derivatives (futures and copy trading).',
    },
    badges: ['global'],
    affiliate: true,
  },

  // ─── DEX (on-chain trading) ────────────────────────────────────────
  {
    id: 'uniswap',
    name: 'Uniswap',
    url: 'https://app.uniswap.org/',
    category: 'dex',
    description: {
      ja: '主要 L1/L2 で展開する最大手 DEX。USDC/ETH 等の主要ペアの流動性が深い。',
      en: 'The leading DEX across major L1/L2 chains with deep liquidity for USDC/ETH and other major pairs.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: '1inch',
    name: '1inch',
    url: 'https://app.1inch.io/',
    category: 'dex',
    description: {
      ja: '複数 DEX を横断して最良レートを集約するアグリゲータ。スリッページ最適化に有用。',
      en: 'A DEX aggregator that routes orders across multiple DEXs for best execution and slippage optimization.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'curve',
    name: 'Curve',
    url: 'https://curve.fi/',
    category: 'dex',
    description: {
      ja: 'ステーブルコイン同士の交換に最適化された AMM。USDC/USDT/DAI 等の低スリッページが強み。',
      en: 'An AMM optimized for stablecoin-to-stablecoin swaps with low slippage on USDC/USDT/DAI pairs.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'aerodrome',
    name: 'Aerodrome',
    url: 'https://aerodrome.finance/',
    category: 'dex',
    description: {
      ja: 'Base チェーンのフラグシップ DEX。USDC を含む主要ペアの流動性とインセンティブが厚い。',
      en: 'The flagship DEX on Base, with strong liquidity and incentives for USDC pairs.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'velodrome',
    name: 'Velodrome',
    url: 'https://velodrome.finance/',
    category: 'dex',
    description: {
      ja: 'Optimism のフラグシップ DEX。Aerodrome の OP 版に相当する ve(3,3) 設計。',
      en: 'The flagship DEX on Optimism — the OP counterpart of Aerodrome with the same ve(3,3) design.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },

  // ─── dApp (stablecoin 利用サービス) ─────────────────────────────────
  {
    id: 'mm-portfolio',
    name: 'MetaMask Portfolio',
    url: 'https://portfolio.metamask.io/',
    category: 'dapp',
    description: {
      ja: 'MetaMask 公式のポートフォリオ閲覧 + Swap (Gas Station 機能で gas を JPYC/USDC 等から自動徴収)。',
      en: 'MetaMask official portfolio + Swap (Gas Station can pay gas in JPYC/USDC and other tokens).',
    },
    badges: ['global'],
    tokens: ['jpyc', 'usdc'],
  },
  {
    id: 'hashport-wallet',
    name: 'HashPort Wallet',
    // A8.net 計測リンク (アフィリエイト)。成果は redirect の a8mat クッキーで成立。
    url: 'https://px.a8.net/svt/ejp?a8mat=4B5R05+BDMFX6+5W0S+5YJRM',
    category: 'dapp',
    description: {
      ja: '日本発のマルチチェーン対応ウォレットアプリ。複数チェーンの暗号資産・NFT をスマホで管理でき、対応チェーン上で JPYC / USDC 等の ERC20 も保有できる。',
      en: 'A Japan-based multi-chain wallet app for managing crypto assets and NFTs from your phone; can also hold ERC20s such as JPYC / USDC on supported chains.',
    },
    badges: ['jp-only'],
    tokens: ['jpyc', 'usdc'],
    affiliate: true,
  },
  {
    id: 'oisy-wallet',
    name: 'OISY Wallet',
    // OISY 紹介リンク (referrer)。成果報酬型の紹介のため affiliate 扱い (広告開示)。
    url: 'https://oisy.com/?referrer=1855321185',
    category: 'dapp',
    description: {
      ja: 'Internet Computer 上で動く、拡張機能やシードフレーズ不要のブラウザ完結型マルチチェーンウォレット。ETH / BTC / USDC 等を passkey で管理できる。',
      en: 'A fully on-chain, browser-based multi-chain wallet on the Internet Computer — no extension or seed phrase, managing ETH / BTC / USDC and more via passkeys.',
    },
    badges: ['global'],
    tokens: ['usdc'],
    affiliate: true,
  },
  {
    id: 'safe',
    name: 'Safe',
    url: 'https://app.safe.global/',
    category: 'dapp',
    description: {
      ja: 'マルチシグウォレット標準。共同運営の OpenPay 受取アドレスを safe で管理可能。',
      en: 'The de-facto multisig wallet. Use Safe to manage OpenPay receiving addresses with multiple signers.',
    },
    badges: ['global'],
  },
  {
    id: 'ens',
    name: 'ENS (Ethereum Name Service)',
    url: 'https://app.ens.domains/',
    category: 'dapp',
    description: {
      ja: '`vitalik.eth` のような可読アドレス名。OpenPay の受取先フォームでも解決可能。',
      en: 'Human-readable address names like `vitalik.eth`. Also resolved by OpenPay\'s recipient field.',
    },
    badges: ['global'],
  },
  {
    id: 'gitcoin',
    name: 'Gitcoin',
    url: 'https://www.gitcoin.co/',
    category: 'dapp',
    description: {
      ja: 'OSS / 公共財に USDC 等で寄付できるプラットフォーム。quadratic funding が有名。',
      en: 'Donate to OSS / public goods in USDC and other tokens. Best known for quadratic funding.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'karak',
    name: 'Karak',
    url: 'https://karak.network/',
    category: 'dapp',
    description: {
      ja: 'USDC を re-stake して追加報酬を得るリステーキングプロトコル。',
      en: 'A restaking protocol where USDC can be re-staked for additional yield.',
    },
    badges: ['global', 'beta'],
    tokens: ['usdc'],
  },

  // ─── Bridge (cross-chain) ───────────────────────────────────────────
  {
    id: 'circle-cctp',
    name: 'Circle CCTP',
    url: 'https://www.circle.com/cross-chain-transfer-protocol',
    category: 'bridge',
    description: {
      ja: 'Circle 公式の USDC ネイティブクロスチェーン送金。OpenPay の cross-chain 決済もこの V2 を利用。',
      en: 'Circle\'s official USDC native cross-chain transfer. OpenPay\'s cross-chain payments use CCTP V2.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'across',
    name: 'Across',
    url: 'https://across.to/',
    category: 'bridge',
    description: {
      ja: '高速 cross-chain bridge。L2 ⇄ L1 / L2 ⇄ L2 を short-finality で実行。',
      en: 'A fast cross-chain bridge with short-finality L2 ⇄ L1 and L2 ⇄ L2 transfers.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'stargate',
    name: 'Stargate',
    url: 'https://stargate.finance/',
    category: 'bridge',
    description: {
      ja: 'LayerZero ベースの cross-chain 流動性プロトコル。USDC を含む主要 stablecoin の bridge を提供。',
      en: 'A LayerZero-based cross-chain liquidity protocol, bridging USDC and other major stablecoins.',
    },
    badges: ['global'],
    tokens: ['usdc'],
  },
  {
    id: 'relay',
    name: 'Relay',
    url: 'https://relay.link/',
    category: 'bridge',
    description: {
      ja: '即時 cross-chain swap + bridge。任意 chain・任意 token 経路を 1 トランザクションで実行。',
      en: 'Instant cross-chain swap + bridge — execute any-chain / any-token routes in a single transaction.',
    },
    badges: ['global'],
  },

  // ─── Resource (explorer / analytics / info) ─────────────────────────
  {
    id: 'etherscan',
    name: 'Etherscan',
    url: 'https://etherscan.io/',
    category: 'resource',
    description: {
      ja: 'Ethereum L1 のブロックエクスプローラ。OpenPay 取引履歴の tx hash 検証に。',
      en: 'The block explorer for Ethereum L1 — use it to verify OpenPay transaction hashes.',
    },
    badges: ['global'],
  },
  {
    id: 'polygonscan',
    name: 'Polygonscan',
    url: 'https://polygonscan.com/',
    category: 'resource',
    description: {
      ja: 'Polygon (POL) のブロックエクスプローラ。JPYC・USDC 取引の検証に。',
      en: 'The block explorer for Polygon (POL) — verify JPYC and USDC transactions here.',
    },
    badges: ['global'],
  },
  {
    id: 'basescan',
    name: 'Basescan',
    url: 'https://basescan.org/',
    category: 'resource',
    description: {
      ja: 'Base のブロックエクスプローラ。USDC native chain の取引検証に。',
      en: 'The block explorer for Base — verify USDC native-chain transactions here.',
    },
    badges: ['global'],
  },
  {
    id: 'defillama',
    name: 'DefiLlama',
    url: 'https://defillama.com/',
    category: 'resource',
    description: {
      ja: 'DeFi プロトコルの TVL ランキング・統計データの定番サイト。',
      en: 'The de-facto site for DeFi protocol TVL rankings and statistics.',
    },
    badges: ['global'],
  },
  {
    id: 'l2beat',
    name: 'L2 Beat',
    url: 'https://l2beat.com/',
    category: 'resource',
    description: {
      ja: 'L2 のセキュリティ・TVL・運営状況を可視化する独立リサーチサイト。',
      en: 'An independent research site visualizing L2 security, TVL and operational status.',
    },
    badges: ['global'],
  },
  {
    id: 'dappradar',
    name: 'DappRadar',
    url: 'https://dappradar.com/',
    category: 'resource',
    description: {
      ja: 'dApp の利用ランキング・user 数・transaction 数の集計サイト。',
      en: 'Aggregated rankings, user counts and transaction stats for dApps.',
    },
    badges: ['global'],
  },
];

/** category 順 ('exchange' → 'dex' → 'dapp' → 'bridge' → 'resource') を返す。 */
export const EXPLORE_CATEGORY_ORDER: readonly ExploreCategory[] = [
  'exchange',
  'dex',
  'dapp',
  'bridge',
  'resource',
];

/** category ごとに entry を grouping。category 内の order は EXPLORE_ENTRIES の宣言順を保持。 */
export function entriesByCategory(): Map<ExploreCategory, readonly ExploreEntry[]> {
  const map = new Map<ExploreCategory, ExploreEntry[]>();
  for (const cat of EXPLORE_CATEGORY_ORDER) {
    map.set(cat, []);
  }
  for (const e of EXPLORE_ENTRIES) {
    map.get(e.category)!.push(e);
  }
  return map as Map<ExploreCategory, readonly ExploreEntry[]>;
}
