// /agent「OpenPay Agent」の content SOT (ja/en 同梱)。guide 系と同じ規約で、messages/ には
// 置かない (全ページの i18n bundle を太らせない)。設定生成の追加文言は messages の
// AgentConfigGenerator namespace を /agent だけへ配信する。料率は lib/legal.ts の DISCLOSED_X402_FEE から
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
  readonly ogImageAlt: string;
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
    readonly promptExpand: string;
    readonly promptCollapse: string;
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
    readonly summary: readonly string[];
    readonly detailsLabel: string;
    readonly body: string;
    readonly points: readonly string[];
  };
  readonly generator: {
    readonly title: string;
    readonly summaryHint: string;
    readonly lead: string;
    readonly modeLabel: string;
    readonly clientLabel: string;
    readonly clientOptions: Record<AgentClient, string>;
    readonly fields: Record<Exclude<AgentConfigField, 'kovaWallet' | 'kovaAgentAddress' | 'metamaskAgentAddress'>, { label: string; hint: string }>;
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
    readonly copyShort: string;
    readonly ownershipNote: string;
    readonly fundTitle: string;
    readonly fundBody: string;
    readonly copyAddress: string;
    readonly copied: string;
    readonly connectCta: string;
    readonly fundCta: string;
    readonly changeAddress: string;
    readonly recentTitle: string;
    readonly labelInputLabel: string;
    readonly labelPlaceholder: string;
    readonly linkedAddressConfirm: string;
    readonly useLinkedAddress: string;
    readonly keepSavedAddress: string;
    readonly emptyLead: string;
    readonly emptyConnectCta: string;
    readonly manualEntry: string;
    readonly closeFund: string;
    readonly fundLockedNote: string;
    readonly pendingToOther: string;
    readonly fundFromWallet: {
      readonly title: string;
      readonly amountLabel: string;
      readonly amountPlaceholder: string;
      readonly send: string;
      readonly confirmTitle: string;
      readonly confirmSend: string;
      readonly back: string;
      readonly toLabel: string;
      readonly amountConfirmLabel: string;
      readonly chainLabel: string;
      readonly irreversible: string;
      readonly ownershipWarning: string;
      readonly gasNote: string;
      readonly insufficient: string;
      readonly invalidAmount: string;
      readonly sameWalletNote: string;
      readonly waitingWallet: string;
      readonly sent: string;
      readonly confirmed: string;
      readonly rejected: string;
      readonly failed: string;
      readonly viewTx: string;
    };
  };
  readonly activity: {
    readonly title: string;
    readonly filterAll: string;
    readonly filterIn: string;
    readonly filterOut: string;
    readonly colDate: string;
    readonly colType: string;
    readonly colCounterparty: string;
    readonly colAmount: string;
    readonly viaOpenPay: string;
    readonly viewTx: string;
    readonly more: string;
    readonly empty: string;
    readonly filterEmpty: string;
    readonly hiddenOnly: string;
    readonly loading: string;
    readonly error: string;
    readonly busy: string;
    readonly unsupported: string;
    readonly explorerLink: string;
    readonly truncatedNote: string;
    readonly refreshing: string;
    readonly stat24h: string;
    readonly stat7d: string;
    readonly statsPartial: string;
    readonly publicNote: string;
  };
  /** 購入 (何を買ったか)。SIWE ログイン + 初回 1 回の Agent 署名で紐づけ (plans/agent-purchase-web.md v3)。 */
  readonly purchases: {
    readonly title: string;
    readonly lead: string;
    readonly signIn: string;
    readonly connectFirst: string;
    readonly signingIn: string;
    readonly signInError: string;
    readonly signedInAs: string;
    readonly notBoundLead: string;
    readonly notBoundSteps: readonly string[];
    readonly continueAfterSignIn: string;
    readonly verifying: string;
    readonly bound: string;
    readonly bindConfirm: string;
    readonly confirmBind: string;
    readonly cancelBind: string;
    readonly proofAddressMismatch: string;
    readonly proofLinkAddressMismatch: string;
    readonly boundOther: string;
    readonly failures: { readonly [K in 'expired_or_unknown' | 'signature_mismatch' | 'already_used' | 'malformed' | 'binding_limit' | 'storage_error' | 'feature_disabled']: string };
    readonly colDate: string;
    readonly colItem: string;
    readonly colAmount: string;
    readonly viewTx: string;
    readonly originFirstParty: string;
    readonly originListed: string;
    readonly originClaimed: string;
    readonly feeSuffix: string;
    readonly empty: string;
    readonly truncated: string;
    readonly sinceNote: string;
    readonly caveat: string;
    readonly unbind: string;
    readonly unbindConfirm: string;
    readonly bindingsTitle: string;
    readonly bindingsEmpty: string;
    readonly bindingDate: string;
    readonly unbindAddress: string;
    readonly unbindAddressConfirm: string;
    readonly loading: string;
    readonly error: string;
  };
  /** セットアップ後に Agent へそのまま貼れる依頼文 (user 承認 2026-09-22)。 */
  readonly tryPrompts: {
    readonly title: string;
    readonly lead: string;
    readonly copy: string;
    readonly copied: string;
    /** 支払いが起きる依頼文にだけ出す注記。 */
    readonly paidNote: string;
    readonly items: readonly {
      readonly id: 'catalog' | 'buy-monitor' | 'order' | 'history' | 'limits' | 'history-web' | 'switch-signer';
      /** free = 支払いなし / paid = Agent が支払う / human = 人が支払う。 */
      readonly kind: 'free' | 'paid' | 'human';
      readonly tag: string;
      readonly prompt: string;
      /** 依頼文の下に出す補足 (継続用途など)。 */
      readonly hint?: string;
      /** 実際に買った実績 1 件 (時点と当時の価格を明記・tx リンクで検証できる)。 */
      readonly example?: { readonly text: string; readonly linkLabel: string; readonly href: string };
    }[];
  };
  readonly next: {
    readonly title: string;
    readonly body: string;
    readonly storeLabel: string;
    readonly guideLabel: string;
    readonly noteLabel: string;
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
    'プロンプトを 1 つ渡すだけで、Claude・Codex・Hermes が JPYC 支払いを自分でセットアップ。支払い上限は Agent 側で強制、ウォレットも秘密鍵も OpenPay は預かりません。',
  ogImageAlt:
    'OpenPay Agent — AI に JPYC を使わせる。プロンプトを渡すだけで Agent を接続。ウォレットも秘密鍵も OpenPay は預かりません。',
  eyebrow: 'OpenPay Agent',
  title: 'AI に JPYC を使わせる。',
  subtitle: 'ウォレットも秘密鍵も、OpenPay は預かりません。',
  connect: {
    title: 'Agent を接続',
    lead: 'このプロンプトを Agent に渡すだけ。セットアップは Agent が進めます。支払いは、専用ウォレットに入金してからです。',
    copy: 'セットアッププロンプトをコピー',
    copied: 'コピーしました',
    openIn: 'またはアプリで開く',
    openInApps: { claude: 'Claude', codex: 'Codex' },
    openInNote:
      'アプリが入っていれば、プロンプト入りで開きます。送信するのはあなたです。',
    pasteInto: 'コピーして貼り付ける場合',
    hosts: ['Claude Code', 'Codex CLI', 'Hermes'],
    shellNote:
      'シェルを使える Agent 向け。上の「Claude」ボタンは Claude アプリ内の Claude Code で開くので、そのまま使えます。チャットだけの環境 (Agent が設定を書けない) は下の「自分で設定を書く」へ。',
    setupLinkLabel: 'Agent が読む手順 (setup.md) を見る',
    promptExpand: '全文を表示',
    promptCollapse: 'たたむ',
  },
  modes: {
    title: '2 つの使い方',
    items: [
      {
        mode: 'human-pays',
        tagline: 'AI に財布を渡さない',
        name: '人が支払う',
        body: 'AI が注文をまとめ、支払いはあなたが自分のウォレットで承認します。鍵は不要です。',
        guideLabel: 'AI で注文するガイド',
        guideHref: '/guide/agent',
      },
      {
        mode: 'agent-pays',
        tagline: 'AI に予算を渡す',
        name: 'Agent が支払う',
        body: '少額の専用ウォレットから、決めた上限の範囲で AI が支払います。',
        guideLabel: 'AI が支払うガイド',
        guideHref: '/guide/ai-pay',
      },
    ],
  },
  safety: {
    title: '支払い上限について',
    enforcedBadge: 'Agent 側の MCP/SDK で強制',
    summary: [
      '上限を強制するのは Agent 側の MCP です。OpenPay のサーバーは関与しません。',
      '入れるのは失ってもよい少額だけ。残高が実質的な上限です。',
      'このページは秘密鍵を尋ねません。鍵を求める OpenPay の画面は偽物です。',
    ],
    detailsLabel: 'くわしく',
    body: '支払い上限と接続先の制限は、Agent を動かすマシン上の MCP/SDK が適用するローカルの安全設定です。OpenPay のサーバーは上限を知らず、保証もしません。このページが設定を書き換えることもありません。',
    points: [
      '専用の Agent Wallet には、使ってよい金額だけを入れてください。残高が実質的な上限になります。',
      'このページに秘密鍵の入力欄はありません。鍵を求める OpenPay の画面があれば偽物です。',
      'ウォレットの鍵は、Agent を動かすあなたのマシン上で MCP が作って保管します。会話にも OpenPay にも出ません。ただし、あなたとしてコマンドを実行できるものはこの鍵を読めます。入れるのは失ってもよい少額だけにしてください。OpenPay は鍵を復元できません。',
      'どこで動かすかで選べる方式が変わります。PC のローカルで動く Claude Code / Codex なら Local Wallet・Kova・MetaMask Agent Wallet・Steward のどれでも使えます。スマホの Claude アプリの Code やブラウザ版 Claude Code はクラウド上の使い捨て環境で動くため、そこに Local Wallet を作ると鍵ごと消えます (JPYC を入れないでください)。Kova もその環境に CLI と資格情報が必要なので使えません。MetaMask Agent Wallet も MCP と同じマシンに mm のログイン状態が必要なので使えません。スマホやブラウザからは「人が支払う」(決済リンクを自分のウォレットで承認) を選ぶか、Agent に支払わせたい場合は Steward を使ってください。',
    ],
  },
  generator: {
    title: '自分で設定を書く (手動)',
    summaryHint: '支払い方式 (ローカル / Kova / MetaMask) を切り替えるときや、Agent が設定を書けない環境向け',
    lead: 'Agent の実行環境へ貼り付ける設定を作ります。貼り付けるのはあなたです。',
    modeLabel: '使い方',
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
      maxDailyJpyc: { label: '1 日の上限 (JPYC)', hint: '空欄ならセッションの上限と同額が適用されます・再起動しても保たれます (UTC 日)' },
      allowedHosts: { label: '接続先 (Allowed Hosts)', hint: 'カンマ区切りのホスト名' },
    },
    catalogTrustLabel: 'AI ストア掲載の URL を許可 (CATALOG_TRUST)',
    catalogTrustHint:
      'OpenPay のカタログに載っている URL は、接続先に追加しなくても支払えます。その場合、支払い条件が掲載内容と一致しなければ拒否されます (接続先に自分で追加したホストは照合されません)。',
    humanPaysNote: '「人が支払う (自分で承認)」は Agent がウォレットに触れないため、鍵も上限も不要です。',
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
      'この設定に秘密鍵は含まれません。貼り付けて Agent のホストを再起動したら、Agent に「wallet_init を呼んで」と頼んでください。MCP があなたのマシン上でウォレットを作り、アドレスと入金用のリンクだけを返します。そのアドレスへ JPYC を送れば支払いが有効になります。',
    feeNote: `買い手は価格に加えて x402 利用料 ${feeText('ja')} を支払います。1 回の上限は合計額で決めてください。`,
  },
  wallet: {
    title: 'Agent Wallet',
    lead: 'Agent のウォレットアドレスを入れると、JPYC 残高を確認できます。OpenPay はウォレットを作りません。',
    inputLabel: 'Agent Wallet のアドレス',
    inputPlaceholder: '0x…',
    useConnected: '接続中のウォレットを使う',
    invalidAddress: 'アドレスの形式が正しくありません',
    balanceLabel: 'JPYC 残高',
    balanceLoading: '読み込み中…',
    balanceError: '残高を読み取れませんでした',
    copyShort: 'コピー',
    ownershipNote:
      'オンチェーンの公開情報を読み取っているだけです。このアドレスの所有や、Agent が動いているかどうかは確認していません。',
    fundTitle: 'JPYC を入金',
    fundBody:
      'このアドレスへ JPYC を送ってください。OpenPay での x402 支払いは署名 (EIP-3009) で行われるため、支払いに POL は要りません (残った JPYC を後で別のウォレットへ送るときは POL が必要です)。',
    copyAddress: 'アドレスをコピー',
    copied: 'コピーしました',
    connectCta: 'Agent を接続',
    fundCta: '入金する',
    changeAddress: '変更',
    recentTitle: '最近表示した Wallet',
    labelInputLabel: '名前 (任意・この端末だけに保存)',
    labelPlaceholder: '例: Kova',
    linkedAddressConfirm: 'リンクのアドレス {address} は、この端末に保存済みの Agent Wallet と異なります。置き換えますか?',
    useLinkedAddress: 'リンクのアドレスに置き換える',
    keepSavedAddress: '保存済みのアドレスを使う',
    emptyLead: '下の「Agent を接続」で「Agent が支払う」をセットアップすると、あなたのマシン上にウォレットが作られます。Agent が返すリンクを開くと、ここに残高が表示されます。',
    emptyConnectCta: 'Agent を接続する',
    manualEntry: 'アドレスを手入力する',
    closeFund: '閉じる',
    fundLockedNote: '送金の結果を確認できるまで、このパネルは閉じられません。',
    pendingToOther: '送信中の送金は、変更前のアドレス宛てです:',
    fundFromWallet: {
      title: '接続中のウォレットから送る',
      amountLabel: '金額 (JPYC)',
      amountPlaceholder: '例: 100',
      send: '送る',
      confirmTitle: '送金内容の確認',
      confirmSend: 'この内容で送る',
      back: '戻る',
      toLabel: '送り先',
      amountConfirmLabel: '送金額',
      chainLabel: 'チェーン',
      irreversible: '送金は取り消せません。送り先のアドレスを確かめてください。',
      ownershipWarning: 'このアドレスが Agent Wallet であることを OpenPay は確認していません。',
      gasNote: '通常の送金です。ガス代 (POL) はあなたのウォレットから支払われ、OpenPay の利用料はかかりません。',
      insufficient: 'ウォレットの JPYC 残高が不足しています。',
      invalidAmount: '0 より大きい金額を、小数点以下 18 桁までで入力してください。',
      sameWalletNote: '接続中のウォレットと同じアドレスです。',
      waitingWallet: 'ウォレットで承認してください。',
      sent: '送信済み。確定を待っています。',
      confirmed: '送金が確定しました。',
      rejected: 'ウォレットで操作が拒否されました。',
      failed: '送金に失敗したか、確定を確認できませんでした。「取引を見る」で結果を確かめてください。確かめる前に送り直すと、二重に送ってしまうことがあります。',
      viewTx: '取引を見る',
    },
  },
  activity: {
    title: 'アクティビティ',
    filterAll: 'すべて',
    filterIn: '入金',
    filterOut: '送金',
    colDate: '日時',
    colType: '種別',
    colCounterparty: '相手',
    colAmount: '金額',
    viaOpenPay: 'OpenPay 経由',
    viewTx: '取引を見る',
    more: 'もっと見る',
    empty: 'まだ JPYC の送受信がありません。',
    filterEmpty: 'この条件に合う取引はありません。',
    hiddenOnly: '直近 50 件の中に、表示できる取引がありません (0 JPYC の送信は除いています)。',
    loading: '読み込み中…',
    error: '履歴を読み取れませんでした。',
    busy: '混み合っています。少し待ってから開き直してください。',
    unsupported: 'テストネットでは履歴を表示しません。',
    explorerLink: 'Polygonscan で見る',
    truncatedNote: '直近 50 件までを取得しています。それより前の取引は、',
    refreshing: '反映まで 1 分ほどかかります。',
    stat24h: '直近 24 時間の送金',
    stat7d: '直近 7 日間の送金',
    statsPartial: '50 件より前は集計できません',
    publicNote: 'Polygon 上の JPYC の送受信 (公開情報) です。何を購入したかは表示しません。0 JPYC の送信は除いています。',
  },
  purchases: {
    title: '購入 (何を買ったか)',
    lead: 'この Agent が x402 で買ったものを、OpenPay の決済記録から表示します。持ち主だけが見られます。',
    signIn: 'ログインして購入履歴を見る',
    connectFirst: 'ログインするには、まずヘッダの「接続」でウォレットを接続してください。',
    signingIn: 'ウォレットで署名しています…',
    signInError: 'ログインできませんでした。もう一度お試しください。',
    signedInAs: 'ログイン中:',
    notBoundLead: 'この Agent はまだあなたのアカウントに紐づいていません。紐づけは 1 回だけです。',
    notBoundSteps: [
      'Agent に「購入履歴を Web で開いて」と頼みます。',
      '返ってきたリンク (5 分有効・1 回だけ) を、このログイン中のブラウザで開きます。',
    ],
    continueAfterSignIn: 'Agent のリンクを受け取りました。ログインすると紐づけを続けます。',
    verifying: '紐づけを確認しています…',
    bound: 'この Agent をあなたのアカウントに紐づけました。',
    bindConfirm: 'この Agent を {owner} に紐づけます。よろしいですか?',
    confirmBind: '確認して紐づける',
    cancelBind: '紐づけをやめる',
    proofLinkAddressMismatch: '紐づけリンクの Agent {proofAddress} は、URL で指定された Agent {linkAddress} と異なります。',
    proofAddressMismatch: '紐づけリンクの Agent {proofAddress} は、表示中の Agent {cardAddress} と異なります。',
    boundOther: 'Agent {address} をあなたのアカウントに紐づけました。表示中の Agent は変更していません。',
    failures: {
      expired_or_unknown: 'このリンクは期限切れです。Agent にもう一度「購入履歴を Web で開いて」と頼んでください。',
      signature_mismatch: 'このリンクの署名が Agent のアドレスと一致しません。Agent にもう一度頼んでください。',
      already_used: 'このリンクはすでに使われています。別のアカウントに紐づいた場合は、Agent にもう一度頼むと取り戻せます。',
      malformed: 'リンクの形式が正しくありません。Agent が返したリンクをそのまま開いてください。',
      binding_limit: '紐づけられる Agent は 20 件までです。下の一覧で使っていない Agent の紐づけを解除し、Agent に新しいリンクを頼んでください。',
      storage_error: '一時的に処理できません。少し待ってからやり直してください。',
      feature_disabled: 'この機能は現在ご利用いただけません。',
    },
    colDate: '日時',
    colItem: '内容',
    colAmount: '金額',
    viewTx: '取引を見る',
    originFirstParty: 'OpenPay',
    originListed: '出品',
    originClaimed: '申告',
    feeSuffix: '利用料',
    empty: 'まだ購入の記録がありません。',
    truncated: '直近 200 件までを表示しています。',
    sinceNote: '2026-09-22 (UTC) 以降の記録です。',
    caveat: '記録は欠損することがあります。金額と着金はオンチェーン (上のアクティビティ) が基準です。「申告」は売り手と買い手が申告した内容で、商品が提供されたことの証明ではありません。',
    unbind: 'この Agent の紐づけを解除',
    unbindConfirm: '紐づけを解除しますか? もう一度見るには、Agent に新しいリンクを頼む必要があります。',
    bindingsTitle: '紐づけ済みの Agent',
    bindingsEmpty: '紐づけ済みの Agent はありません。',
    bindingDate: '紐づけ日時:',
    unbindAddress: 'Agent {address} の紐づけを解除',
    unbindAddressConfirm: 'Agent {address} の紐づけを解除しますか? もう一度見るには、Agent に新しいリンクを頼む必要があります。',
    loading: '読み込み中…',
    error: '購入履歴を読み取れませんでした。',
  },
  tryPrompts: {
    title: 'Agent に頼めること',
    lead: 'セットアップが済んだら、そのまま話しかけてください。コピーして Agent に貼るだけです。「Agent が支払う」で接続したときの例で、店の注文は「人が支払う」でも使えます。',
    copy: 'プロンプトをコピー',
    copied: 'コピーしました',
    paidNote: '依頼文の上限を超える支払いは行われません。Agent 側の上限のほうが小さいときは、支払いは拒否されます。',
    items: [
      { id: 'catalog', kind: 'free', tag: '無料', prompt: 'OpenPay で今買える JPYC のデータと API を一覧にして、それぞれの価格と利用料を教えてください。支払いはしないでください。' },
      {
        id: 'buy-monitor', kind: 'paid', tag: '支払いあり・3 JPYC',
        prompt: 'JPYC Service Monitor を上限 3 JPYC で購入して、この 1 か月に変わった点を 5 行にまとめてください。',
        hint: '前回以降の差分だけを取れるので、毎週の確認にも使えます。買う前に、無料の更新日チェックで変更があったかを確かめられます。',
        example: {
          text: '実績: 2026-09-22 に Agent が 3 JPYC (当時の価格) で購入。返ってきたのは、日付と一次ソース URL つきの変更一覧。',
          linkLabel: '取引を見る',
          href: 'https://polygonscan.com/tx/0x50d58a1b10572c96ca2bed71983b1235a7957e0b61ac71bed2303323afd579c4',
        },
      },
      { id: 'order', kind: 'human', tag: '支払いは自分で', prompt: 'JPYC で注文できる店を探して、メニューと合計額を見せてください。支払いは私がします。' },
      { id: 'history', kind: 'free', tag: '無料', prompt: '最近なにを買ったか、金額と取引ハッシュつきで見せてください。' },
      { id: 'limits', kind: 'free', tag: '無料', prompt: 'いまの支払い上限と、今日使った額を教えてください。' },
      { id: 'history-web', kind: 'free', tag: '無料', prompt: '購入履歴を Web で開いてください。' },
      { id: 'switch-signer', kind: 'free', tag: '無料', prompt: 'Agent の支払い方式を切り替えたい。今の設定と上限を見せてから、https://open-pay.jp/agent/setup.md の手順で Kova か MetaMask Agent Wallet に切り替えて。鍵は聞かないで。' },
    ],
  },
  next: {
    title: '買えるものを見る',
    body: 'セットアップが済んだら、Agent が JPYC で購入できるリソースを AI ストアで確認できます。',
    storeLabel: 'AI ストアを開く',
    guideLabel: 'AI が支払うガイド',
    noteLabel: 'note で読む: AI に JPYC を使わせる。OpenPay Agent の始め方',
  },
};

const en: AgentPageContent = {
  metaTitle: 'OpenPay Agent — let your AI pay in JPYC',
  metaDescription:
    'Hand one prompt to Claude, Codex, or Hermes and the agent sets up JPYC payments itself. Spending limits are enforced on the agent side; OpenPay never holds your wallet or your private key.',
  ogImageAlt:
    'OpenPay Agent — let your AI pay in JPYC. Connect your agent with one prompt. OpenPay never holds your wallet or your private key.',
  eyebrow: 'OpenPay Agent',
  title: 'Let your AI pay in JPYC.',
  subtitle: 'OpenPay never holds your wallet or your private key.',
  connect: {
    title: 'Connect your agent',
    lead: 'Hand this prompt to your agent. It does the setup itself. Payments start once you fund the agent’s wallet.',
    copy: 'Copy setup prompt',
    copied: 'Copied',
    openIn: 'Or open in',
    openInApps: { claude: 'Claude', codex: 'Codex' },
    openInNote:
      'If the app is installed, it opens with the prompt filled in. You press send.',
    pasteInto: 'Or copy and paste into',
    hosts: ['Claude Code', 'Codex CLI', 'Hermes'],
    shellNote:
      'For agents with shell access. The “Claude” button above opens Claude Code inside the Claude app, so it works as is. Chat-only hosts, where the agent can’t write its own config, should use “Write the config yourself” below.',
    setupLinkLabel: 'Read the instructions your agent follows (setup.md)',
    promptExpand: 'Show full prompt',
    promptCollapse: 'Collapse',
  },
  modes: {
    title: 'Two ways to use it',
    items: [
      {
        mode: 'human-pays',
        tagline: "Don't hand the AI a wallet",
        name: 'Human pays',
        body: 'The AI prepares the order; you approve the payment in your own wallet. No key needed.',
        guideLabel: 'Guide: order with your AI',
        guideHref: '/guide/agent',
      },
      {
        mode: 'agent-pays',
        tagline: 'Give the AI a budget',
        name: 'Agent pays',
        body: 'The AI pays from a small dedicated wallet, within limits you set.',
        guideLabel: 'Guide: how AI pays',
        guideHref: '/guide/ai-pay',
      },
    ],
  },
  safety: {
    title: 'About spending limits',
    enforcedBadge: 'Enforced by the MCP/SDK on the agent side',
    summary: [
      'Limits are enforced by the MCP on the agent’s side. OpenPay’s servers are not involved.',
      'Fund only a small amount you can afford to lose. The balance is the real cap.',
      'This page never asks for a private key. Any OpenPay screen that does is fake.',
    ],
    detailsLabel: 'Details',
    body: "Spending limits and allowed hosts are local safety settings applied by the MCP/SDK on the machine that runs your agent. OpenPay's servers do not know them and do not guarantee them. This page never changes your agent's settings.",
    points: [
      'Fund the dedicated agent wallet only with what you are willing to spend. Its balance is the effective ceiling.',
      'This page has no private-key field. Any OpenPay screen asking for a key is fake.',
      'The wallet key is created and kept by the MCP on your own machine, where your agent runs. It never enters the chat or reaches OpenPay. Anything that can run commands as you can still read it, so fund it only with a small amount you can afford to lose. OpenPay cannot recover the key.',
      "Where the agent runs decides which mode you can use. Claude Code or Codex on your own PC can use the Local Wallet, Kova, MetaMask Agent Wallet, or Steward. The Claude mobile app's Code tab and Claude Code on the web run in a disposable cloud environment: a Local Wallet created there disappears with its key (do not fund it), and Kova needs its CLI and credentials on the same machine, so it does not work there either. MetaMask Agent Wallet also needs an mm session on the same machine as the MCP and cannot run there. From a phone or browser, choose Human pays (approve the payment link in your own wallet), or use Steward if the agent must pay.",
    ],
  },
  generator: {
    title: 'Write the config yourself (manual)',
    summaryHint: 'For switching the payment method (local / Kova / MetaMask) or hosts where the agent can’t write its own config',
    lead: 'Builds the config to paste into your agent’s environment. You do the pasting.',
    modeLabel: 'Mode',
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
      maxDailyJpyc: { label: 'Daily limit (JPYC)', hint: 'Blank applies the session limit as the daily limit · survives restarts (UTC day)' },
      allowedHosts: { label: 'Allowed hosts', hint: 'Comma-separated host names' },
    },
    catalogTrustLabel: 'Allow URLs listed on the AI Store (CATALOG_TRUST)',
    catalogTrustHint:
      'URLs in the OpenPay catalog are payable without adding their host; for those, payment terms that differ from the listing are refused. Hosts you add yourself are not checked against the catalog.',
    humanPaysNote: '“You pay (approve yourself)” needs no key and no limits: the agent never touches a wallet.',
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
      'This config contains no private key. After pasting it and restarting your agent’s host, ask the agent to “call wallet_init”. The MCP creates a wallet on your machine and returns only its address and a funding link. Send JPYC to that address and paying is enabled.',
    feeNote: `The buyer pays the price plus the x402 fee of ${feeText('en')}. Size the per-call limit for the total.`,
  },
  wallet: {
    title: 'Agent wallet',
    lead: 'Enter your agent’s wallet address to see its JPYC balance. OpenPay does not create wallets.',
    inputLabel: 'Agent wallet address',
    inputPlaceholder: '0x…',
    useConnected: 'Use the connected wallet',
    invalidAddress: 'That is not a valid address',
    balanceLabel: 'JPYC balance',
    balanceLoading: 'Loading…',
    balanceError: 'Could not read the balance',
    copyShort: 'Copy',
    ownershipNote:
      'This only reads public on-chain data. It does not verify who owns the address or whether an agent is running.',
    fundTitle: 'Fund it with JPYC',
    fundBody:
      'Send JPYC to this address. OpenPay x402 payments are signed authorizations (EIP-3009), so paying needs no POL (moving leftover JPYC out later does).',
    copyAddress: 'Copy address',
    copied: 'Copied',
    connectCta: 'Connect agent',
    fundCta: 'Add funds',
    changeAddress: 'Change',
    recentTitle: 'Recently viewed wallets',
    labelInputLabel: 'Name (optional, saved on this device only)',
    labelPlaceholder: 'e.g. Kova',
    linkedAddressConfirm: 'The link’s address {address} differs from the Agent Wallet saved on this device. Replace it?',
    useLinkedAddress: 'Use the link’s address',
    keepSavedAddress: 'Keep the saved address',
    emptyLead: 'Set up “Agent pays” with “Connect your agent” below and a wallet is created on your own machine. Open the link your agent returns and its balance appears here.',
    emptyConnectCta: 'Connect your agent',
    manualEntry: 'Enter an address manually',
    closeFund: 'Close',
    fundLockedNote: 'This panel stays open until the transfer’s result is confirmed.',
    pendingToOther: 'The transfer in progress goes to the previous address:',
    fundFromWallet: {
      title: 'Send from the connected wallet',
      amountLabel: 'Amount (JPYC)',
      amountPlaceholder: 'e.g. 100',
      send: 'Send',
      confirmTitle: 'Review transfer',
      confirmSend: 'Confirm and send',
      back: 'Back',
      toLabel: 'To',
      amountConfirmLabel: 'Amount',
      chainLabel: 'Chain',
      irreversible: 'Transfers cannot be reversed. Check the destination address.',
      ownershipWarning: 'OpenPay has not verified that this address is an Agent Wallet.',
      gasNote: 'This is a regular transfer. Gas (POL) is paid from your wallet, and OpenPay charges no usage fee.',
      insufficient: 'Your wallet has insufficient JPYC.',
      invalidAmount: 'Enter an amount greater than 0 with up to 18 decimal places.',
      sameWalletNote: 'This is the same address as the connected wallet.',
      waitingWallet: 'Approve the request in your wallet.',
      sent: 'Sent. Waiting for confirmation.',
      confirmed: 'Transfer confirmed.',
      rejected: 'The request was rejected in your wallet.',
      failed: 'The transfer failed, or its confirmation could not be checked. Use “View transaction” to see the result. Sending again before checking can send twice.',
      viewTx: 'View transaction',
    },
  },
  activity: {
    title: 'Activity',
    filterAll: 'All',
    filterIn: 'Received',
    filterOut: 'Sent',
    colDate: 'Date',
    colType: 'Type',
    colCounterparty: 'Counterparty',
    colAmount: 'Amount',
    viaOpenPay: 'via OpenPay',
    viewTx: 'View transaction',
    more: 'Show more',
    empty: 'No JPYC transfers yet.',
    filterEmpty: 'No transfers match this filter.',
    hiddenOnly: 'Nothing to show among the latest 50 transfers (0 JPYC transfers are left out).',
    loading: 'Loading…',
    error: 'Couldn’t load the history.',
    busy: 'It’s busy right now. Please try again shortly.',
    unsupported: 'History isn’t shown on testnets.',
    explorerLink: 'View on Polygonscan',
    truncatedNote: 'Only the latest 50 transfers are fetched. For earlier ones,',
    refreshing: 'It can take about a minute to appear.',
    stat24h: 'Sent, last 24 hours',
    stat7d: 'Sent, last 7 days',
    statsPartial: 'Can’t total beyond the latest 50',
    publicNote: 'JPYC transfers on Polygon (public data). What was purchased is not shown. 0 JPYC transfers are left out.',
  },
  purchases: {
    title: 'Purchases (what it bought)',
    lead: 'What this agent bought over x402, from OpenPay’s payment records. Only the owner can see it.',
    signIn: 'Sign in to see purchases',
    connectFirst: 'To sign in, first connect a wallet from “Connect” in the header.',
    signingIn: 'Signing with your wallet…',
    signInError: 'Sign-in failed. Please try again.',
    signedInAs: 'Signed in as',
    notBoundLead: 'This agent is not linked to your account yet. Linking is a one-time step.',
    notBoundSteps: [
      'Ask your agent: “Open my purchase history on the web.”',
      'Open the link it returns (valid 5 minutes, single use) in this signed-in browser.',
    ],
    continueAfterSignIn: 'Link received from your agent. Sign in to continue linking.',
    verifying: 'Confirming the link…',
    bound: 'This agent is now linked to your account.',
    bindConfirm: 'Link this agent to {owner}?',
    confirmBind: 'Confirm and link',
    cancelBind: 'Cancel linking',
    proofLinkAddressMismatch: 'The link is for Agent {proofAddress}, which differs from Agent {linkAddress} in the page URL.',
    proofAddressMismatch: 'The link is for Agent {proofAddress}, which differs from the displayed Agent {cardAddress}.',
    boundOther: 'Agent {address} is now linked to your account. The displayed Agent has not changed.',
    failures: {
      expired_or_unknown: 'This link has expired. Ask your agent again to open your purchase history on the web.',
      signature_mismatch: 'The signature in this link does not match the agent’s address. Ask your agent again.',
      already_used: 'This link was already used. If it linked to another account, asking your agent again reclaims it.',
      malformed: 'The link is not in the expected form. Open the link exactly as your agent returned it.',
      binding_limit: 'You can link up to 20 agents. Unlink one you no longer use in the list below, then ask your agent for a new link.',
      storage_error: 'Temporarily unavailable. Please wait a moment and try again.',
      feature_disabled: 'This feature is not available right now.',
    },
    colDate: 'Date',
    colItem: 'Item',
    colAmount: 'Amount',
    viewTx: 'View transaction',
    originFirstParty: 'OpenPay',
    originListed: 'Listed',
    originClaimed: 'Claimed',
    feeSuffix: 'fee',
    empty: 'No purchases recorded yet.',
    truncated: 'Showing the latest 200 records.',
    sinceNote: 'Records from 2026-09-22 (UTC) onward.',
    caveat: 'Records can be incomplete. Amounts and settlement are confirmed on-chain (Activity above). “Claimed” is what the seller and buyer declared, not proof that the item was delivered.',
    unbind: 'Unlink this agent',
    unbindConfirm: 'Unlink this agent? To see it again, ask your agent for a new link.',
    bindingsTitle: 'Linked agents',
    bindingsEmpty: 'No linked agents.',
    bindingDate: 'Linked on:',
    unbindAddress: 'Unlink agent {address}',
    unbindAddressConfirm: 'Unlink agent {address}? To see it again, ask your agent for a new link.',
    loading: 'Loading…',
    error: 'Could not read purchases.',
  },
  tryPrompts: {
    title: 'What you can ask your agent',
    lead: 'Once setup is done, just talk to it. Copy a prompt and paste it to your agent. These examples are for the “Agent pays” setup; ordering from a shop also works with “You pay”.',
    copy: 'Copy prompt',
    copied: 'Copied',
    paidNote: 'Nothing above the cap in the prompt is paid. If the limit on the agent side is lower, the payment is refused.',
    items: [
      { id: 'catalog', kind: 'free', tag: 'Free', prompt: 'List the JPYC data and APIs I can buy on OpenPay right now, with the price and fee for each. Do not pay.' },
      {
        id: 'buy-monitor', kind: 'paid', tag: 'Pays · 3 JPYC',
        prompt: 'Buy the JPYC Service Monitor with a 3 JPYC cap and summarize what changed in the last month in five lines.',
        hint: 'It can return only what changed since your last check, so it also works as a weekly routine. A free freshness check tells you whether anything changed before you buy.',
        example: {
          text: 'Real run: on 2026-09-22 an agent bought it for 3 JPYC (price at the time) and got back the dated change list with source URLs.',
          linkLabel: 'View the transaction',
          href: 'https://polygonscan.com/tx/0x50d58a1b10572c96ca2bed71983b1235a7957e0b61ac71bed2303323afd579c4',
        },
      },
      { id: 'order', kind: 'human', tag: 'You pay yourself', prompt: 'Find shops where I can order with JPYC and show me the menu and the total. I will pay myself.' },
      { id: 'history', kind: 'free', tag: 'Free', prompt: 'Show me what you bought recently, with amounts and transaction hashes.' },
      { id: 'limits', kind: 'free', tag: 'Free', prompt: 'Tell me my current spending limits and how much I have spent today.' },
      { id: 'history-web', kind: 'free', tag: 'Free', prompt: 'Open my purchase history on the web.' },
      { id: 'switch-signer', kind: 'free', tag: 'Free', prompt: 'I want to switch my agent’s payment method. Show me the current config and limits first, then switch to Kova or MetaMask Agent Wallet following https://open-pay.jp/agent/setup.md. Never ask me for a key.' },
    ],
  },
  next: {
    title: 'See what it can buy',
    body: 'Once set up, browse the AI Store for the resources your agent can buy with JPYC.',
    storeLabel: 'Open the AI Store',
    guideLabel: 'Guide: how AI pays',
    noteLabel: 'Read on note (Japanese): getting started with OpenPay Agent',
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
    // metaTitle が既に「OpenPay Agent — …」で始まるので、guide 共通の「 · OpenPay」接尾辞は付けない。
    title: c.metaTitle,
    description: c.metaDescription,
    // 専用 OG (docs/og-agent/og.html を 1200x630 で描画 → webp)。既定の og-home.webp は総合版の
    // 絵なので、SNS で共有したときに Agent の面だと伝わらない。
    ogImage: {
      url: '/og-agent.webp',
      width: 1200,
      height: 630,
      alt: c.ogImageAlt,
    },
  });
}
