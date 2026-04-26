# OpenPay

小規模店舗・クリエイター・フリーランスが**ウォレットアドレス1つだけ**で導入できる、オープンソースのガスレス決済 / Tip widget ジェネレーター。  
ERC-4337 (Account Abstraction) + Pimlico Sponsorship Paymaster + ERC-7702 を組み合わせ、顧客はネイティブトークン (POL / ETH) を保有することなく **JPYC (Polygon)** または **USDC (Base)** で決済できます。

- `/{locale}` — 店舗向け QR ジェネレーター + クリエイター向け Tip widget 埋め込みコード生成 (タブ切替)
- `/{locale}/pay?to=...&token=...&fee=...&amount=...&split=0xB:30,0xC:20` — QR をスキャンした顧客の決済画面 (`split=` で複数受取人へ % 分配可能)
- `/{locale}/tip/[address]?token=...&name=...&message=...&color=...&preset=...&thanks=...&thanksUrl=...&webhook=...` — クリエイター向けチップ送金画面 (iframe 埋め込み対応 / 成功後の thanks メッセージ + リンク + webhook 通知)
- `{locale}` は `ja` (デフォルト) または `en`。middleware が Accept-Language で自動検出

**Repo**: https://github.com/cipherwebllc/openpay  
**License**: MIT

## 特徴

| 項目 | 内容 |
| --- | --- |
| ガスレス | Pimlico Sponsorship (Verifying) Paymaster で運営がガス代を肩代わり |
| EOA をそのまま使用 | ERC-7702 によって、顧客の MetaMask 等の **既存 EOA 残高** で決済 (事前送金不要) |
| バッチ送金 | 「店主への送金」と「運営手数料 (1%)」を 1 つの UserOperation にまとめて送信 |
| 2チェーン対応 | JPYC (Polygon) / USDC (Base) を切替可能 |
| 登録審査不要 | 店主は自分のウォレットアドレスを入力するだけで QR を発行 |
| 据え置き QR / 金額指定 QR | 入店レジ用 (固定) と請求書用 (金額指定) 両対応 |
| 直接送金 (上級者) | ガス代を顧客負担にすることで運営手数料 0% で送金できるオプションモード |
| Tip widget (β) | iframe 1 行貼付でブログ・配信ページ・GitHub README に埋め込めるチップ送金 UI。固定 preset + カスタム金額、テーマカラー設定可 |

## 現金 / クレカ / PayPay との比較

| 項目 | 💴 現金 | 💳 クレジットカード² | 📱 PayPay¹ | ⚡ OpenPay |
| --- | --- | --- | --- | --- |
| **導入審査** | 不要 | 必要 (加盟店契約 + 審査) | 必要 (店舗登録 + KYC) | **不要** (ウォレットアドレス入力のみ) |
| **初期コスト** | レジ・釣銭準備 | 端末 + 月額利用料² | 端末 / QR スタンド申込 | **0 円** (印刷 QR で可) |
| **店舗受取手数料** | 0% | 約 3.25〜3.75%² (一部 5%超) | 1.60〜1.98%¹ | **1.0%** / **0%** (直接送金モード) |
| **入金タイミング** | 即時 (店舗内) | 翌営業日〜月 1〜2 回² | 翌日〜月次¹ | **即時** (オンチェーン確定 数秒〜数十秒) |
| **チャージバック** | なし | あり (店舗負担リスク) | 一部あり | **なし** (オンチェーン確定で取消不可) |
| **釣銭** | 必要 (両替コスト・誤算リスク) | 不要 | 不要 | **不要** |
| **記帳** | 手動 / レジ閉め | カード会社管理画面 | 管理画面 | **オンチェーンで自動 + 改竄不可** |
| **海外顧客** | 両替が必要 | 国際ブランドで対応 (DCC 手数料あり) | 国内中心 | **グローバル** (USDC は世界共通通貨) |
| **紛失 / 盗難** | 物理リスクあり | 物理 (但し補償あり) | 限定的 | **秘密鍵管理のみ** |
| **顧客のガス代** | ─ | ─ | ─ | **0 円** (運営肩代わり) |
| **ベンダーロック** | ─ | あり (カード会社契約) | あり (PayPay 内に閉じる) | **なし** (OSS / セルフホスト可) |
| **コード透明性** | ─ | クローズド | クローズド | **MIT / 全ソース公開** |

¹ PayPay の手数料・入金サイクルは加盟店プラン (PayPay マイストア plus 等) と申込条件で変動するため代表値を記載。  
² クレジットカードの手数料率・入金サイクル・端末コストは カード会社 / PSP (Square / Stripe / GMO ペイメントゲートウェイ 等) と業種・取扱高で大きく変動。Square / Stripe では端末月額無料・翌営業日入金プランあり、Visa/Master 系で 3.25%〜、Amex/Diners 系で 4〜7% が一般的。

### 現金より便利な理由 (店舗オーナー視点)

- **釣銭計算が消える**: 1 円単位で正確な金額が瞬時に確定し、両替・釣銭準備の負担ゼロ
- **レジ閉め作業が要らない**: 売上はオンチェーンに時系列で残るため、その日のうちに集計する手作業が不要
- **24 時間 365 日**: 無人レジ・自販機・夜間営業でも、店主が現場にいる必要なし
- **物理リスクが消える**: 偽札・盗難・紛失・水濡れ・摩耗、すべて関係なし
- **複数店舗の合算が即時**: 同一ウォレットアドレスを共有すれば全店売上が自動で集計される
- **海外旅行客にもそのまま**: USDC を選べば為替・両替手数料なしで世界中の顧客から受け取り可能

## 主なユースケース

OpenPay の構成要素 (programmable URL / multi-token / multi-chain / gasless / self-hostable) は店舗 QR 以外の使い方でもそのまま動きます。**追加の登録・コード変更なし**で以下のシナリオに使えます。

### 1. フリーランス・クリエイターの国際報酬受取

日本のイラストレーター / エンジニア / 翻訳者が海外クライアントから報酬を受け取る際、Wise や PayPal は **手数料 3〜5% + 着金 3〜7 営業日 + 書類処理** が要ります。OpenPay の請求 URL を発行してクライアントへ送れば、USDC で **即時着金 (オンチェーン確定 数十秒) / 手数料 1% / 書類ゼロ** で受け取れます。

- 発行手順: `/` で USDC を選び、自分のウォレットアドレスを入力 → 金額指定 → URL or QR を発行 → クライアントへ送付 (メール / Slack / Notion 等で 1 行貼り付けるだけ)
- クライアント側に必要なのは EIP-7702 対応 EOA (MetaMask v12+) のみ。**ガス代も不要** (運営肩代わり)
- 着金履歴はそのままオンチェーンに残るため、事業所得の証憑として税務対応にも使える
- 国別規制: 受取人 (= 日本のフリーランス) 側は事業所得として確定申告すれば足りる。送付側 (海外クライアント) の規制は管轄国に依存

### 2. イベント / 同人誌即売会 / Web3 conference 物販

コミケ・技術書典・Web3 conference 等で、サークル主は **加盟店登録なし** に複数商品の決済 QR を即座に発行できます。PayPay や Square のような事前審査・端末手配は不要です。

- **1 商品 1 QR**: 商品名と固定金額で QR を生成 → 印刷して机に貼付 → 顧客がスキャンして即決済
- **海外参加者も即決済**: USDC を選べば来日した海外客が両替なしで支払い可能。JPYC を選べば国内 Web3 ユーザがそのまま使える
- **現金不要**: お釣り・偽札・盗難・水濡れリスクがすべて消える
- **複数販売員**: 同じウォレットアドレスを共有すれば、サークル全員の売上が自動で集計される
- **据え置き QR**: 単価が変動する商品 (応相談 / 投げ銭混じり) では、金額入力欄つきの据え置き QR を 1 枚貼っておくだけで運用可

商品点数が多い場合は 1 商品ずつ `/` で QR を生成する運用を想定。需要が増えれば CSV → 一括 QR 生成 (PDF / ZIP) を追加予定。

### 3. クリエイターの Tip widget 埋め込み (β)

イラストレーター・配信者・OSS maintainer 等が、ブログ・ポートフォリオ・配信ページ・GitHub README に **iframe 1 行貼付** でチップ送金 UI を組み込めます。pixivFANBOX / BOOST / Twitter tip 等は手数料 10〜15% + 月次入金 + 海外決済不可ですが、OpenPay は **手数料 1% / 即時着金 / 海外 OK / JPYC + USDC 両対応**。

- 設定: `/` の「Tip widget」タブで受取アドレス・通貨・表示名・メッセージ・テーマカラー・preset 金額を入力 → URL と iframe スニペットを生成
- 埋め込み:
  ```html
  <iframe
    src="https://your-openpay.example.com/tip/0x...?token=jpyc&name=山田太郎&color=%231e3a8a"
    width="380" height="640" style="border:0;max-width:100%"
    title="OpenPay Tip" loading="lazy"
  ></iframe>
  ```
- ファンは MetaMask v12+ などで接続し、preset (JPYC: 100/500/1000、USDC: 1/5/10) かカスタム金額を選んで送信。ガス代不要 (運営肩代わり)
- iframe 埋め込みは `Content-Security-Policy: frame-ancestors *` で全オリジン許可 (アクションは MetaMask ポップアップで起こるためクリックジャッキング不成立)

## 対応ネットワークと選定理由

| トークン | チェーン | ガス通貨 | 採否 | 理由 |
| --- | --- | --- | --- | --- |
| JPYC v3 | **Polygon** | POL | ✅ 採用 | JPYC v3 (`0xE7C3…3c29`) が Polygon 上で発行され、DEX/ブリッジ/オンランプの流動性が集中。日本国内の JPYC ユーザの主要居住地 |
| USDC (native) | **Base** | ETH | ✅ 採用 | Circle 公式 native USDC。Coinbase ウォレット経由のオンランプが容易、低ガス、Base 系 dApp との互換性 |
| JPYC | Ethereum | ETH | ❌ 不採用 | ガス代が決済額に対して高すぎる (15 JPYC ≒ 15 円の手数料に対しガスが数百円〜) |
| JPYC | Avalanche | AVAX | ❌ 不採用 (一旦様子見) | Avalanche 上の JPYC は **DEX ペアの流動性がほぼゼロ**。1% 手数料を AVAX に変換するルートがクロスチェーンになり、ガス調達が常に赤字。日本のリテールユーザの利用が限定的 |

### 運用上の含意 (JPYC / Polygon)

1. 顧客の決済ごとに Pimlico Sponsorship Paymaster は **POL を消費**する
2. 運営は手数料 1% を **JPYC** で受け取る
3. 運営は定期的に **JPYC → POL** に swap して Pimlico 残高を補充する必要がある
   - JPYC/POL の DEX ペアは流動性が薄いため、実務的には **JPYC → USDC → POL** の 2-hop swap (QuickSwap / Uniswap v3 on Polygon) が現実的
   - 自動化案: OpenZeppelin Defender Sentinel / cron + viem による定期 swap
4. 1% / 最低 15 JPYC の料率は、本番ガス価格 + DEX スリッページ + Pimlico の sponsorship 上乗せを実測してチューニングしてください (条件次第で赤字)

### 将来の拡張余地

- Avalanche / Arbitrum / Optimism 等の追加は 1〜2 時間の作業 (`lib/chains.ts` / `lib/tokens.ts` / `lib/wagmi.ts` に枝を生やすだけ)。**実需要が確認できてから追加**する方針

## アーキテクチャ

```
┌────────────────────────────────────────────────────────┐
│ 店主 (any EOA)                                         │
│  └─ /                  QR ジェネレーター画面            │
│       (LocalStorage に設定保存)                        │
└────────────────────────────────────────────────────────┘
              │ QR (URL: /pay?to=...&token=...&fee=...&amount=...)
              ▼
┌────────────────────────────────────────────────────────┐
│ 顧客 (any EOA - MetaMask / Coinbase / WC)              │
│  └─ /pay               決済画面                        │
│       1. URL parse                                     │
│       2. ウォレット接続 (wagmi)                          │
│       3. 必要チェーンへ自動切替                          │
│       4. ERC-7702: EOA を Smart Account 化              │
│       5. Pimlico Sponsorship Paymaster でガス補助        │
│       6. ERC20.transfer × 2 (店主 / 運営) を batch       │
│       7. UserOperation 送信 → receipt 表示              │
└────────────────────────────────────────────────────────┘
```

## ディレクトリ構成

```
openpay/
├── app/
│   ├── layout.tsx
│   ├── providers.tsx                # WagmiProvider + ReactQuery
│   ├── globals.css
│   ├── page.tsx                     # / (店主向け QR + Tip widget タブ)
│   ├── pay/page.tsx                 # /pay (顧客向け決済)
│   └── tip/[address]/page.tsx       # /tip/[address] (クリエイター Tip 受取)
├── components/
│   ├── ConnectButton.tsx
│   ├── Field.tsx                    # 共有: ラベル付き入力ラッパー
│   ├── Row.tsx                      # 共有: 明細用 dt/dd 行
│   ├── QrGenerator.tsx
│   ├── PaymentForm.tsx
│   ├── TipForm.tsx                  # /tip/[address] のメイン UI
│   └── TipEmbedGenerator.tsx        # /` の Tip widget タブ
├── hooks/
│   ├── useQrSettings.ts             # LocalStorage: QR 生成設定
│   ├── useTipSettings.ts            # LocalStorage: Tip widget 生成設定
│   ├── useSmartAccount.ts           # ERC-7702 + Pimlico
│   ├── useBatchPayment.ts           # バッチ UserOperation
│   └── useDirectPayment.ts          # 直接送金モード (mode=direct)
├── lib/
│   ├── env.ts                       # 環境変数の単一参照点
│   ├── chains.ts                    # mainnet/testnet 切替
│   ├── tokens.ts                    # JPYC / USDC 定義
│   ├── fee.ts                       # 1% / MIN_FEE 計算
│   ├── url.ts                       # /pay /tip URL ビルド/パース
│   ├── storage.ts                   # LocalStorage helpers
│   ├── logger.ts                    # 構造化 JSON ログ
│   ├── wagmi.ts                     # wagmi config + 3 connectors
│   └── pimlico.ts                   # Pimlico bundler/paymaster client
├── tests/
│   ├── _helpers/wagmiMock.ts        # mockHook<F>: 部分モック用 typed helper
│   ├── components/                  # RTL コンポーネントテスト
│   ├── hooks/                       # フックの境界テスト
│   └── lib/                         # 純関数テスト
├── package.json
├── next.config.mjs                  # /tip/* に CSP frame-ancestors を付与
├── tailwind.config.ts
└── .env.local.example
```

## セットアップ

### 1. クローン + 依存パッケージのインストール

```bash
git clone https://github.com/cipherwebllc/openpay.git
cd openpay
npm install
```

このコマンドで `package-lock.json` が生成されます。**初回 push 前に必ずコミット**してください — CI (`.github/workflows/ci.yml`) は `npm ci` でインストールするため、lockfile がないと **CI が初回実行で失敗します**。

```bash
git add package-lock.json
git commit -m "Lock dependencies"
```

(プロジェクトを新規に作る場合は以下のコマンドで同じ依存を取得できます)

```bash
npm install \
  next@^15 react@^19 react-dom@^19 \
  viem@^2.21 wagmi@^2.13 @tanstack/react-query@^5.59 \
  permissionless@^0.2.30 qrcode.react@^4
npm install -D \
  typescript @types/node @types/react @types/react-dom \
  tailwindcss postcss autoprefixer \
  eslint eslint-config-next
```

### 2. 環境変数

`.env.local.example` を `.env.local` にコピーし、以下を埋めます。

| 変数 | 必須 | 値 |
| --- | --- | --- |
| `NEXT_PUBLIC_NETWORK_ENV` | ◯ | `mainnet` または `testnet` |
| `NEXT_PUBLIC_PIMLICO_API_KEY` | ◯ | [Pimlico Dashboard](https://dashboard.pimlico.io) で発行した API Key |
| `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` | ◯ (推奨) | Pimlico の Sponsorship Policy ID (例: `sp_xxxx`) |
| `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` | ◯ | 1% 手数料の受取アドレス |
| `NEXT_PUBLIC_WC_PROJECT_ID` | △ | [Reown Cloud](https://cloud.reown.com) で発行した WalletConnect Project ID。未設定時は WalletConnect 連携が無効化される |
| `NEXT_PUBLIC_*_RPC_URL` | × | 公開 RPC が混雑する場合に Alchemy/Infura 等の URL を指定 |
| `NEXT_PUBLIC_*_TESTNET_ADDRESS` | × | testnet で独自に発行した ERC20 を指定する場合に上書き |

### 3. Pimlico ダッシュボード設定

1. [https://dashboard.pimlico.io](https://dashboard.pimlico.io) でアカウント作成し API Key を発行
2. **本番運用時は必ず "Origin (ドメイン) 制限" を有効化**してください。`NEXT_PUBLIC_PIMLICO_API_KEY` はクライアントバンドルに含まれるため、Origin 制限なしでは API Key が悪用される可能性があります
3. 以下のチェーン用に Sponsorship 残高をデポジット:
   - `mainnet`: Polygon (POL) / Base (ETH)
   - `testnet`: Polygon Amoy (POL) / Base Sepolia (ETH)
4. **Sponsorship Policy** を作成し、その `policyId` を `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` に設定 (チェーン横断で 1 つの policyId を使い回せます)
5. **濫用対策ルール** を Policy に必ず設定 (これがないと、誰かが任意の `/pay` URL を生成して運営の sponsorship 残高を消費できる):
   - `to address allowlist`: トークンコントラクトアドレスのみ許可 (JPYC: `0xE7C3...3c29`、USDC Base: `0x8335...2913`、USDC Base Sepolia: `0x036C...CF7e`、JPYC Polygon Amoy: 自分のテストデプロイ)
   - `function selector allowlist`: `transfer(address,uint256)` (`0xa9059cbb`) のみ
   - `data parameter constraint`: 受取人パラメータの 1 つが必ず `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` であること (= 運営手数料 transfer を含む UserOp のみ sponsor)
   - クライアント側でも `useBatchPayment` が `feeAmount > 0` を assertion して defense in depth

### 4. 開発サーバー

```bash
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開いてください。

## 言語サポート

UI は日本語 (default) と英語の 2 言語対応。`next-intl` v4 + middleware 検出で `/ja/...` / `/en/...` に自動 routing。ヘッダー右上の言語スイッチャーで切替可能。

- 文字列リソース: `messages/ja.json` / `messages/en.json`
- 新しい locale 追加: `i18n.ts` の `LOCALES` に追加 + `messages/{locale}.json` を作成
- ロケール非依存ルート (`/manifest.webmanifest`, `/icon.svg` 等) は middleware の matcher で除外済み

## 使い方

### 店主側 (QR 発行)

1. `/` を開く
2. 通貨 (USDC / JPYC)・受取アドレス・手数料モード (内税 / 外税) を入力 (LocalStorage に保存)
3. **金額指定 QR**: 請求金額を入力 → 一回限りの QR が生成
4. **据え置き QR**: 金額入力なしで生成 → 顧客が金額入力する据え置き QR
5. QR を印刷 / 表示。または URL コピーで送付

### 顧客側 (決済)

1. QR をスキャン → `/pay?to=...&token=...&fee=...&amount=...` が開く
2. ウォレット接続 (MetaMask / Coinbase Wallet / WalletConnect)
3. 必要なら自動でネットワーク切替を促す
4. (据え置き QR の場合は) 金額を入力
5. 「○○ を支払う」ボタンで送金完了
6. UserOp Hash・Tx Hash・ブロック番号を表示

### クリエイター側 (Tip widget 設置)

1. `/` を開いて「Tip widget (クリエイター)」タブに切替
2. 受取アドレス・通貨 (JPYC / USDC)・表示名・メッセージ・テーマカラー・preset 金額を入力
3. プレビューを確認 → URL or iframe スニペットをコピー
4. ブログ・ポートフォリオ・配信ページの HTML に貼り付け
5. ファンが iframe 内のボタンをクリック → ウォレット接続 → preset/カスタム額で送信

Tip widget の手数料は **外税 1%** 固定。クリエイターは preset 額をそのまま受け取り、ファンが 1% を上乗せして支払います (MIN_FEE 適用は通常決済と同じ)。

## 手数料の計算

- 運営手数料 = `amount × 1.0%` （ただし下限あり）
- 下限: JPYC = 15 JPYC / USDC = 0.1 USDC

| モード | 顧客支払額 | 店主受取額 | 運営受取額 |
| --- | --- | --- | --- |
| 内税 (`fee=include`) | `amount` | `amount - fee` | `fee` |
| 外税 (`fee=exclude`) | `amount + fee` | `amount` | `fee` |

## Vercel デプロイ

リポジトリを Vercel にインポートし、上記の環境変数をプロジェクト設定にコピーしてください。  
`next build` がそのまま通る素の Next.js (App Router) 構成のため、追加設定は不要です。

```bash
npm run build && npm run start
```

## 本番投入前に必ず検証すべきポイント (未検証 / LARP リスク)

本リポジトリは MVP プロトタイプであり、以下の事項は **コード生成時点で実環境検証ができていない**。本番環境にデプロイする前に必ず確認してください。

### 1. permissionless.js の API 名

`hooks/useSmartAccount.ts` は `permissionless@^0.2.30` から **`to7702SimpleSmartAccount`** を import している (`tests/hooks/useSmartAccount.test.tsx` で import 解決を smoke check 済)。permissionless 側でリネーム/移動が起きた時はこの import が壊れて CI が即落ちる。

### 2. JPYC mainnet コントラクトアドレス

`lib/tokens.ts` の既定値は **JPYC v3 (Polygon): `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`** です (プロジェクト所有者により確認済)。  
JPYC は将来的に新バージョンへの移行や別チェーン拡張が起こる可能性があるため、本番投入前に [JPYC 公式](https://jpyc.jp/) で**最新のコントラクトアドレスを再確認**してください。不一致がある場合は `NEXT_PUBLIC_JPYC_MAINNET_ADDRESS` で上書き可能です。

> ⚠️ **誤ったアドレスを mainnet で稼働させると顧客資金が失われます。** デプロイ前に必ず公式ソースとの突合を実施してください。

### 3. ERC-7702 の実フロー

`useSmartAccount` の queryFn (`to7702SimpleSmartAccount` → `createSmartAccountClient`) は **どの自動テストでも実行されていない**。理由:
- 完全モックすると "実コードを試していない" のと等価になる
- 実コードを動かすには Pimlico API key + funded sponsorship policy + ERC-7702 対応ウォレットの実署名が必要

検証は testnet で `npm run dev` し、実際にスキャン → 送金してください (README の「統合テスト (e2e)」節)。

### 4. Pimlico Sponsorship Policy の挙動

policyId が無い場合の Pimlico 既定挙動 (sponsor するか reject するか) は Pimlico ダッシュボードのアカウント設定に依存する。**本番投入前に必ず policyId を明示設定** してください。

---

## 既知の制約 / 注意

- **ERC-7702 対応ウォレット**: 顧客の EOA は EIP-7702 (`signAuthorization`) 対応ウォレットが必要です。MetaMask v12 系以降の安定版が対応しています。Coinbase Wallet / 一部の WalletConnect ウォレットは未対応の可能性があります
- **JPYC コントラクトアドレス**: `lib/tokens.ts` の既定値は JPYC v3 (`0xE7C3...3c29`、所有者確認済)。将来の移行に備えて本番投入前に [JPYC 公式](https://jpyc.jp/) で最新アドレスを再確認し、必要なら `NEXT_PUBLIC_JPYC_MAINNET_ADDRESS` で上書きしてください
- **testnet の JPYC**: Polygon Amoy には公式の JPYC が存在しないため、テスト時は `NEXT_PUBLIC_JPYC_TESTNET_ADDRESS` で独自にデプロイした ERC20 を指定してください
- **API Key の露出**: `NEXT_PUBLIC_*` はクライアントへ展開されるため、本番では必ず Pimlico ダッシュボード側で Origin 制限を設定してください
- **Sponsorship Policy のレート制御**: スポンサー残高が枯渇すると UserOperation が失敗します。Pimlico ダッシュボードで残高アラートを設定することを推奨します

## テスト

[Vitest](https://vitest.dev) + [@testing-library/react](https://testing-library.com/) でユニット / コンポーネントテストを実装しています。

```bash
npm run test         # ウォッチモード
npm run test:run     # 1 回だけ実行 (CI 用)
```

### カバー範囲

| 層 | 対象 | テスト方針 |
| --- | --- | --- |
| `lib/fee.ts` | 1% / MIN_FEE / 内税・外税 / 境界 (1% == MIN, amount < MIN) / amount=0 / 大数 | 純粋関数 — 実コードのみ |
| `lib/url.ts` | /pay と /tip 両方の build / parse / sanitize (制御文字除去 / 長さ切詰 / preset 検証) / roundtrip | 純粋関数 — 実コードのみ |
| `lib/tokens.ts` | decimals / chainId / env override / フォールバック | 実コード |
| `lib/storage.ts` | LocalStorage roundtrip / 破損 JSON / null | jsdom 上で実コード |
| `lib/chains.ts` | mainnet/testnet 切替 / chainForToken / isSupportedChainId | 実コード |
| `lib/env.ts` | 不正 NETWORK_ENV で throw / 各 fallback | `vi.resetModules()` で動的 import |
| `lib/pimlico.ts` | URL 生成 / paymasterContext / client 生成 | 実コード |
| `hooks/useQrSettings` `useTipSettings` | LocalStorage hydrate / 破損データ復旧 / persist | RTL `renderHook` |
| `hooks/useBatchPayment` | 2-call バッチ / 0-amount スキップ / encode された transfer の中身 (`decodeFunctionData` で復号して検証) / エラー伝播 | `useSmartAccount` を境界モック、本ロジックは実行 |
| `hooks/useDirectPayment` | writeContract 引数 / receipt 状態遷移 / エラー伝播 | wagmi を境界モック |
| `components/QrGenerator` | 入力 → state → QR(SVG) 生成 / mode 切替 / clipboard / 永続化 | RTL + jsdom |
| `components/PaymentForm` | URL parse 各種エラー / 内税・外税の breakdown / 接続状態の遷移 / mutate 引数の妥当性 / direct mode | wagmi/Smart Account を境界モック |
| `components/TipForm` | preset 切替 / カスタム入力 / 外税 breakdown / submit 引数 / wallet 状態 | wagmi/Smart Account を境界モック |
| `components/TipEmbedGenerator` | 入力 → URL/iframe スニペット生成 / preset 検証 / カラー検証 / clipboard / 永続化 | RTL + jsdom |
| `components/ConnectButton` | connector 列挙 / クリックで connect / 切断 / pending / error | wagmi を境界モック |

### モック方針

- **テスト対象コードはモックしない**。`lib/*` と `hooks/*` の対象ロジックは常に実行されます。
- **境界モックのみ**: 外部ネットワーク (Pimlico API) / EIP-7702 ウォレット / wagmi connectors を返す位置のみモック。
- ABI エンコード/デコードは viem 本物を使用 (`encodeFunctionData` の結果を `decodeFunctionData` で復号して、関数名と引数を実データ検証)。
- wagmi / hook の部分モックは `tests/_helpers/wagmiMock.ts` の `mockHook<F>` で集約。`DeepPartial<ReturnType<F>>` を受け取り、key の typo を型エラーで検出しつつ、深い nested structure (Chain / Connector 等) は省略可能。

### 統合テスト (e2e)

`useSmartAccount` の実 ERC-7702 フロー (Pimlico Sponsorship Paymaster との通信、ウォレットの `signAuthorization`) は実 API キーと funded sponsorship policy が必要なため、ユニットテストには含めていません。動作確認は次の手順で実施してください:

1. testnet (Polygon Amoy / Base Sepolia) のウォレットを ERC-7702 対応版 MetaMask で用意
2. Pimlico ダッシュボードに少額デポジット
3. `npm run dev` して `/pay?...` で実際にスキャン → 送金

## 本番デプロイ前チェックリスト

下記すべてを満たしてから本番に投入してください。CI (`.github/workflows/ci.yml`) で自動化される項目もあります。

| # | 項目 | 検証方法 / 担保 |
|---|---|---|
| 1 | テスト合格 | `npm run test:run` (CI 必須) |
| 2 | 型エラーなし | `npm run typecheck` (CI 必須) |
| 3 | 本番ビルド成功 | `npm run build` (CI 必須) |
| 4 | `package-lock.json` をコミット | `npm ci` が成功すること |
| 5 | `npm audit --audit-level=high --omit=dev` がクリーン | CI で必須 |
| 6 | permissionless API 名健全性 | `tests/hooks/useSmartAccount.test.tsx` の import smoke check |
| 7 | JPYC mainnet アドレス確認 | 既定値は JPYC v3 (`0xE7C3...3c29`、確認済)。デプロイ直前に [JPYC 公式](https://jpyc.jp/) で再突合 |
| 8 | Pimlico Sponsorship Policy 設定 | `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` 必須、ガス残高デポジット済み |
| 9 | Pimlico API Key の Origin 制限 | Pimlico ダッシュボードで本番ドメインに限定 |
| 10 | `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` 設定 | プレースホルダ (`0x...dEaD`) のまま投入しない |
| 11 | testnet で実 e2e (QR スキャン → 送金 → receipt) | Polygon Amoy / Base Sepolia で 1 件以上の成功確認 |
| 12 | Sentry DSN 設定 | `NEXT_PUBLIC_SENTRY_DSN` 設定で自動有効化。SDK は導入済 |
| 13 | Pimlico 残高アラート | ダッシュボードで POL / ETH デポジットの残量しきい値通知を設定 |

## ロールバック

OpenPay はフロントエンド単体 (DB なし、コントラクトなし) のため、バージョン切り戻しは即座に実行できます。

### Vercel
1. ダッシュボードの **Deployments** タブを開く
2. 直前の安定デプロイメントの「**...**」メニュー → **Promote to Production**
3. ~30 秒で切替完了

### Git ベース
```bash
git revert <bad-commit-sha>
git push origin main      # Vercel が自動で再デプロイ
```

### LocalStorage に残るデータ
店主の QR 設定 (`openpay:qr-settings:v1`) はキー名にバージョン (`v1`) を含むため、
スキーマ変更時はキーをインクリメントすればロールバック後も旧クライアントが破損しない。

## 監視 / アラート

| 観測対象 | 統合方法 | 現状 |
|---|---|---|
| クライアント / サーバ例外 | `@sentry/nextjs` (`instrumentation-client.ts` / `instrumentation.ts` / `app/global-error.tsx` で wired) | ✅ **コード統合済**。`NEXT_PUBLIC_SENTRY_DSN` を設定すれば自動有効化、未設定なら no-op |
| `lib/logger.ts` の構造化 JSON | Sentry SDK が `console.error` を自動インターセプト | ✅ DSN 設定で自動 |
| React レンダリングエラー | `app/global-error.tsx` で `Sentry.captureException` | ✅ 実装済 |
| UserOperation 失敗率 | Pimlico ダッシュボード標準機能 | アプリ側実装不要 |
| Sponsorship 残高 | (a) Pimlico ダッシュボード or (b) `scripts/check-pimlico-balance.mjs` を `.github/workflows/pimlico-balance.yml` で 6h 毎に実行 (multi-chain 対応 / 任意 webhook 通知) | ✅ コード同梱、secrets を設定すれば動作 |
| アプリ可用性 | Vercel Analytics / UptimeRobot | 未統合 — `/` と `/pay` の HTTP 200 監視を別途設定 |
| RPC レート制限 | Alchemy / Infura ダッシュボード | 公開 RPC では本番運用しないこと |

### Sentry 有効化手順
1. [Sentry](https://sentry.io) でプロジェクト作成 → DSN を取得
2. `.env.local` (or Vercel env) に `NEXT_PUBLIC_SENTRY_DSN=...` を設定
3. (任意) `SENTRY_AUTH_TOKEN` を設定するとビルド時に source maps がアップロードされ、stack trace が symbolicate される
4. Replay (ユーザ操作録画) は `instrumentation-client.ts` で既に enable 済 (DSN 設定で自動)。通常 10% / エラー時 100% sample、テキスト / 入力は全 mask

### Pimlico 残高アラート設定手順
GitHub リポジトリ Secrets / Variables に下記をセット:

| 種別 | 名前 | 値 |
|---|---|---|
| Secret | `PIMLICO_PAYMASTER_POLYGON` | Polygon 上の Pimlico Verifying Paymaster コントラクトアドレス |
| Secret | `PIMLICO_PAYMASTER_BASE` | Base 上の同上 |
| Secret | `POLYGON_RPC_URL` | (任意) 公開 RPC が混雑する場合に Alchemy / Infura URL |
| Secret | `BASE_RPC_URL` | 同上 |
| Secret | `ALERT_WEBHOOK_URL` | Slack/Discord 互換 webhook (`{ text }` POST 受け取り) |
| Variable | `ALERT_THRESHOLD_POL` | (任意) POL 単位のしきい値、デフォルト 5 |
| Variable | `ALERT_THRESHOLD_ETH` | (任意) ETH 単位のしきい値、デフォルト 0.01 |

`.github/workflows/pimlico-balance.yml` が 6 時間ごとに `scripts/check-pimlico-balance.mjs` を実行。残高がしきい値を下回ったら webhook に通知し、ジョブ自体も失敗させる (=GitHub の Actions 失敗通知も飛ぶ)。

## クレジット / 謝辞

本プロジェクトは下記のオープンソース・サービスの上に成り立っています。

### 中核ランタイム / SDK
- [**Pimlico**](https://www.pimlico.io/) — ERC-4337 Bundler / Sponsorship Paymaster (本 MVP のガスレス決済を可能にしている中核サービス)
- [**permissionless.js**](https://docs.pimlico.io/permissionless) — ERC-4337 / ERC-7702 Smart Account SDK
- [**viem**](https://viem.sh/) — TypeScript ファーストの Ethereum クライアント
- [**wagmi**](https://wagmi.sh/) — React ウォレット連携フック
- [**Next.js**](https://nextjs.org/) (App Router) / [**React**](https://react.dev/)
- [**Tailwind CSS**](https://tailwindcss.com/)
- [**TanStack Query**](https://tanstack.com/query) — 非同期状態管理
- [**Sentry**](https://sentry.io/) — エラートラッキング / 監視
- [**Reown WalletConnect**](https://reown.com/) / [**Coinbase Wallet**](https://www.coinbase.com/wallet) / [**MetaMask**](https://metamask.io/) — ウォレット接続

### ステーブルコイン発行体
- [**JPYC 株式会社**](https://jpyc.jp/) — 日本円ステーブルコイン JPYC
- [**Circle**](https://www.circle.com/) — 米ドルステーブルコイン USDC

### 仕様策定 / 標準化
- [**EIP-4337**](https://eips.ethereum.org/EIPS/eip-4337) (Account Abstraction) / [**EIP-7702**](https://eips.ethereum.org/EIPS/eip-7702) (Set EOA Code) の策定者および eth-infinitism / Ethereum Magicians コミュニティ

### 開発ツール
- 本コードのプロトタイピングに [**Claude Code**](https://claude.com/claude-code) を活用

## ライセンス

MIT — 商用・改変・再配布いずれも自由。詳細は LICENSE ファイル参照。

Made with ☕ by [cipherwebllc](https://github.com/cipherwebllc) — お問い合わせ・PR は GitHub Issues / PR でお気軽に。
