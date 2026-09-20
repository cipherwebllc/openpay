// /agent「OpenPay Agent」の content SOT (ja/en 同梱)。guide 系と同じ規約で、messages/ には
// 置かない (全ページの i18n bundle を太らせない)。料率は lib/legal.ts の DISCLOSED_X402_FEE から
// 描画時に導出する (直書き禁止・掟 14)。
//
// 文言の不変条件 (tests/lib/agentPage.test.ts が検査):
// - 上限は「Agent 側の MCP/SDK で強制」と明示し、OpenPay サーバーが保証するように書かない。
// - 「稼働中 / Active」等、Web から確認していない Agent の状態を表示しない。

import type { Metadata } from 'next';
import { DISCLOSED_X402_FEE } from '@/lib/legal';
import { guidePageMetadata } from '@/lib/guideMetadata';
import type {
  AgentClient,
  AgentConfigField,
  AgentMode,
  AgentOpenInApp,
} from '@/lib/agentSetup';

export type AgentPageContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly connect: {
    readonly title: string;
    readonly lead: string;
    readonly copy: string;
    readonly copied: string;
    readonly openIn: string;
    readonly openInApps: Record<AgentOpenInApp, string>;
    readonly openInNote: string;
    readonly pasteInto: string;
    readonly hosts: readonly string[];
    readonly shellNote: string;
    readonly setupLinkLabel: string;
  };
  readonly modes: {
    readonly title: string;
    readonly items: readonly {
      readonly mode: AgentMode;
      readonly tagline: string;
      readonly name: string;
      readonly body: string;
      readonly guideLabel: string;
      readonly guideHref: string;
    }[];
  };
  readonly safety: {
    readonly title: string;
    readonly enforcedBadge: string;
    readonly body: string;
    readonly points: readonly string[];
  };
  readonly generator: {
    readonly title: string;
    readonly lead: string;
    readonly modeLabel: string;
    readonly modeOptions: Record<AgentMode, string>;
    readonly clientLabel: string;
    readonly clientOptions: Record<AgentClient, string>;
    readonly fields: Record<AgentConfigField, { label: string; hint: string }>;
    readonly catalogTrustLabel: string;
    readonly catalogTrustHint: string;
    readonly humanPaysNote: string;
    readonly invalid: string;
    readonly outputLabel: Record<AgentClient, string>;
    readonly copy: string;
    readonly copied: string;
    readonly keyNote: string;
    readonly feeNote: string;
  };
  readonly wallet: {
    readonly title: string;
    readonly lead: string;
    readonly inputLabel: string;
    readonly inputPlaceholder: string;
    readonly useConnected: string;
    readonly invalidAddress: string;
    readonly balanceLabel: string;
    readonly balanceLoading: string;
    readonly balanceError: string;
    readonly hasBalance: string;
    readonly noBalance: string;
    readonly ownershipNote: string;
    readonly fundTitle: string;
    readonly fundBody: string;
    readonly copyAddress: string;
    readonly copied: string;
    readonly connectCta: string;
    readonly fundCta: string;
  };
  readonly next: {
    readonly title: string;
    readonly body: string;
    readonly storeLabel: string;
    readonly guideLabel: string;
  };
};

function feeText(locale: 'ja' | 'en'): string {
  const percent = DISCLOSED_X402_FEE.bps / 100;
  return locale === 'en'
    ? `${percent}% (minimum ${DISCLOSED_X402_FEE.floorJpyc} JPYC)`
    : `${percent}%（最低 ${DISCLOSED_X402_FEE.floorJpyc} JPYC）`;
}

const ja: AgentPageContent = {
  metaTitle: 'OpenPay Agent — AI に JPYC を使わせる',
  metaDescription:
    'プロンプトを Claude Code / Codex / Hermes に渡すと、Agent 自身が OpenPay の JPYC 支払いをセットアップします。OpenPay はウォレットも秘密鍵も預かりません。',
  eyebrow: 'OpenPay Agent',
  title: 'AI に JPYC を使わせる。',
  subtitle: 'ウォレットも秘密鍵も、OpenPay は預かりません。',
  connect: {
    title: 'Agent を接続',
    lead: 'このプロンプトを Agent に渡すと、Agent 自身がセットアップを進めます。',
    copy: 'セットアッププロンプトをコピー',
    copied: 'コピーしました',
    openIn: 'またはアプリで開く',
    openInApps: { claude: 'Claude', codex: 'Codex' },
    openInNote:
      'デスクトップアプリ (Claude / Codex) が入っていれば、プロンプトを入力した状態で新しいセッションが開きます。送信するのはあなたです。',
    pasteInto: 'コピーして貼り付ける場合',
    hosts: ['Claude Code', 'Codex CLI', 'Hermes'],
    shellNote:
      'シェルを使える Agent 向けです。Claude Desktop など自分で設定を書けない環境では、下の「設定を生成」を使ってください。',
    setupLinkLabel: 'Agent が読む手順 (setup.md) を見る',
  },
  modes: {
    title: '2 つの使い方',
    items: [
      {
        mode: 'human-pays',
        tagline: 'AI に財布を渡さない',
        name: '人が支払う',
        body: 'AI がお店を探し、注文をまとめ、支払いリンクを作ります。最後の支払いは、あなたが自分のウォレットで承認します。鍵は不要です。',
        guideLabel: 'AI で注文するガイド',
        guideHref: '/guide/agent',
      },
      {
        mode: 'agent-pays',
        tagline: 'AI に予算を渡す',
        name: 'Agent が支払う',
        body: '少額の専用 Agent Wallet から、決めた上限の範囲で AI が自動で支払います。AI ストアの有料データや API の購入に使います。',
        guideLabel: 'AI が支払うガイド',
        guideHref: '/guide/ai-pay',
      },
    ],
  },
  safety: {
    title: '支払い上限について',
    enforcedBadge: 'Agent 側の MCP/SDK で強制',
    body: '支払い上限と接続先の制限は、Agent を動かすマシン上の MCP/SDK が適用するローカルの安全設定です。OpenPay のサーバーは上限を知らず、保証もしません。このページが設定を書き換えることもありません。',
    points: [
      '専用の Agent Wallet には、使ってよい金額だけを入れてください。残高が実質的な上限になります。',
      'このページに秘密鍵の入力欄はありません。鍵を求める OpenPay の画面があれば偽物です。',
      '秘密鍵は Agent との会話に貼らず、設定ファイルに自分で追加します。自分で Steward サーバーを運用すれば、鍵を MCP の外に置くこともできます。',
    ],
  },
  generator: {
    title: '設定を生成',
    lead: 'Agent の実行環境へ貼り付ける設定を作ります。貼り付けるのはあなたです。',
    modeLabel: '使い方',
    modeOptions: { 'agent-pays': 'Agent が支払う', 'human-pays': '人が支払う' },
    clientLabel: '利用環境',
    clientOptions: {
      'claude-code': 'Claude Code',
      codex: 'Codex CLI',
      hermes: 'Hermes',
      'claude-desktop': 'Claude Desktop',
    },
    fields: {
      maxPerCallJpyc: { label: '1 回の上限 (JPYC)', hint: '価格と利用料の合計に対する上限' },
      maxSessionJpyc: { label: 'セッションの上限 (JPYC)', hint: 'MCP を再起動するとリセットされます' },
      maxDailyJpyc: { label: '1 日の上限 (JPYC)', hint: '任意・再起動しても保たれます (UTC 日)' },
      allowedHosts: { label: '接続先 (Allowed Hosts)', hint: 'カンマ区切りのホスト名' },
    },
    catalogTrustLabel: 'AI ストア掲載の URL を許可 (CATALOG_TRUST)',
    catalogTrustHint:
      'OpenPay のカタログに載っている URL は、接続先に追加しなくても支払えます。その場合、支払い条件が掲載内容と一致しなければ拒否されます (接続先に自分で追加したホストは照合されません)。',
    humanPaysNote: '「人が支払う」は Agent がウォレットに触れないため、鍵も上限も不要です。',
    invalid: '入力を確認してください',
    outputLabel: {
      'claude-code': 'ターミナルで実行',
      codex: '~/.codex/config.toml に追記',
      hermes: 'ターミナルで実行',
      'claude-desktop': 'claude_desktop_config.json に追記',
    },
    copy: '設定をコピー',
    copied: 'コピーしました',
    keyNote:
      'この設定に秘密鍵は含まれません。鍵なしでも検索と見積もりは動きます。支払いを有効にするには、設定ファイルの env に BUYER_PRIVATE_KEY (専用ウォレットの鍵) か SIGNER_MODE=steward と STEWARD_* を自分で追加してください。',
    feeNote: `買い手は価格に加えて x402 利用料 ${feeText('ja')} を支払います。1 回の上限は合計額で決めてください。`,
  },
  wallet: {
    title: 'Agent Wallet',
    lead: 'OpenPay はウォレットを作りません。Agent に使わせるウォレットのアドレスを入れると、JPYC 残高を確認できます。',
    inputLabel: 'Agent Wallet のアドレス',
    inputPlaceholder: '0x…',
    useConnected: '接続中のウォレットを使う',
    invalidAddress: 'アドレスの形式が正しくありません',
    balanceLabel: 'JPYC 残高',
    balanceLoading: '読み込み中…',
    balanceError: '残高を読み取れませんでした',
    hasBalance: 'JPYC 残高あり',
    noBalance: 'JPYC 残高なし',
    ownershipNote:
      'オンチェーンの公開情報を読み取っているだけです。このアドレスの所有や、Agent が動いているかどうかは確認していません。',
    fundTitle: 'JPYC を入金',
    fundBody:
      'このアドレスへ JPYC を送ってください。OpenPay での x402 支払いは署名 (EIP-3009) で行われるため、支払いに POL は要りません (残った JPYC を後で別のウォレットへ送るときは POL が必要です)。',
    copyAddress: 'アドレスをコピー',
    copied: 'コピーしました',
    connectCta: 'Agent を接続',
    fundCta: '入金する',
  },
  next: {
    title: '買えるものを見る',
    body: 'セットアップが済んだら、Agent が JPYC で購入できるリソースを AI ストアで確認できます。',
    storeLabel: 'AI ストアを開く',
    guideLabel: 'AI が支払うガイド',
  },
};

const en: AgentPageContent = {
  metaTitle: 'OpenPay Agent — let your AI pay in JPYC',
  metaDescription:
    'Hand one prompt to Claude Code, Codex, or Hermes and the agent sets up OpenPay JPYC payments itself. OpenPay never holds your wallet or your private key.',
  eyebrow: 'OpenPay Agent',
  title: 'Let your AI pay in JPYC.',
  subtitle: 'OpenPay never holds your wallet or your private key.',
  connect: {
    title: 'Connect your agent',
    lead: 'Give this prompt to your agent and it runs the setup itself.',
    copy: 'Copy setup prompt',
    copied: 'Copied',
    openIn: 'Or open in',
    openInApps: { claude: 'Claude', codex: 'Codex' },
    openInNote:
      'If the desktop app (Claude / Codex) is installed, a new session opens with the prompt filled in. You press send.',
    pasteInto: 'Or copy and paste into',
    hosts: ['Claude Code', 'Codex CLI', 'Hermes'],
    shellNote:
      'For agents with shell access. If your host cannot write its own config (Claude Desktop, for example), use “Generate a config” below.',
    setupLinkLabel: 'Read the instructions your agent follows (setup.md)',
  },
  modes: {
    title: 'Two ways to use it',
    items: [
      {
        mode: 'human-pays',
        tagline: "Don't hand the AI a wallet",
        name: 'Human pays',
        body: 'The AI finds a shop, builds the order, and creates a checkout link. You approve the final payment from your own wallet. No key needed.',
        guideLabel: 'Guide: order with your AI',
        guideHref: '/guide/agent',
      },
      {
        mode: 'agent-pays',
        tagline: 'Give the AI a budget',
        name: 'Agent pays',
        body: 'The AI pays on its own from a dedicated low-balance agent wallet, inside the limits you set. Use it to buy paid data and APIs on the AI Store.',
        guideLabel: 'Guide: how AI pays',
        guideHref: '/guide/ai-pay',
      },
    ],
  },
  safety: {
    title: 'About spending limits',
    enforcedBadge: 'Enforced by the MCP/SDK on the agent side',
    body: "Spending limits and allowed hosts are local safety settings applied by the MCP/SDK on the machine that runs your agent. OpenPay's servers do not know them and do not guarantee them. This page never changes your agent's settings.",
    points: [
      'Fund the dedicated agent wallet only with what you are willing to spend. Its balance is the effective ceiling.',
      'This page has no private-key field. Any OpenPay screen asking for a key is fake.',
      'Never paste a private key into a chat with your agent; add it to the config file yourself. If you run your own Steward server, the key can stay outside the MCP process.',
    ],
  },
  generator: {
    title: 'Generate a config',
    lead: 'Builds the config to paste into your agent’s environment. You do the pasting.',
    modeLabel: 'Mode',
    modeOptions: { 'agent-pays': 'Agent pays', 'human-pays': 'Human pays' },
    clientLabel: 'Environment',
    clientOptions: {
      'claude-code': 'Claude Code',
      codex: 'Codex CLI',
      hermes: 'Hermes',
      'claude-desktop': 'Claude Desktop',
    },
    fields: {
      maxPerCallJpyc: { label: 'Per-call limit (JPYC)', hint: 'Ceiling for price plus fee' },
      maxSessionJpyc: { label: 'Session limit (JPYC)', hint: 'Resets when the MCP restarts' },
      maxDailyJpyc: { label: 'Daily limit (JPYC)', hint: 'Optional · survives restarts (UTC day)' },
      allowedHosts: { label: 'Allowed hosts', hint: 'Comma-separated host names' },
    },
    catalogTrustLabel: 'Allow URLs listed on the AI Store (CATALOG_TRUST)',
    catalogTrustHint:
      'URLs in the OpenPay catalog are payable without adding their host; for those, payment terms that differ from the listing are refused. Hosts you add yourself are not checked against the catalog.',
    humanPaysNote: '“Human pays” needs no key and no limits: the agent never touches a wallet.',
    invalid: 'Check this value',
    outputLabel: {
      'claude-code': 'Run in your terminal',
      codex: 'Add to ~/.codex/config.toml',
      hermes: 'Run in your terminal',
      'claude-desktop': 'Add to claude_desktop_config.json',
    },
    copy: 'Copy config',
    copied: 'Copied',
    keyNote:
      'This config contains no private key. Search and quotes work without one. To enable paying, add BUYER_PRIVATE_KEY (a dedicated wallet’s key) or SIGNER_MODE=steward with the STEWARD_* values to the env in the config file yourself.',
    feeNote: `The buyer pays the price plus the x402 fee of ${feeText('en')}. Size the per-call limit for the total.`,
  },
  wallet: {
    title: 'Agent wallet',
    lead: 'OpenPay does not create wallets. Enter the address of the wallet your agent uses to check its JPYC balance.',
    inputLabel: 'Agent wallet address',
    inputPlaceholder: '0x…',
    useConnected: 'Use the connected wallet',
    invalidAddress: 'That is not a valid address',
    balanceLabel: 'JPYC balance',
    balanceLoading: 'Loading…',
    balanceError: 'Could not read the balance',
    hasBalance: 'Holds JPYC',
    noBalance: 'No JPYC',
    ownershipNote:
      'This only reads public on-chain data. It does not verify who owns the address or whether an agent is running.',
    fundTitle: 'Fund it with JPYC',
    fundBody:
      'Send JPYC to this address. OpenPay x402 payments are signed authorizations (EIP-3009), so paying needs no POL (moving leftover JPYC out later does).',
    copyAddress: 'Copy address',
    copied: 'Copied',
    connectCta: 'Connect agent',
    fundCta: 'Add funds',
  },
  next: {
    title: 'See what it can buy',
    body: 'Once set up, browse the AI Store for the resources your agent can buy with JPYC.',
    storeLabel: 'Open the AI Store',
    guideLabel: 'Guide: how AI pays',
  },
};

export function agentPageContentFor(locale: string): AgentPageContent {
  return locale === 'en' ? en : ja;
}

export function agentPageMetadata(locale: string): Metadata {
  const c = agentPageContentFor(locale);
  return guidePageMetadata({
    locale,
    path: '/agent',
    title: `${c.metaTitle} · OpenPay`,
    description: c.metaDescription,
  });
}
