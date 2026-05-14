# OpenPay

<div align="center">
  <img src="overview.png" alt="OpenPay" width="100%" />
</div>

小規模店舗・イベント出店者・フリーランスが**ウォレットアドレス1つだけ**で導入できる、オープンソースの店舗向けガスレス決済 QR ジェネレーター。
ERC-4337 (Account Abstraction) + Pimlico Paymaster + ERC-7702 を組み合わせ、顧客はネイティブトークン (POL / ETH) を保有することなく **JPYC (Polygon)** または **USDC (Base / Arbitrum / Optimism / Polygon)** で決済できます。

- **JPYC (Polygon)**: 運営が POL ガスを肩代わり (Sponsorship Paymaster)
- **USDC (Base / Arbitrum One / Optimism / Polygon mainnet)**: 顧客が USDC のままガスを支払い (Pimlico ERC20 Paymaster)。運営のネイティブガス立替えなし
- **testnet (Base Sepolia / Arbitrum Sepolia / Optimism Sepolia / Polygon Amoy)**: USDC も sponsorship を使用 (顧客の testnet 用 ETH 入手の手間を省くための運用判断)

- `/{locale}` — 店舗向け決済 QR を主画面として提供 (レジ用クイック金額 / 印刷ポスター / SVG・PNG 保存)
- `/{locale}/pay?to=...&token=...&chain=...&amount=...&split=0xB:30,0xC:20` — QR をスキャンした顧客の決済画面 (`chain=` で USDC のチェーンを選択、`split=` で複数受取人へ % 分配可能)
- `/{locale}/tip/[address]?token=...&chain=...&name=...&message=...&color=...&preset=...&thanks=...&thanksUrl=...&webhook=...` — クリエイター向けチップ送金画面 (直リンク互換として維持)
- `/{locale}/checkout?...` — **実験的 / 非推奨**。直リンク互換のためルートは残すが、ホーム UI からは非表示。DB なし・署名なし webhook のため EC 本番用途では必ずオンチェーン再検証が必要
- `/{locale}/terms` `/{locale}/privacy` `/{locale}/disclaimer` `/{locale}/tokutei` — 利用規約・プライバシーポリシー・免責事項・特商法表記。全 page 共通の `SiteFooter` から到達可能。事業者情報は `lib/legal.ts` の `LEGAL_ENTITY` に集約 (単一 source of truth)
- `{locale}` は `ja` (デフォルト) または `en`。middleware が Accept-Language で自動検出

**Repo**: https://github.com/cipherwebllc/openpay  
**License**: MIT

## 直近の主要追加 (v0.2 候補)

- **Open Checkout for AI Agents (x402 protocol 課金ゲートウェイ)** — `/api/paid/*` を `withX402Payment` で 1 行 wrap するだけで、未払いリクエストに HTTP 402 + 支払い要件、`X-PAYMENT` header 付き再リクエストで verify → handler → settle の順で実コンテンツ返却、までを Coinbase 公式 `x402-next` package と公開 facilitator (`x402.org/facilitator`) 経由で実現。USDC / Base / Base Sepolia で動作確認、JPYC は EIP-3009 対応確認後の Phase 2 で対応予定。`X402_TEST_MODE=true` で dev/CI は payment bypass、production では起動 guard で流出阻止。demo `/api/paid/hello` + agent client (`examples/agent-client.ts`) + e2e smoke 付き、テスト 25 件追加 (~985 件 / 53 file)。詳細は §「Open Checkout for AI Agents」
- **next.js HIGH 脆弱性修正 + paymentLog → Sentry 集計** — `next` 15.5.16 → 15.5.18 で App Router middleware / proxy bypass via segment-prefetch routes (GHSA-26hh-7cqf-hhc6) を patch fix (major bump なし)。あわせて `postcss` 8.4.49 → 8.5.14 で MODERATE XSS を解消、残る Next.js 内部 bundled postcss は build-time / user-controlled CSS 経路なしで到達不能と判定済 (README §6 明文化)。`logPaymentEvent` の fetch 失敗を **二段構え観測** に変更: (1) `window.dispatchEvent('openpay:payment-log-failure')` で DevTools 観測、(2) `logger.warn` → `Sentry.captureMessage` で production 集計。`@/lib/logger` を mock せず `@sentry/nextjs` のみ mock した integration test (`tests/lib/paymentLog.sentry-integration.test.ts`、3 case) で paymentLog → logger → Sentry の 1 経路実走を verify。npm audit: HIGH **ゼロ**
- **Basenames Universal Resolver の hardcode 誤り修正** — `lib/resolveAddress.ts` が Base mainnet の `0xeEeE…eEee` を Basenames UR として hardcode していたが、実 RPC で `eth_getCode` を発火し **bytecode = 0 bytes** (= 未デプロイ) を確認。`.base.eth` は silent fail する状態だった。修正: mainnet ENS UR が CCIP-Read (ERC-3668) 経由で `.base.eth` も解決することを `jesse.base.eth` → `0x2211…D77DA9` で実証し、basenamesClient / `BASE_UNIVERSAL_RESOLVER` 定数を削除して mainnet client 単一に再構成。`scripts/verify-ens-resolver.mjs` を実 RPC smoke として永続化 (deploy gate に runnable)
- **middleware locale prefix の e2e smoke 追加** — `e2e/middleware-locale.spec.ts` (15 case) で **production build (`next start`) に対する実 HTTP** で / の locale redirect、`/ja` / `/en` の 200、4 legal page × 2 locale = 8 ルートの 200、未知 locale (`/fr`) の 404、`/manifest.webmanifest` middleware bypass、`/api/log/payment` GET 405 / 不正 body POST 400 を smoke。vitest では検出不能な runtime middleware regression を Next 本体 / next-intl の patch upgrade 時に catch する
- **コード品質 / LARP 監査の体系的修正** — (1) `validate()` を `as Payload` cast から **allow-list 構築型**に変更し未知 field の KV log 流入を sanitize、(2) timing 依存 (`Date.now() < 95ms`) の並列性 test を Promise instrumentation (microtask flush 後の called 検証) に書換、(3) validate の rejection path を `it.each` で 20 case 網羅、(4) `useBatchPayment` の log 発火を coverage で済ませず実 fetch body を behavioral 検証 (success / reverted / error / wallet 未接続 の 4 case)、(5) `LegalPageShell` / `LegalSection` 抽出で 4 legal page の重複構造を集約、(6) `lib/kv.ts` の `kvLtrim` で LIST_CAP=100K 件 cap、(7) viem 既存の `isAddress` / `isHex` を再利用し handrolled regex を削除、(8) AI 由来の dead defensive code (`dispatchEvent` 周りの try/catch、不可能 unconfigured 分岐、redundant cast) を削除。Tests 798 → 960 件 / 52 file、coverage 97.97 → 98.81、HIGH 脆弱性 ゼロ
- **特商法表記ページ追加 + JPYC 法的分類記述の修正** — `/{locale}/tokutei` を新設、SiteFooter に 4 番目の link として追加。販売事業者 / 法人番号 / 運営統括責任者 / 所在地 / 役務の内容 / 対応トークン / 料金 / 対価以外の費用 / 提供時期 / 支払時期 / 返品 / 動作環境 の 14 row を `LEGAL_ENTITY` から注入する definition list 形式で表示。電話番号は **特定商取引法施行規則第 23 条第 1 項第 2 号** の exception (「請求あり次第遅滞なく開示」) で省略。あわせて Terms 第 2 条 (定義) と Disclaimer 第 3 章で JPYC を「**改正資金決済法に基づき資金移動業者として発行される電子決済手段 (円建てステーブルコイン)**」に再分類 (旧記述「暗号資産 / 第三者発行 token」は前払式 3 号時代の名残で不正確)
- **alpha 取引 log の Vercel KV 永続化** — `useBatchPayment` / `useDirectPayment` から決済成否を `/api/log/payment` に POST、Upstash Redis (Vercel KV) の `openpay:payments:log` に LPUSH で蓄積。flow / result / chainId / token / merchant / customer / amounts / userOpHash / txHash / blockNumber / 匿名化済 IP prefix (IPv4 /24 or IPv6 /64) / userAgent を保存。`/api/log/payment/export` は `Authorization: Bearer $PAYMENT_LOG_ADMIN_TOKEN` で全件取出可能 (`?from` `?to` で range 指定)。**KV 未設定でも UI 完全動作** (Vercel runtime log のみに記録される graceful degrade)。弁護士 review / 金融庁事前相談 / GMV 集計用の事実関係資料として 6 ヶ月運用後に export 想定。`@vercel/kv` 等の package 依存を持たず `lib/kv.ts` の薄い fetch wrapper で Upstash REST API を叩く。テスト 23 件追加 (876 件 / 50 ファイル)
- **法的文書 (利用規約 / プライバシーポリシー / 免責事項) と Alpha バナーの整備** — `/{locale}/terms` `/{locale}/privacy` `/{locale}/disclaimer` の 3 page を新設、全 page 共通の `SiteFooter` から到達可能に。事業者情報 (商号・法人番号・登記住所・代表者・連絡先メール・施行日) は `lib/legal.ts` の `LEGAL_ENTITY` に集約 (env 注入に切替える場合もここの export だけ差替えで済む)。利用規約は 11 条 (適用 / 定義 / non-custodial 性質 / 利用環境 / 料金 / 取消不能 / 禁止事項 / 第三者サービス / 免責 (消費者契約法 8 条準拠) / 規約変更 (民法 548 条の 4 準拠) / 準拠法・東京地裁)、プライバシーは 7 章 (個情法 28 条 越境移転 / 33-35 条 開示等請求対応)、免責は 6 章。文面は **弁護士 review 前提の draft**。全 page 最上部に `AlphaNotice` (amber banner、`print:hidden` で QR ポスター印刷時非表示、`/disclaimer` link 付) を表示し alpha 版である旨と少額テスト推奨を明示。`Footer` / `Terms` / `Privacy` / `Disclaimer` / `AlphaNotice` の 5 namespace を ja/en 両 messages に追加 (~150 key)、テスト 17 件追加
- **店舗向け QR 強化** — 店舗名・ポスター補足文・レジ用クイック金額 (最大 8 件) を端末ローカルに永続化、印刷用ポスター section を追加、SVG / PNG ダウンロードと `window.print()` による直接印刷に対応。`fileSafe` は UTF-8 を許容するので日本語店舗名 (神田珈琲 等) もファイル名にそのまま使える。クイック金額は token 切替時に現 token の decimals に truncate + dedup、印刷時は poster 以外を `print:hidden` で隠す
- **axios HIGH 脆弱性を override で解消** — `@coinbase/cdp-sdk` (wagmi → @wagmi/connectors → @base-org/account 経由 transitive) が要求する古い axios で SSRF / prototype pollution / auth bypass 等 15 件の advisories が HIGH に昇格 → CI の `npm audit --audit-level=high` を blocking。`package.json` の overrides で `axios: ^1.15.2` を強制 pin (実解決 1.16.0)。module load / constructor / interceptor 互換は `tests/lib/axios-override.test.ts` の 5 件で自動担保
- **production readiness 強化** — デプロイチェックリストに「コード自動化不可、deploy 時に人手必須」項目 (Sentry alert rule / Pimlico 残高 alert) を ⚠ マーク付きで追加。§本番投入前に必ず検証すべきポイント に Coinbase Wallet 実 network call 互換 (testnet 1 件送金成功) と Lighthouse / 負荷測定の未実施を honest に明記
- **不具合 4 件修正** — (1) direct mode でも `useBatchPayment` 経由で Smart Account 初期化が走る問題を `enabled` 伝播で解消、(2) testnet USDC sponsorship fallback で非 Polygon chain が `gasQuoteReady=false` のまま送信不能になる問題を `useGasQuoteJpyc` の Polygon 外 0 返しで解消、(3) Tip preset の重複が React duplicate key 警告と URL 重複入力を起こす問題を `TipEmbedGenerator` / `lib/url.ts` 双方で dedup、(4) 回帰テスト 4 件を追加 (763 件 / 42 ファイル)
- **店舗QR重視へ整理** — ホーム UI は店舗向け決済 QR と Tip widget のみに絞り、Checkout 生成タブは非表示化。Checkout ルートは直リンク互換のため残すが、DB なし・署名なし webhook の制約があるため実験的扱い
- **EIP-681 互換 QR 併発行 (BYO wallet)** — 直接送金 + 金額指定 のとき、[EIP-681](https://eips.ethereum.org/EIPS/eip-681) 準拠の `ethereum:<token>@<chainId>/transfer?address=...&uint256=...` URI を併発行。任意の対応ウォレットから純粋 ERC20 transfer で送金可能 (OpenPay checkout を経由しない)。仕様準拠は自動検証済 (regex / viem `isAddress` / `URL.canParse`)、実ウォレットでの読取検証手順は §「EIP-681 互換 QR の実ウォレット読取検証」を参照。OpenPay は wallet 製造せず checkout 層に徹する方針を明示
- **Phase 1 multi-chain USDC** — Base 限定から Base / Arbitrum One / Optimism / Polygon の **4 chain 対応** へ拡張。`/pay?token=usdc&chain=arbitrum` のような chain slug を URL で指定可能 (省略時は base 既定で旧 QR と互換)。Pimlico の `getTokenQuotes` で 4 chain × mainnet/testnet の全 8 deployment が valid な quote を返すことは `scripts/verify-pimlico-usdc.mjs` で確認済 (Universal Paymaster `0x7777777777...e66834C`)
- **Checkout (実験的 / 非推奨)** — Stripe Checkout 相当の itemized 決済 URL ルート `/checkout` は直リンク互換として維持。ただし URL とブラウザ発火 webhook に依存する設計のため、ホーム UI からは外し、EC 本番用途ではサーバー側オンチェーン再検証が必須
- **Webhook 多重発火 fix** — `userOpHash` 単位で `useRef` gate し、gasQuote refetchInterval (30s) で breakdown が再計算されても 1 回限りの POST を保証
- **Sentry 直接統合** — `lib/logger.ts` から `Sentry.captureMessage / captureException` を呼出。default integration の breadcrumb のみだった旧経路を独立 event 化
- **rollback 制約の明文化** — multi-chain URL が出回った後の旧バージョン rollback は **silent fund misdirection** を起こすため、§ロールバック で禁止条件を明記
- **テスト** — 960 件 / 52 ファイル (lib テストの SUT 自身は実 import、外部 SDK のみ境界 mock。hook / component は wagmi / permissionless 等の外部 SDK 境界のみ mock。paymentLog → Sentry の橋渡しも実 logger 経由で integration 検証済)。coverage 98.81 / 96.19 / 92.57 / 98.81。e2e 28 件 (chromium + mobile-safari)
- **e2e 安定化** — Playwright 24 件 (chromium + mobile-safari) を全パスへ。wallet 接続を要する submit ボタン文言ではなく、未接続時に必ず描画される breakdown 行 + connect ボタン文言を assert する形に再設計
- **ESLint v9 flat config 移行** — Next.js 16 で `next lint` が削除されるため、`eslint.config.mjs` (FlatCompat 経由 next/core-web-vitals) + `eslint .` 直接呼出しに前倒し移行。`.eslintrc.json` は撤去
- **Sentry config 後継 API へ更新** — `disableLogger` (deprecated) → `webpack.treeshake.removeDebugLogging`。Sentry v11 の breaking change を回避
- **Lighthouse CI 修正** — `localePrefix: 'always'` の i18n 設計と衝突していた `/` (→ `/ja` redirect) audit を撤去し、`/ja` `/en` `/ja/pay` `/ja/tip` の canonical 4 URL のみ計測する形に

## 特徴

| 項目 | 内容 |
| --- | --- |
| ガスレス (JPYC) | Pimlico Sponsorship (Verifying) Paymaster で運営が POL を肩代わり |
| ガスレス (USDC) | Pimlico ERC20 Paymaster で顧客が USDC のままガスを支払う (ETH 不要) |
| EOA をそのまま使用 | ERC-7702 によって、顧客の MetaMask 等の **既存 EOA 残高** で決済 (事前送金不要) |
| バッチ送金 | 「店主への送金」と「運営手数料」を 1 つの UserOperation にまとめて送信 |
| マルチチェーン | JPYC (Polygon) / USDC (Base / Arbitrum / Optimism / Polygon) を切替可能 |
| 登録審査不要 | 店主は自分のウォレットアドレスを入力するだけで QR を発行 |
| 据え置き QR / 金額指定 QR | 店頭掲示用の据え置き QR と、レジで金額を打つ金額指定 QR の両対応 |
| 店舗印刷ツール | 店舗名・補足文つきの印刷用 QR ポスター、SVG / PNG 保存、レジ用クイック金額ボタン |
| 直接送金 (上級者) | ガス代を顧客負担にすることで運営手数料 0% で送金できるオプションモード |
| EIP-681 互換 QR | 直接送金モード + 金額指定 + split 無しのとき、`ethereum:<token>@<chainId>/transfer?...` 形式の URI を併発行 (OpenPay checkout を経由しない純粋 ERC20 transfer)。仕様準拠は自動検証済、実ウォレット読取は §9 検証手順を参照 |
| BYO wallet | OpenPay は checkout 層に徹し、ウォレット自体は製造しない。WalletConnect v2 / EIP-6963 / Coinbase Wallet 等を経由して顧客が任意のウォレットで支払える |
| Tip widget (β) | iframe 1 行貼付でブログ・配信ページ・GitHub README に埋め込めるチップ送金 UI。固定 preset + カスタム金額、テーマカラー設定可。webhook は同一 userOpHash につき 1 回限りの POST (gasQuote refetch 耐性、`useRef` gate で実装) |
| Checkout (実験的 / 非推奨) | 直リンク互換のためルートは残すが、ホーム UI からは非表示。DB なし・署名なし webhook のため本番 EC 用途ではサーバー側検証が必須 |

## 現金 / クレカ / PayPay との比較

| 項目 | 💴 現金 | 💳 クレジットカード² | 📱 PayPay¹ | ⚡ OpenPay |
| --- | --- | --- | --- | --- |
| **導入審査** | 不要 | 必要 (加盟店契約 + 審査) | 必要 (店舗登録 + KYC) | **不要** (ウォレットアドレス入力のみ) |
| **初期コスト** | レジ・釣銭準備 | 端末 + 月額利用料² | 端末 / QR スタンド申込 | **0 円** (印刷 QR で可) |
| **店舗受取手数料** | 0% | 約 3.25〜3.75%² (一部 5%超) | 1.60〜1.98%¹ | **1.0% + ネットワーク手数料 (見積)** / **0%** (直接送金モード) |
| **入金タイミング** | 即時 (店舗内) | 翌営業日〜月 1〜2 回² | 翌日〜月次¹ | **即時** (オンチェーン確定 数秒〜数十秒) |
| **チャージバック** | なし | あり (店舗負担リスク) | 一部あり | **なし** (オンチェーン確定で取消不可) |
| **釣銭** | 必要 (両替コスト・誤算リスク) | 不要 | 不要 | **不要** |
| **記帳** | 手動 / レジ閉め | カード会社管理画面 | 管理画面 | **オンチェーンで自動 + 改竄不可** |
| **海外顧客** | 両替が必要 | 国際ブランドで対応 (DCC 手数料あり) | 国内中心 | **グローバル** (USDC は世界共通通貨) |
| **紛失 / 盗難** | 物理リスクあり | 物理 (但し補償あり) | 限定的 | **秘密鍵管理のみ** |
| **顧客のガス代** | ─ | ─ | ─ | **JPYC: 0 円 (運営肩代わり) / USDC: USDC 建てで自動徴収 (ETH 不要)** |
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

日本のイラストレーター / エンジニア / 翻訳者が海外クライアントから報酬を受け取る際、Wise や PayPal は **手数料 3〜5% + 着金 3〜7 営業日 + 書類処理** が要ります。OpenPay の請求 URL を発行してクライアントへ送れば、USDC で **即時着金 (オンチェーン確定 数十秒) / 手数料 1.0% + ガス見積 / 書類ゼロ** で受け取れます。

- 発行手順: `/` で USDC を選び、自分のウォレットアドレスを入力 → 金額指定 → URL or QR を発行 → クライアントへ送付 (メール / Slack / Notion 等で 1 行貼り付けるだけ)
- クライアント側に必要なのは EIP-7702 対応 EOA (MetaMask v12+) のみ。USDC のガス代は USDC 建てで自動徴収されるため ETH の保有は不要
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

イラストレーター・配信者・OSS maintainer 等が、ブログ・ポートフォリオ・配信ページ・GitHub README に **iframe 1 行貼付** でチップ送金 UI を組み込めます。pixivFANBOX / BOOST / Twitter tip 等は手数料 10〜15% + 月次入金 + 海外決済不可ですが、OpenPay は **手数料 1.0% + ネットワーク手数料 (見積) / 即時着金 / 海外 OK / JPYC + USDC 両対応**。

- 設定: `/` の「Tip widget」タブで受取アドレス・通貨・表示名・メッセージ・テーマカラー・preset 金額を入力 → URL と iframe スニペットを生成
- 埋め込み:
  ```html
  <iframe
    src="https://your-openpay.example.com/tip/0x...?token=jpyc&name=山田太郎&color=%231e3a8a"
    width="380" height="640" style="border:0;max-width:100%"
    title="OpenPay Tip" loading="lazy"
  ></iframe>
  ```
- ファンは MetaMask v12+ などで接続し、preset (JPYC: 300/1000/3000、USDC: 5/20/50) かカスタム金額を選んで送信。JPYC は運営がガスを肩代わり、USDC はファンの USDC 残高から自動徴収 (ネイティブトークン不要)
- iframe 埋め込みは `Content-Security-Policy: frame-ancestors *` で全オリジン許可 (アクションは MetaMask ポップアップで起こるためクリックジャッキング不成立)
- webhook は Discord / Slack / 独自バックエンドへの**通知用途**として扱ってください。限定コンテンツ配布、会員権限付与、注文確定など「権限や特典を発生させる処理」に使う場合は、webhook payload を信頼せず `txHash` / `userOpHash` を必ずオンチェーンで再検証してください。

### 5. Open Checkout for AI Agents — x402 protocol 課金ゲートウェイ

**「Stripe Checkout の再発明」ではなく、AI agent / API / MCP が叩く有料エンドポイントに x402 で per-request 課金を付けるためのゲートウェイ**です。人間向け UI は介在しません。

仕組み:

1. AI agent が `GET /api/paid/hello` を叩く
2. 未払いなら server が **HTTP 402 Payment Required** + `accepts: [paymentRequirements]` を返す
3. agent (x402-fetch / x402-axios 等) が requirements を見て USDC を EIP-712 sign し、`X-PAYMENT` header に base64 で詰めて再リクエスト
4. server が **facilitator (`x402.org/facilitator` 等)** に verify / settle を依頼
5. 検証成功 + on-chain 確定後にだけ実コンテンツを返す (`X-PAYMENT-RESPONSE` header 付き)

開発者は `lib/x402/middleware.ts` の `withX402Payment` で route を 1 行 wrap するだけ:

```typescript
// app/api/paid/hello/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { withX402Payment } from '@/lib/x402/middleware';

async function handler(_req: NextRequest) {
  return NextResponse.json({ message: 'Hello, paid AI agent.', timestamp: new Date().toISOString() });
}

export const GET = withX402Payment(handler, { description: 'My paid API' });
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

price / network / facilitator は `.env.local` の `X402_*` で project default を設定、route 側で個別に override 可能。

#### 動作確認 (ローカル)

```sh
# 1. 環境変数 (.env.local) を最低限セット
echo "X402_NETWORK=base-sepolia" >> .env.local
echo "X402_PAY_TO_ADDRESS=0x...your-receiving-wallet..." >> .env.local

# 2. dev server を起動 → 未払い 402 を確認
npm run dev
curl -i http://localhost:3000/api/paid/hello
#   HTTP/1.1 402 Payment Required
#   ...
#   {"x402Version":1,"error":"...","accepts":[{ "scheme":"exact", "network":"base-sepolia", ... }]}

# 3. test mode で payment 検証を bypass (dev only) → 200 を確認
X402_TEST_MODE=true npm run dev
curl http://localhost:3000/api/paid/hello
#   {"message":"Hello, paid AI agent.","timestamp":"2026-..."}
```

#### AI agent client 経由で実支払い (Base Sepolia)

1. Base Sepolia の USDC と ETH (gas) を [Circle faucet](https://faucet.circle.com) で取得
2. 上記 USDC を持つ EOA の private key を `AGENT_PRIVATE_KEY` env に設定
3. example client を起動:

```sh
AGENT_PRIVATE_KEY=0x... PAID_URL=http://localhost:3000/api/paid/hello \
  npx tsx examples/agent-client.ts

# [agent] requesting http://localhost:3000/api/paid/hello
# [agent] from address 0x... on Base Sepolia
# [agent] HTTP 200 OK
# [agent] x-payment-response: { success: true, transaction: "0x...", ... }
# [agent] body: { message: "Hello, paid AI agent.", timestamp: "..." }
```

#### 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | verify / settle を委譲する facilitator。production では https:// 必須 (起動 guard) |
| `X402_NETWORK` | `base-sepolia` | `base` (mainnet) または `base-sepolia` (testnet) |
| `X402_PAY_TO_ADDRESS` | (testnet は `0x…dEaD` fallback) | 受取アドレス。mainnet では起動時必須 |
| `X402_ASSET` | (未設定 = network 既定 USDC) | カスタム asset アドレス (bridged USDC.e は非対応) |
| `X402_PRICE` | `$0.001` | 既定 price (route 側で override 可) |
| `X402_TEST_MODE` | `false` | true で payment 検証 bypass (dev only)、`NODE_ENV=production` と同時設定で起動失敗 |

#### セキュリティ注意点

- **支払い検証前に handler は実行されない**: `withX402` が verify → handler → settle の順を保証。settle 失敗時は content を返さず 402 で応答
- **例外時は 500 でなく 402 に倒す**: facilitator 不到達などで内部例外が出ても、`logger.warn('x402.middleware.error', ...)` で Sentry に集計しつつ 402 を返す
- **production で TEST_MODE = 起動失敗**: `lib/x402/config.ts` の起動時 throw で本番への流出を防止
- **リプレイ攻撃の限界**: 防御は EIP-3009 nonce (token contract 側) + facilitator 依存。OpenPay は独自 nonce DB を持たない (DB 依存最小化方針)。完全防御は facilitator の実装に依存する
- **AI agent の DDoS / rate limit**: 本実装範囲外。Vercel BotID または別途 rate limiter で対策が必要
- **`AGENT_PRIVATE_KEY` の取扱い**: server-side / CLI 実行を想定。フロントエンド / repo にコミットしないこと

#### JPYC 対応について (Phase 2)

現状は USDC / Base / Base Sepolia のみサポート。**JPYC の x402 対応は EIP-3009 (`transferWithAuthorization`) を JPYC v3 が実装している必要があり、未検証**。対応確認次第、`X402_NETWORK=polygon` + `X402_ASSET=0xE7C3…3c29` で動かす想定。

#### 採用しない選択肢

- 人間向け Stripe Checkout 風 UI (既存 `/checkout` がその役割)
- サブスク / 注文履歴 / 会員管理 / カート
- self-host facilitator (env override で対応可だが default は Coinbase 公開)
- 独自 nonce DB (DB なし方針、on-chain で完結)

### 4. Checkout (実験的 / 非推奨) — 直リンク互換のみ維持

Checkout ルートは過去に生成した直リンクとの互換性と検証用途のため残していますが、現在の OpenPay は **店舗向け決済 QR を主機能** とし、ホーム UI から Checkout 生成タブを非表示にしています。

- 発行: UI からの新規発行は非表示。必要な場合のみ `/checkout?...` 形式の直リンクを手動または外部ツールで生成
- 顧客 UX:
  - URL を開くと line items 一覧 + 合計 + ガス見積が表示される
  - 「支払う」を押すと **既存の `/pay` と同じ ERC-7702 + Pimlico ガスレスバッチ送金** で merchant 受取 + 運営手数料を 1 UserOp で実行
  - 成功後に `success_url` 指定なら 3 秒で自動 redirect (skip ボタン併設)、`tx_hash` / `user_op_hash` / `order_id` が query に付与される
- webhook: 成功時に **Tip と互換シェイプ** の JSON を POST (`type: "openpay.checkout.success"` + `items`, `orderId`, `merchantAmount` 等)。マーチャントは Tip と同じ handler に分岐 1 行追加で両対応可能
- **重要 (セキュリティ)**: webhook payload と success_url の query は顧客側で改ざん可能 (Stripe の `whsec_` 署名相当の保証なし)。**マーチャントは webhook 受信後に必ず `tx_hash` をオンチェーンで再検証**してから注文を確定してください。これが不要な店舗対面決済では `/pay` QR の利用を推奨します
- 制約: line items 最大 10 件 / name 80 文字 / qty 1〜999 / price は token decimals 以内。bridged USDC.e は不可 (native USDC のみ)

```
/checkout?to=0x...&token=usdc&chain=arbitrum
        &items=Tシャツ:1:25,マグ:2:15
        &order_id=ord-12345
        &success_url=https://shop.example.com/thanks
        &webhook=https://shop.example.com/openpay-webhook
```

## 対応ネットワークと選定理由

| トークン | チェーン | ガス通貨 | 採否 | 理由 |
| --- | --- | --- | --- | --- |
| JPYC v3 | **Polygon** | POL | ✅ 採用 | JPYC v3 (`0xE7C3…3c29`) が Polygon 上で発行され、DEX/ブリッジ/オンランプの流動性が集中。日本国内の JPYC ユーザの主要居住地 |
| USDC (native) | **Base** | ETH | ✅ 採用 | Circle 公式 native USDC (`0x8335…2913`)。Coinbase ウォレット経由のオンランプが容易、低ガス、Base 系 dApp との互換性。`/pay?token=usdc` 既定 |
| USDC (native) | **Arbitrum One** | ETH | ✅ 採用 | Circle 公式 native USDC (`0xaf88…5831`)。L2 で最大規模の TVL、bridged USDC.e と区別される native 版 |
| USDC (native) | **Optimism** | ETH | ✅ 採用 | Circle 公式 native USDC (`0x0b2C…Ff85`)。Superchain エコシステム中心の決済チェーン |
| USDC (native) | **Polygon PoS** | POL | ✅ 採用 | Circle 公式 native USDC (`0x3c49…3359`)。JPYC ユーザと同じ Polygon 上で USDC を選択可能 |
| JPYC | Ethereum | ETH | ❌ 不採用 | ガス代が決済額に対して高すぎる (5 JPYC の運営手数料 + 数百円 gas) |
| JPYC | Avalanche | AVAX | ❌ 不採用 (一旦様子見) | Avalanche 上の JPYC は **DEX ペアの流動性がほぼゼロ**。手数料を AVAX に変換するルートがクロスチェーンになり、ガス調達が常に赤字。日本のリテールユーザの利用が限定的 |
| JPYC | Base / Arbitrum / Optimism | ─ | ❌ 発行なし | JPYC v3 はこれらのチェーン上に **発行されていない**。JPYC 公式が他チェーンへ展開した場合のみ追加検討 |
| USDC (bridged) | 各 chain (USDC.e) | (各 chain ガス) | ❌ 不採用 | bridged 版は Pimlico ERC20 Paymaster の対応が不安定。OpenPay は **native USDC のみ** 対応 |

### 運用上の含意 (JPYC / Polygon)

1. 顧客の決済ごとに Pimlico Sponsorship Paymaster は **POL を消費**する
2. 運営は手数料 1.0% (JPYC) を **JPYC** で受け取る
3. 運営は定期的に **JPYC → POL** に swap して Pimlico 残高を補充する必要がある
   - JPYC/POL の DEX ペアは流動性が薄いため、実務的には **JPYC → USDC → POL** の 2-hop swap (QuickSwap / Uniswap v3 on Polygon) が現実的
   - 自動化案: OpenZeppelin Defender Sentinel / cron + viem による定期 swap
4. JPYC 1.0% / 5 JPYC の料率は純マージンとして設定 (gas は別建て徴収)。`NEXT_PUBLIC_POL_JPYC_RATE` で POL→JPYC 換算レートを実勢に合わせて月次で見直してください。`lib/gasCeiling.ts` の上限を超える gas spike では UserOp が早期 abort され、運営の POL 立替不足を防ぐ仕様 (詳細は「Gas price ceiling」節)

### 運用上の含意 (USDC / 全 4 chain)

1. ガス代は **顧客が USDC のままで支払う**ため、運営はネイティブ ETH/POL を立替えない (Sponsorship Paymaster と異なり残高補充の運用が要らない)
2. 内部実装は Pimlico の **ERC20 Paymaster** + permissionless `prepareUserOperationForErc20Paymaster` を使用。UserOp の calls 先頭に paymaster コントラクトへの USDC `approve` が自動注入される (既に十分な allowance がある場合はスキップ)
3. 顧客が UI で見る支払額は `決済額 + 運営手数料 + ガス代見積 (USDC 建て)`。ガス代は worst-case 見積で表示し、実費が下回れば超過分は引き落とされない
4. **chain ごとに Pimlico の token quote を取得**し、その chain の ETH/POL ↔ USDC レートで gas を換算する (`hooks/useGasQuoteUsdc.ts`)。chain 切替時は自動で再取得
5. URL に `chain=` パラメタが無い場合は **Base にフォールバック** (既存 QR との互換性確保)
6. testnet (Base Sepolia / Arbitrum Sepolia / Optimism Sepolia / Polygon Amoy) では USDC でも **自動的に Sponsorship Paymaster にフォールバック**する (`lib/pimlico.ts:resolvePaymasterMode`)。これは顧客が testnet 用 USDC + ETH を両方用意せずに動作確認できるようにする運用判断
7. **bridged USDC.e は対応外**。Circle 公式 native USDC コントラクト以外を `NEXT_PUBLIC_USDC_<chain>_<env>_ADDRESS` に指定すると Pimlico Paymaster がエラーを返す可能性が高い

### 将来の拡張余地

- Ethereum mainnet / Unichain / Linea / Celo / Scroll 等の追加は `lib/tokens.ts` (USDC deployment 追記) と `lib/chains.ts` (slug 追加) の 2 箇所への追記で完結。**実需要が確認できてから追加**する方針
- JPYC の Base / Arbitrum 等への拡大は **JPYC 公式の他チェーン発行待ち**。現状 JPYC v3 は Polygon 上のみで発行されているため OpenPay も Polygon 単一で運用

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
│       5. token に応じて Paymaster を選択                │
│          - JPYC: Sponsorship (運営が POL を肩代わり)    │
│          - USDC: ERC20 Paymaster (顧客が USDC で支払い) │
│       6. ERC20.transfer × 2 (店主 / 運営) を batch       │
│          (USDC は paymaster への approve も先頭に注入)  │
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
│   ├── fee.ts                       # チェーン別料率 / MIN_FEE 計算
│   ├── gasCeiling.ts                # チェーン別 gas 上限 / GasCongestedError
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

## 前提条件 (本番運用に必要な外部アカウント / 設定)

ローカル開発だけなら **Pimlico API Key の準備のみ** で動きます。本番デプロイには下記すべてが必要です。

| サービス | 必要な理由 | コスト | 設定箇所 |
|---|---|---|---|
| **Pimlico** ([dashboard.pimlico.io](https://dashboard.pimlico.io)) | ガスレス送金の bundler + paymaster (JPYC=Sponsorship / USDC=ERC20) | 従量課金 (Sponsorship 分のみ) | `NEXT_PUBLIC_PIMLICO_API_KEY` + Sponsorship Policy ID |
| **WalletConnect / Reown** ([cloud.reown.com](https://cloud.reown.com)) | WalletConnect ウォレット接続 (任意、未設定時は除外される) | 無料枠あり | `NEXT_PUBLIC_WC_PROJECT_ID` |
| **Sentry** ([sentry.io](https://sentry.io)) | エラー追跡 + Replay (10% / エラー時 100%) | 無料枠あり | `NEXT_PUBLIC_SENTRY_DSN` (Plain) + `SENTRY_AUTH_TOKEN` (Sensitive) |
| **Vercel** ([vercel.com](https://vercel.com)) | Next.js デプロイ + middleware (i18n routing) | Hobby 無料 | プロジェクトインポート + env 投入 |
| **Ethereum mainnet RPC** (任意推奨) | ENS (.eth) / Basenames (.base.eth) 解決 — 既定の publicnode.com に SLA なし | Alchemy / Infura 無料枠あり | `NEXT_PUBLIC_MAINNET_RPC_URL` (CCIP-Read 必須) |
| **GitHub Secrets** | Pimlico balance cron / Lighthouse / Playwright workflow 用 | 無料 | repo Settings → Secrets (詳細は「監視 / アラート」節) |
| **Webhook (Slack/Discord/PagerDuty)** | Pimlico 残高アラート通知先 | 無料 | `ALERT_WEBHOOK_URL` (GitHub Secrets) |
| **EIP-7702 対応ウォレット** (顧客側) | gasless 送金は ERC-7702 が必須 | 無料 | MetaMask v12 系以降の安定版 |

**Coinbase Wallet / 一部の WalletConnect ウォレットは ERC-7702 未対応** の可能性があります。本番投入前に testnet (Polygon Amoy / Base Sepolia) で実 wallet と接続して 1 件送金成功を確認してください。

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
| `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` | ◯ (JPYC 用 / USDC は不要) | Pimlico の Sponsorship Policy ID (例: `sp_xxxx`)。USDC は ERC20 Paymaster なので未指定でも動く |
| `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` | ◯ | 運営手数料の受取アドレス |
| `NEXT_PUBLIC_WC_PROJECT_ID` | △ | [Reown Cloud](https://cloud.reown.com) で発行した WalletConnect Project ID。未設定時は WalletConnect 連携が無効化される |
| `NEXT_PUBLIC_*_RPC_URL` | × | 公開 RPC が混雑する場合に Alchemy/Infura 等の URL を指定 (Base / Arbitrum / Optimism / Polygon 各 mainnet/sepolia) |
| `NEXT_PUBLIC_JPYC_TESTNET_ADDRESS` | × | testnet で独自に発行した JPYC を指定する場合に上書き |
| `NEXT_PUBLIC_USDC_<chain>_<env>_ADDRESS` | × | 対応 4 chain × mainnet/testnet で USDC コントラクトを上書き (例: `NEXT_PUBLIC_USDC_ARBITRUM_MAINNET_ADDRESS`)。bridged USDC.e は非対応 — native USDC のみ |
| `NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI` | × | Polygon mainnet の `maxFeePerGas` 上限 (gwei、整数)。既定 200。Sentry の `gas_congested` 件数を見て調整 |
| `NEXT_PUBLIC_GAS_CEILING_BASE_GWEI` | × | Base mainnet の `maxFeePerGas` 上限 (gwei、整数)。既定 1。L2 のみで判定 (L1 calldata は別軸監視) |
| `NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI` | × | Arbitrum One の `maxFeePerGas` 上限 (gwei、整数)。既定 1 |
| `NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI` | × | Optimism の `maxFeePerGas` 上限 (gwei、整数)。既定 1 |
| `NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS` | × | USDC ERC20 Paymaster の「最大ガス代」見積に使う UserOp gas 単位 (整数)。既定 500_000 は実機計測前の rough な値、本番計測後に調整 |

### 3. Pimlico ダッシュボード設定

1. [https://dashboard.pimlico.io](https://dashboard.pimlico.io) でアカウント作成し API Key を発行
2. **本番運用時は必ず "Origin (ドメイン) 制限" を有効化**してください (本番ドメイン: `https://open-pay.jp`)。`NEXT_PUBLIC_PIMLICO_API_KEY` はクライアントバンドルに含まれるため、Origin 制限なしでは API Key が悪用される可能性があります
3. **Sponsorship 残高をデポジット (JPYC 用)**:
   - `mainnet`: Polygon (POL)
   - `testnet`: Polygon Amoy (POL) / Base Sepolia (ETH) / Arbitrum Sepolia (ETH) / Optimism Sepolia (ETH) ※ testnet では USDC も sponsorship にフォールバックするため対応 4 chain 全ての L2 ETH が必要
   - **mainnet の USDC (Base / Arbitrum / Optimism / Polygon) は ERC20 Paymaster 経由で顧客が払うため Sponsorship 残高デポジットは不要**
4. **Sponsorship Policy** を作成し、その `policyId` を `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` に設定 (JPYC で適用される。USDC mainnet 用には別途設定不要)
5. **濫用対策ルール** を Policy に必ず設定 (これがないと、誰かが任意の `/pay` URL を生成して運営の sponsorship 残高を消費できる)。**JPYC (Polygon) のみが対象** (USDC は ERC20 Paymaster なので濫用余地なし — 顧客が払う):
   - `to address allowlist`: JPYC コントラクト (mainnet: `0xE7C3...3c29` / Polygon Amoy: 自分のテストデプロイ)
   - `function selector allowlist`: `transfer(address,uint256)` (`0xa9059cbb`) のみ
   - `data parameter constraint`: 受取人パラメータの 1 つが必ず `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` であること (= 運営手数料 transfer を含む UserOp のみ sponsor)
   - **gas price 上限**: `lib/gasCeiling.ts` の Polygon 値 (200 gwei) と同等以上を Policy に設定。クライアント側ガードはユーザ向け早期エラー、Policy 側は改竄不可な最終防衛線として機能 (二重ガード)
   - クライアント側でも sponsorship mode のとき `useBatchPayment` が `feeAmount > 0` と `assertGasCeiling` を assertion して defense in depth (ERC20 mode では顧客が支払うため gas ceiling は不要)

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
2. 通貨 (USDC / JPYC)・受取アドレスを入力 (LocalStorage に保存)
3. **金額指定 QR**: 請求金額を入力 → 一回限りの QR が生成
4. **据え置き QR**: 金額入力なしで生成 → 顧客が金額入力する据え置き QR
5. QR を印刷 / 表示。または URL コピーで送付

### 顧客側 (決済)

1. QR をスキャン → `/pay?to=...&token=...&fee=...&amount=...` が開く
2. ウォレット接続
   - **PC**: ブラウザ拡張は EIP-6963 で自動列挙 (MetaMask / Rabby / Phantom / Backpack 等が独立ボタン化) + Coinbase Wallet + WalletConnect
   - **スマホ**: 拡張機能が無いため独立ボタンは Coinbase Wallet のみ。MetaMask / Rabby / Ronin / Phantom / Backpack 等は **`WalletConnect` ボタン → モーダルから選択** (deep-link or QR)
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

Tip widget はクリエイターが preset 額をそのまま受け取り、ファンが運営手数料 + ネットワーク手数料 (見積) を上乗せして支払います (内訳・MIN_FEE は通常決済と同じ)。

## 手数料の計算

**運営手数料は常に店主負担** (SaaS / カード決済の販売手数料的な固定コスト、顧客には不可視)。
QR 発行時に店主が **ネットワーク手数料の負担者** を選択:

### `gas=customer` モード (default)
顧客がネットワーク手数料を上乗せ支払い。**店主の取り分は gas spike に左右されず安定**。

| 項目 | 計算 |
|---|---|
| 顧客支払額 | `amount + gasQuote` |
| 店主受取 | `amount - fee` |
| 運営取分 | `fee` (固定。sponsorship 時は + gas 相当 を Pimlico への POL 精算に充当) |

### `gas=merchant` モード
店主がネットワーク手数料も吸収。**顧客は表示金額のみ支払う** (内税的 UX)。

| 項目 | 計算 |
|---|---|
| 顧客支払額 | `amount` |
| 店主受取 | `max(0, amount - fee - gasQuote)` |
| 運営取分 | `fee` (固定。sponsorship 時は + gas 相当) |

`amount < fee + gasQuote` (gas=merchant) または `amount < fee` (gas=customer) で店主受取が 0 になるため、PaymentForm で送信を block して運営の赤字 + on-chain 失敗を未然防止。Tip widget は preset セマンティクス維持のため `gas=customer` 固定 (creator 受取 = preset - fee、ファン支払 = preset + gas)。

### 料率 (`lib/fee.ts`)
| token | 料率 | MIN_FEE | 備考 |
|---|---|---|---|
| JPYC (Polygon) | 1.0% | 5 JPYC | 純マージン (両 mode 共通) |
| USDC (Base / Arbitrum / Optimism / Polygon) | 1.0% | 0.05 USDC | 純マージン (両 mode 共通) |

### ネットワーク手数料の徴収経路
| paymaster | gas を払う主体 | 経路 | 運営の精算 |
|---|---|---|---|
| ERC20 Paymaster (USDC) | 顧客の USDC | paymaster が postOp で実 gas 分を顧客 USDC から自動徴収 | なし (paymaster が ETH gas 立替・自己精算) |
| Sponsorship (JPYC) | (gas=customer 時) 顧客の JPYC、(gas=merchant 時) 店主が merchant 控除で吸収 | fee transfer に gas 相当 (POL 建て見積 × `NEXT_PUBLIC_POL_JPYC_RATE`) を内包し feeReceiver へ | 運営は徴収した JPYC で Pimlico への POL gas を別途精算 (off-chain) |

旧 `fee=include`/`fee=exclude` URL パラメタは廃止 (parser は silently ignore して古い QR を破壊しない)。新規 QR は `gas=merchant` を明示 (default = customer は URL に出さない)。

### Gas price ceiling (混雑時の安全弁)

`lib/gasCeiling.ts` で UserOp 送信前の `maxFeePerGas` をチェーン別に上限判定し、超過していれば `GasCongestedError` を投げてユーザに「ネットワーク混雑」エラーを返します。**両 paymaster mode で適用** (`useBatchPayment.ts`):

- **Sponsorship mode (JPYC)**: 運営の POL 立替コスト上限保護。極端な spike 時は徴収した JPYC では POL gas を補填しきれない可能性があるため送信前に弾く。
- **ERC20 Paymaster mode (USDC)**: 顧客の USDC 出費の上限保護。Base 1 gwei (既定 ceiling) で gas は約 1.6 USDC、これを超える spike は USDC 換算で高額になるため送信前に弾く。

| チェーン | 既定上限 | env 上書き |
| --- | --- | --- |
| Polygon (137) | 200 gwei | `NEXT_PUBLIC_GAS_CEILING_POLYGON_GWEI` |
| Base (8453) | 1 gwei (L2) | `NEXT_PUBLIC_GAS_CEILING_BASE_GWEI` (testnet fallback 用) |
| Polygon Amoy / Base Sepolia | 1000 gwei (緩) | (testnet 固定) |

運用フェーズでは Sentry の `gas_congested` イベントを監視して再デプロイなしで上限値を調整できる設計。Pimlico Sponsorship Policy 側にも同等以上の上限を設定すること (二重ガード)。

> ⚠️ Base の上限は L2 `maxFeePerGas` のみで判定するため、Ethereum mainnet の L1 spike (200+ gwei) で押し上げられる L1 calldata 費は捕らえられません。L1 監視は今後の拡張ポイント。

## Vercel デプロイ

リポジトリを Vercel にインポートし、上記の環境変数をプロジェクト設定にコピーしてください。  
`next build` がそのまま通る素の Next.js (App Router) 構成のため、追加設定は不要です。

```bash
npm run build && npm run start
```

### Vercel 環境変数のセキュリティ分類

[2026-04 の Vercel セキュリティインシデント](https://vercel.com/kb/bulletin/vercel-april-2026-security-incident) を踏まえ、各 env を以下に従って Dashboard で登録:

| env var | Vercel での分類 | 理由 |
|---|---|---|
| `NEXT_PUBLIC_*` (全て) | **Plain (non-sensitive)** | ビルド時にクライアントバンドルへインライン展開される設計上、元々公開情報。Sensitive にしても保護にならない |
| `SENTRY_AUTH_TOKEN` | **Sensitive (暗号化)** ✓ 必須 | source map upload 権限を持つ。漏洩すると Sentry プロジェクトの source map 改竄リスク。今回のインシデントで Sensitive 化されていない env vars が漏洩対象になったため、本 token は必ず Sensitive で保管 |

### Vercel 運用ハードニング (mainnet 切替前に全て実施)

| 項目 | 実施場所 | 理由 |
|---|---|---|
| アカウントの **MFA 有効化** | Vercel Dashboard → Account Settings → Authentication | 今回の事象は employee の Google アカウント乗っ取りが起点。顧客アカウントの MFA は基本対策 |
| **Spending Cap を $0 に固定** | Vercel Dashboard → Settings → Billing | 限度超過で **デプロイ停止** (請求発生せず)。検証段階は特に重要 |
| **Audit Log 確認** | Vercel Dashboard → Settings → Activity | 不審な Deployment / Settings 変更が無いか定期確認 |
| **Pimlico API Key の Origin 制限** | Pimlico Dashboard | `https://open-pay.jp` (production) + `*.vercel.app` (preview ドメイン群) に限定 |
| **Pimlico Sponsorship Policy ルール** | Pimlico Dashboard | README "Pimlico ダッシュボード設定" 5 項参照 (fee_receiver への transfer 必須化) |
| **Sentry DSN 設定** | Vercel env (Plain) | Replay (10% / エラー時 100%) + 例外取得が自動有効化 |
| **Sentry alert rule 作成** ⚠ コード自動化不可 | Sentry Dashboard → Alerts | 「`payment.failed` が 5%/h を超えたら Slack 通知」「`smart-account.init-failed` が 10 件/h を超えたら通知」「`x402.middleware.error` が 10 件/h を超えたら通知 (facilitator 不通の検出)」など。README §即 rollback トリガー の閾値と整合させる。**この項目は code config では担保できないため deploy 時に人手で確認** |
| **`SENTRY_AUTH_TOKEN` を Sensitive で登録** | Vercel env (Sensitive) ✓ | 上記表参照 |
| **Pimlico 残高 alert 設定** ⚠ コード自動化不可 | Pimlico Dashboard → Alerts | sponsorship policy に紐づく POL / ETH デポジット残高の lower-threshold 通知 (例: 残量 < 1 日想定使用量で Slack)。残高枯渇は UserOp `AA31 paymaster deposit too low` で全送金 fail に直結 |
| **GitHub Secrets の見直し** | GitHub repo → Settings → Secrets | Pimlico 残高 cron / Lighthouse / Playwright 用の secrets は GitHub 側にあり、Vercel インシデントの影響を受けない (= 移行不要) |
| **testnet で先に e2e** | Polygon Amoy / Base Sepolia | NETWORK_ENV=testnet で実 wallet を繋いで `/ja/pay` `/ja/tip` の送金成功を確認してから mainnet に切替 |

## 本番投入前に必ず検証すべきポイント (未検証 / LARP リスク)

本リポジトリは MVP プロトタイプであり、以下の事項は **コード生成時点で実環境検証ができていない**。本番環境にデプロイする前に必ず確認してください。

### 0. テストの mock 比率 (透明化)

本リポジトリの自動テスト (960 件) における mock 利用方針:

| 層 | mock 使用 | 実コード走行範囲 |
|---|---|---|
| `tests/lib/*` (15 ファイル) | **SUT 自身は mock 一切なし** | 全 lib モジュールを実 import で評価 (env / chains / fee / gasCeiling / pimlico / storage / tokens / url / wagmi 等)。`vi.resetModules()` で env の差替えも実 module 再評価。境界 mock は `tests/lib/logger.test.ts` の `@sentry/nextjs` (Sentry SDK の network 送信抑止) と `tests/lib/resolveAddress.test.ts` の RPC client (実 RPC 発火抑止) — どちらも外部 SDK 境界のみで SUT 内部ロジックは実走行 |
| `tests/hooks/*` (6 ファイル中 5 が mock 利用) | wagmi / @tanstack/react-query / permissionless の境界のみ mock | 対象 hook (useBatchPayment / useSmartAccount / useGasQuote* / useQrSettings 等) のロジックは実コード走行。Smart Account 構築の **完全 mock 解除版は無い** (実 wallet + funded sponsorship + ERC-7702 署名が必要なため → §4-1 runbook 参照) |
| `tests/components/*` (9 ファイル中 9 が mock 利用) | wagmi (useAccount / useReadContract 等) と各 hook の境界 mock | コンポーネント描画・分岐ロジック・event handler は実走行。`fake timers + act` で 3 秒 redirect カウントダウンの状態遷移を実観測 |
| `e2e/*` (3 spec) | Playwright で実ブラウザ + dev server 走行 | URL parse / UI 描画は実環境、send は wallet 接続必須なので CI で skip |

実 import 走行率が高い: lib 100%、hook の query/mutation ロジック 100%、コンポーネントの描画/分岐 100%。**mock されているのは外部 SDK の境界 (wallet 接続・実 RPC) のみ**で、本リポジトリのテスト対象自身ではない。

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

### 5. 依存 upgrade 後の `next build` 必須

`npm run typecheck` / `npm run test:run` は SWC compile (tsc) と vitest を回すだけで、**Next.js の production build (`next build`) は走らない**。Next.js は middleware の bundle、route segment 設定、SSR/SSG の prerender などを build 時に解決するため、Next 本体や @sentry/nextjs / middleware 関連の dep を bump した場合は **必ずローカルで `npm run build` を完走させてから commit する**。

```sh
# 例: testnet 必須 env を埋めて build を回す
NEXT_PUBLIC_NETWORK_ENV=testnet \
NEXT_PUBLIC_PIMLICO_API_KEY=dummy \
NEXT_PUBLIC_FEE_RECEIVER_ADDRESS=0x000000000000000000000000000000000000dEaD \
  npm run build
```

CI (`.github/workflows/ci.yml`) でも `npm run build` を実行するため、push 時の safety net はあるが、これは「ローカル検証を省略してよい」という意味ではない。`next start` で middleware (next-intl の locale prefix) の挙動が壊れていないかも、可能なら deploy 前にローカルで 1 度 click test しておくのが望ましい。

### 5.1. middleware / locale prefix の自動 e2e smoke

`e2e/middleware-locale.spec.ts` (15 cases) で **production build (`next start`) に対する実 HTTP** で以下を検証する。Next 本体 / next-intl の patch upgrade 時に `npm run e2e` で回せば runtime regression を catch できる:

- `/` の locale 自動 redirect (`/ja` または `/en` への 30x)
- `/ja` / `/en` が 200 で UI を返す
- 4 legal page × 2 locale = 8 ルートが 200 (静的生成)
- 未知 locale (`/fr`) が 404
- `/manifest.webmanifest` が middleware bypass で 200
- `/api/log/payment` GET → 405、不正 body POST → 400 + `{ok:false, error:"invalid_payload"}`

### 6. 残存 `postcss` MODERATE 脆弱性の判定根拠

`npm audit` で残る `GHSA-qx2v-qp2m-jg93` (PostCSS XSS via Unescaped `</style>`) は **本リポジトリでは到達不能** と判定:

- 本体は `^8.5.14` に上げ済 (修正版)。残る警告は **Next.js 内部の build-time postcss@8.4.31** (`node_modules/next/node_modules/postcss`) に対するもの
- 当該 advisory は **postcss が user-input CSS をパースして再 stringify する** ケースで発火するが、OpenPay の CSS 入力は **すべて author-written** (Tailwind config + `app/globals.css`、ユーザー入力からの CSS 生成経路なし)
- `npm audit fix --force` で next を 16.x に major bump できるが、breaking changes を含むため alpha では見送り。Next.js が自身の bundled postcss を上げた時点で自動解消する見込み

### 4-1. USDC mainnet (ERC20 Paymaster) 投入 runbook

USDC は Base / Arbitrum / Optimism / Polygon の 4 chain で **ERC20 Paymaster mode** を採用し、顧客が USDC で gas を支払う。

> ⚠️ **未検証範囲 (LARP リスク)**:
>
> - `scripts/verify-pimlico-usdc.mjs` で **Pimlico の `getTokenQuotes` が 4 chain × mainnet/testnet の全 8 deployment で valid な quote を返すこと** は確認済み (Universal Paymaster `0x7777777777...e66834C` が有効)
> - **しかし**、Smart Account → bundler → 実 execution → ERC20 Paymaster の `postOp` で実際に USDC が顧客から徴収される **全段の動作** は本リポジトリ内では検証していない (実 wallet + funded USDC + ERC-7702 署名が必要)
> - 既存の Base mainnet 運用の延長で Arbitrum / Optimism / Polygon mainnet を一気に有効化する設計だが、**段階展開を推奨**: Base で実績確認 → Arbitrum (testnet 検証) → Optimism → Polygon の順
> - ERC-7702 (EIP-7702) は Pectra (2025-05) 以降の各 L2 に順次展開された。本番投入前に対象 chain の hard fork 状況を再確認
> - bridged USDC.e は **非対応**。`NEXT_PUBLIC_USDC_<chain>_<env>_ADDRESS` には必ず Circle 公式 native USDC を指定

投入時は以下を **手順通り** 実施すること:

**事前 (deploy 前)**

1. Pimlico Dashboard で Base mainnet の API key に Origin 制限 (`https://open-pay.jp`) を設定
2. Pimlico Dashboard の **Token Paymaster** セクションで Base mainnet + USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` が有効化されているか確認 (Pimlico 側で paymaster 起動が必要な場合あり)
3. **Pimlico プランの rate limit を Dashboard で確認**: 想定同時アクティブ checkout セッション数 × `useGasQuote*` の refetch 頻度 (現状 30s 間隔 → 1 user/120 calls/h) が当該プランの **per-API-key requests/sec** 上限を超えないこと。超える可能性がある場合は `lib/useGasQuoteUsdc.ts` / `useGasQuoteJpyc.ts` の `refetchInterval` を引き上げるか上位プランへ
4. `lib/gasCeiling.ts` の Base 1 gwei ceiling が現在の Base 平常 gas (典型 0.001-0.01 gwei) より十分高いか確認 — `NEXT_PUBLIC_GAS_CEILING_BASE_GWEI` で調整可
5. `NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS` 未設定なら 500_000 が使われる。Pimlico の dashboard 等で実 UserOp 計測ができれば事前に値を埋めておく

**deploy 直後 (最初の 1 件)**

6. `NETWORK_ENV=mainnet` で deploy
7. **運営自身のウォレットで** `/pay?to=<運営テストアドレス>&token=usdc&amount=1.0` を実行 (1 USDC + 運営手数料 0.05 USDC + gas 見積 ≈ 0.05〜2 USDC、最小 USDC 残高 5 USDC 程度推奨)
8. 確認項目:
   - 「ネットワーク手数料 (見積)」行に `最大 X.XX USDC` が表示されること
   - approve トランザクション (paymaster コントラクト宛) が UserOp の calls 先頭に含まれること (BaseScan で内部 tx を確認)
   - 顧客の USDC 残高が `merchant + fee + 実 gas` だけ減っていること (見積より実費が低ければ余剰は引かれない)
   - 運営の Base ETH は **使われていない** (= ETH 立替えゼロが達成されている)

**最初の 24h 監視 (Sentry イベントで)**

| イベント名 | 期待値 | 異常 → アクション |
|---|---|---|
| `payment.gas-quote.failed` | 0 件/h | Pimlico mainnet `pimlico_getTokenQuotes` の 5xx → Pimlico サポート連絡 |
| `payment.failed` (ERC20 mode) | < 1% of attempts | 急増 → `DEFAULT_USEROP_GAS_UNITS` 不足の可能性、`NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS=700000` 等で増やす |
| `gas_congested` | spike 時のみ | 平常時に頻発するなら `NEXT_PUBLIC_GAS_CEILING_BASE_GWEI` を 2 gwei に緩和 |

**即 rollback トリガー**

- `payment.failed` が **5%/h** を超え、エラーメッセージに `paymaster validation failed` / `AA34` / `AA37` (paymaster 関連) が含まれる場合 → Vercel で旧 deploy へ rollback
- 顧客から「USDC が引かれたが merchant が受け取っていない」という報告 (atomic batch なので理論上発生しないが万一)
- `pimlico_getTokenQuotes` が 30 分以上連続で 5xx を返す
- `x402.middleware.error` が **10 件/h** を継続的に超える (facilitator 不通や x402-next の挙動異常)。x402 paid route のみ影響、§rollback の "x402 paid route は安全" に従い rollback 単独可

### 5. split の rounding edge case (UX 上の注意)

`?split=...` で分配 % 合計が高くなると、**主受取人 (`to`) の取り分が極小** になります:

| 入力 | 主受取 % | 100 USDC 時の主受取額 |
|---|---|---|
| `split=B:33,C:33,D:33` | 1% | **1.00 USDC** |
| `split=B:99` | 1% | **1.00 USDC** |
| `split=B:50,C:30` | 20% | 20.00 USDC |

整数除算の端数は主受取人に集約されるため 0 になることはないが、UI 側で `parseSplitDrafts` が合計 100% 以上を reject する。**操作ミスで意図せず大半を split に流してしまう設計リスクがあるため、QrGenerator の split 入力欄は「主受取 = 残り N%」のラベル表示で常に primary share を可視化済み**。

### 6. Basenames (.base.eth) の Universal Resolver [解決済み — 2026-05-14]

旧設計 (`lib/resolveAddress.ts` で Base mainnet 上に Basenames 専用 Universal Resolver があると仮定) は **誤り** だった。Base mainnet の `0xeEeEeEee14D718C2B47D9923Deab1335E144EeEe` には実際には bytecode が存在せず、`.base.eth` 解決は silent fail する状態だった。

修正 (2026-05-14): **mainnet ENS Universal Resolver (`0xeeee…eeee`) が CCIP-Read (ERC-3668) 経由で `.base.eth` も解決する**ことを実証 (`jesse.base.eth` → `0x2211…D77DA9`)。Base 上の Resolver を直接叩く必要はなく、mainnet UR 経由で `.eth` / `.base.eth` を同一 client で resolve する設計に変更済。

検証は `scripts/verify-ens-resolver.mjs` を実 RPC に対して走らせて確認可能 (CI に追加可)。検証項目:

1. `mainnet.contracts.ensUniversalResolver.address` に bytecode 存在
2. `vitalik.eth` が `0xd8dA…6045` に解決
3. `jesse.base.eth` が `0x2211…D77DA9` に CCIP-Read 経由で解決

### 7. CI workflows の初回実行

以下の workflows は設定済だが、**GitHub Secrets / Variables の設定なしには green にならない**。本番投入前に各 secrets を設定 + workflow の手動実行 (workflow_dispatch) で 1 度 green を確認:

- `.github/workflows/lighthouse.yml`: Performance / Accessibility 閾値の通過
- `.github/workflows/e2e.yml`: Playwright (chromium + mobile-safari) でルート遷移
- `.github/workflows/pimlico-balance.yml`: 残高クエリ + webhook 通知 (要 `ALERT_WEBHOOK_URL` etc)

### 8. Tip widget の webhook 配信

`components/TipForm.tsx` の `params.webhook` は tip 送信成功時に POST されるが、**fetch().catch() で silent に握り潰される設計**。理由は「tip 自体は成立しているので UI でエラーを出すと混乱する」。代わりに `logger.warn('tip.webhook.failed', ...)` で記録され、Sentry DSN が設定されていれば自動的に warn として上がる。クリエイター側 webhook の信頼性は **Sentry 経由でのみ観測可能**。

また、Tip webhook はブラウザから送信されるため、payload は顧客側で改ざん可能です。Discord / Slack 通知のような観測用途では許容できますが、限定Discord招待、デジタル特典配布、会員権限付与などの信頼境界には使わないでください。そのような用途では webhook 受信後に `txHash` / `userOpHash` をオンチェーンで再検証し、creator address・token・chain・amount が期待値と一致することを確認してから処理してください。

### 9. EIP-681 互換 QR の実ウォレット読取検証

`lib/eip681.ts` の出力は EIP-681 仕様 (regex / `viem.isAddress` / `URL.canParse`) で構造妥当性を自動検証済だが、**各ウォレットアプリが実際に当該 URI をスキャンして transfer 画面を開けるか**は実機検証が必要。`/ja` の QR ジェネレーターで「直接送金」ON + JPYC + 受取アドレス + 100 を入力 → 画面下部「互換 QR (EIP-681)」セクションの SVG を以下のウォレットでスキャンし、結果を記録する。

| ウォレット | platform | 期待動作 | 確認手順 |
|---|---|---|---|
| MetaMask Mobile | iOS / Android | scan 後、transfer 画面 (受取人 + 金額 prefill) | アプリ内 scan アイコン |
| Rainbow | iOS / Android | 同上 | scan アイコン (画面右上) |
| Trust Wallet | iOS / Android | 同上 (ERC-20 transfer screen) | アプリ内 scanner |
| Coinbase Wallet | iOS / Android | 同上、または "Unsupported" 表示 (EIP-681 サポート状況に依存) | scan アイコン |
| Hashport Wallet | Web (https://wallet.hashport.com) | 同上 (要 EIP-681 対応確認) | Web QR scan UI |

**判定基準**:
- ✅ pass: scan 後に Receiver / Amount / Token (JPYC) が prefill された送金画面が表示
- ⚠ partial: scan は成功するが Token の選択は手動 (URI の `<token_address>` 部分が無視される)
- ❌ fail: "QR cannot be read" / "Unsupported URI" / 何も起きない

実機検証の結果は `docs/eip681-compat.md` に追記して、partial / fail のウォレットがあれば README §特徴 の互換 QR 行に "(○○ 未対応)" の注記を追加する。Polygon Amoy testnet でも同じ手順で検証可能 (`NETWORK_ENV=testnet` の `/ja` で chainId=80002 の URI が出る)。

### 10. axios override (1.16.0) と Coinbase Wallet 互換性

`package.json` の `overrides: { axios: ^1.15.2 }` で `@coinbase/cdp-sdk` (wagmi → @wagmi/connectors → @base-org/account 経由の transitive) が要求する古い axios を **1.16.0 に強制 pin** している (HIGH 脆弱性回避のため)。

**自動 test で担保される範囲** (`tests/lib/axios-override.test.ts`):
- axios が override 後に `>= 1.15.2` で resolve されること
- `@coinbase/cdp-sdk` の module load (top-level `import axios from 'axios'` で throw しない)
- `CdpClient` の constructor 走行 (内部で `axios.create({...})` を呼ぶ経路)
- 公開 sub-client (`evm` / `solana` / `policies` / `endUser` / `webhooks`) が消えていないこと
- `@base-org/account` の module load
- `axios-retry` が axios 1.16 の interceptor API と互換 (cdp-sdk の retry path)

**自動 test で担保されない範囲** (testnet で人手検証必須):
- Coinbase Wallet 接続フロー全体 (passkey → Smart Wallet 生成 → signing → relayer 通信)
- Polygon Amoy / Base Sepolia で Coinbase Wallet を接続 → `/ja/pay` で 1 件以上 USDC 送金成功させる
- 失敗した場合: `package.json` の override を具体的な動作確認済バージョン (例: `1.15.2`) に固定するか、Coinbase Wallet サポートを一時的に外す

upstream (`@coinbase/cdp-sdk`) が axios constraint を緩めた段階で override は撤去予定。Renovate が weekly でチェック。

### 11. Performance / 負荷測定

現状取得済みは **production build 出力の bundle サイズのみ** (`scripts/check-bundle-budget.mjs` で First Load JS の予算チェック)。以下は **未実施**:

| 項目 | 状態 | 必要なケース |
|---|---|---|
| Lighthouse score (mobile) | 未取得 | mainnet 切替前に `lighthouse` CI で performance / a11y / SEO を計測。閾値は `.lighthouserc.json` で設定 |
| 4G エミュレーション下の TTI / LCP | 未測定 | `/[locale]/pay` の First Load JS 381 kB は SPA としては重め。3G/4G で実測すべき |
| 同時アクセス負荷 | 未実施 | 静的 SSG が中心なので Vercel CDN で吸収される想定だが、未検証 |

これらは MVP として deploy 後に実測 → 必要なら `dynamic import` / chunk splitting で改善する。前回 production review で「✅」とした評価は **build 通過 + サイズ予算内 という意味の ✅** であり、実測パフォーマンスは別途検証が必要。

---

## 既知の制約 / 注意

- **ERC-7702 対応ウォレット**: 顧客の EOA は EIP-7702 (`signAuthorization`) 対応ウォレットが必要です。MetaMask v12 系以降の安定版が対応しています。Coinbase Wallet / 一部の WalletConnect ウォレットは未対応の可能性があります
- **JPYC コントラクトアドレス**: `lib/tokens.ts` の既定値は JPYC v3 (`0xE7C3...3c29`、所有者確認済)。将来の移行に備えて本番投入前に [JPYC 公式](https://jpyc.jp/) で最新アドレスを再確認し、必要なら `NEXT_PUBLIC_JPYC_MAINNET_ADDRESS` で上書きしてください
- **testnet の JPYC**: Polygon Amoy には公式の JPYC が存在しないため、テスト時は `NEXT_PUBLIC_JPYC_TESTNET_ADDRESS` で独自にデプロイした ERC20 を指定してください
- **API Key の露出**: `NEXT_PUBLIC_*` はクライアントへ展開されるため、本番では必ず Pimlico ダッシュボード側で Origin 制限を設定してください
- **Sponsorship Policy のレート制御**: スポンサー残高が枯渇すると UserOperation が失敗します。Pimlico ダッシュボードで残高アラートを設定することを推奨します

### 既知の transitive 脆弱性 (`npm audit`)

`npm audit --omit=dev` は production で **2 件 moderate (2026-05-07 時点)** を報告。**HIGH 以上はゼロ** (CI の `--audit-level=high` を pass)。残る moderate はいずれも transitive 依存で本リポジトリの利用パターンでは実害なし:

**root cause は 1 件のみ** (`postcss` XSS)。`npm audit` は次のパッケージ単位で 2 件と報告するが、いずれも同じ advisory を別経路でカウントしているだけ:

| Advisory | Severity | パッケージ | 経路 | 本リポの実害 |
|---|---|---|---|---|
| `postcss <8.5.10` XSS via Unescaped `</style>` (GHSA-qx2v-qp2m-jg93) | moderate | `postcss` | `next` 内部 | **なし** — build 時に処理する CSS は自プロジェクト由来、ユーザ入力を CSS に通さない |
| 上記の伝播 | moderate | `next` (≤16.3.0-canary) | `via: ['postcss']` | **なし** — 同上 |

**HIGH 解消経緯 (2026-05-07)**: `axios <1.15.2` (via `wagmi → @wagmi/connectors → @base-org/account → @coinbase/cdp-sdk`) で SSRF / prototype pollution / auth bypass 等の advisories が moderate → **HIGH に昇格**したため CI を blocking。`package.json` の `overrides` で `axios: ^1.15.2` に強制 pin して解消 (axios 1.x は API 互換、@coinbase/cdp-sdk は単純な GET/POST のみ使用するため互換性問題なし)。upstream (`@coinbase/cdp-sdk`) が axios constraint を緩めた段階で override は撤去予定。

**moderate の修正手段**: `npm audit fix --force` は Next.js v9 へのダウングレードを伴うため非現実的。upstream (next / wagmi) の修正リリース待ち。Renovate が weekly でチェックするので解消され次第 PR が来る。

進行確認 (本番投入前):
```bash
npm audit --omit=dev --audit-level=high  # high 以上ゼロを確認
npm audit --omit=dev | grep -E "^[0-9]+ "  # moderate 件数推移
```

## テスト

[Vitest](https://vitest.dev) + [@testing-library/react](https://testing-library.com/) でユニット / コンポーネントテストを実装しています。

```bash
npm run test         # ウォッチモード
npm run test:run     # 1 回だけ実行 (CI 用)
npm run test:run -- --coverage   # カバレッジ計測 (v8 reporter)
```

### カバレッジ実績 (2026-05-02 時点)

| 指標 | カバレッジ |
|---|---|
| Statements | 98.77% |
| Branches | 96.07% |
| Functions | 91.03% |
| Lines | 98.77% |
| Test count | 960 件 (52 ファイル) + e2e 28 件 |

未カバー部分は主に `QrGenerator` / `TipEmbedGenerator` の inner handler、`useSmartAccount.queryFn` の deep error path、`useGasQuoteUsdc` の 1 hop 内エラー。`vitest.config.ts` で min threshold (statements 95 / branches 93 / functions 88 / lines 95) を強制しており、回帰時は `npm run test:coverage` が失敗する。

### カバー範囲

| 層 | 対象 | テスト方針 |
| --- | --- | --- |
| `lib/fee.ts` | 料率 1.0% / MIN_FEE (5 JPYC / 0.05 USDC) / 境界 (proportional == MIN, amount < MIN) / amount=0 / 大数 | 純粋関数 — 実コードのみ |
| `lib/gasCeiling.ts` | チェーン別 gas 上限 (mainnet/testnet) / 上限境界 / GasCongestedError / env 上書き | 純粋関数 — 実コードのみ |
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
| `components/PaymentForm` | URL parse 各種エラー / breakdown (運営手数料 + gas 見積 別建て) / 接続状態の遷移 / mutate 引数の妥当性 / direct mode | wagmi/Smart Account を境界モック |
| `components/TipForm` | preset 切替 / カスタム入力 / breakdown / submit 引数 / wallet 状態 | wagmi/Smart Account を境界モック |
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

**Playwright e2e (browser smoke) を local で走らせる場合**: `.env.local` に `NEXT_PUBLIC_NETWORK_ENV=mainnet` が入っていると、e2e テストの `'Base Sepolia'` 等 testnet chain name assert と矛盾する。`npm run e2e:local` は testnet 環境変数を front-load してから build + playwright を実行するので、local 開発機の `.env.local` 設定に影響されず安定する (CI は `.github/workflows/e2e.yml` で `NEXT_PUBLIC_NETWORK_ENV: testnet` を明示済)。

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
| 9 | Pimlico API Key の Origin 制限 | Pimlico ダッシュボードで `https://open-pay.jp` (+ preview 用 `*.vercel.app`) に限定 |
| 10 | `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` 設定 | プレースホルダ (`0x...dEaD`) のまま投入しない |
| 11 | testnet で実 e2e (QR スキャン → 送金 → receipt) | Polygon Amoy / Base Sepolia で 1 件以上の成功確認 |
| 12 | Sentry DSN 設定 | `NEXT_PUBLIC_SENTRY_DSN` 設定で自動有効化。SDK は導入済 |
| 13 | Pimlico 残高アラート | ダッシュボードで POL / ETH デポジットの残量しきい値通知を設定 |
| 14 | Vercel ハードニング | 「Vercel デプロイ」セクションのハードニング表 全項 (MFA / Spending Cap / `SENTRY_AUTH_TOKEN` を Sensitive 化 / Origin 制限) |
| 15 | CI workflows 全 green | Lighthouse / Playwright e2e / Pimlico 残高 cron の各 workflow を **手動 (workflow_dispatch) で 1 度実行して green 確認**。Secrets 未設定時は失敗する |
| 16 | Basenames 解決の手動確認 | testnet で `name.base.eth` 形式を入力し、resolved 表示が出るかブラウザで確認 (CREATE2 deterministic な Universal Resolver アドレスの実装在の検証) |
| 17 | Tip widget webhook の到達確認 | Discord/独自 endpoint に dummy tip を 1 度投げ、JSON payload が届くか確認 (失敗は silent、Sentry 経由のみ観測可能) |
| 18 | Vercel Web Analytics の dashboard 側有効化 | `<Analytics />` (`app/[locale]/layout.tsx`) は SDK 側のみ。Vercel ダッシュボードの Web Analytics タブで本番プロジェクトの Analytics を **手動で ON にしないとイベントは記録されない**。デプロイ後、初回 pageview がダッシュボードに到達することを目視確認 |

### Go/No-Go 判断: 証拠ベース確認 (本番投入直前に手元で実行)

下記のコマンドを順に走らせ、すべての出力が期待ラインと一致した時のみ Go。

```bash
# 1. 全テスト実行 (real code paths)
npm run test:run
# 期待: "Tests N passed (N)" / 失敗ゼロ

# 2. typecheck
npm run typecheck
# 期待: 標準出力に何も出ず exit 0 (tsc --noEmit が静かに pass)

# 3. 本番ビルド
NEXT_PUBLIC_NETWORK_ENV=testnet \
  NEXT_PUBLIC_PIMLICO_API_KEY=dummy \
  NEXT_PUBLIC_FEE_RECEIVER_ADDRESS=0x000000000000000000000000000000000000dEaD \
  npm run build
# 期待: "✓ Compiled successfully" + Route table が表示

# 4. Production 依存の脆弱性 (high 以上はゼロ)
npm audit --audit-level=high --omit=dev
# 期待: "found 0 vulnerabilities" もしくは high/critical を含まない

# 5. Bundle First Load 予算内 (回帰検出)
npm run build 2>&1 | node scripts/check-bundle-budget.mjs
# 期待 (回帰なし、exit 0):
#   [OK] /[locale]              X kB / 予算 320 kB
#   [OK] /[locale]/pay          X kB / 予算 420 kB
#   [OK] /[locale]/tip/[address] X kB / 予算 420 kB
#   [OK] __shared__             X kB / 予算 250 kB
#   OK: 全ルートが予算内
# 予算超過時は exit 1 (CI でも自動 fail)

# 6. git ワーキングツリーがクリーン
git status --short
# 期待: 出力ゼロ (uncommitted な変更なし)

# 7. main ブランチが origin と同期
git status -b --short | head -1
# 期待: "## main...origin/main" のみ (ahead/behind 表示なし)
```

### Bundle 予算の根拠

| ルート | First Load | 主要因 | 許容根拠 |
|---|---|---|---|
| `/[locale]` | 278 kB | React + Next.js + i18n + wagmi config + Sentry Replay | 4G で TTI 約 2 秒、許容 |
| `/[locale]/pay` | 372 kB | + viem + wagmi connectors (Coinbase Wallet SDK) + permissionless | 顧客 wallet 接続用途、初回のみで以降 PWA キャッシュされる |
| `/[locale]/tip/[address]` | 369 kB | 同上 (TipForm が wagmi を使用するため) | 同上、iframe 埋め込み時は初回のみ |
| `/_not-found` | 223 kB | shared chunks のみ | エラー画面、最小 |

これ以上の削減には wagmi connector lazy load (Coinbase SDK の dynamic import) が必要。現状は wagmi v2 の構造制約で困難。Renovate が wagmi v3+ への追従 PR を出した時点で再評価。

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
店主の QR / Tip / Checkout 設定 (`openpay:qr-settings:v2`, `openpay:tip-settings:v2`, `openpay:checkout-settings:v1`) はキー名にバージョン suffix を含むため、
スキーマ変更時はキーをインクリメントすればロールバック後も旧クライアントが破損しない。

### ⚠️ multi-chain URL 後の rollback は silent fund misdirection の risk あり

Phase 1 で **USDC を Base / Arbitrum / Optimism / Polygon の 4 chain に拡張**したため、生成 URL に `chain=arbitrum` 等が含まれるようになった。**この拡張版を本番投入し、`chain=arbitrum/optimism/polygon` の URL が出回った後で multi-chain 前のバージョンへ rollback すると、旧 parser は未知の `chain` パラメタを silent ignore して USDC=Base の旧 default で処理してしまう**。結果、顧客が **意図と異なるチェーン (Base) に送金** する事故が起こり得る。

**安全な rollback 方針**:
- Phase 1 multi-chain commit (`feat(usdc): マルチ EVM チェーン対応`) **以前への rollback は禁止**
- どうしても切り戻す必要がある場合: (a) CDN / Vercel の rewrite で `/pay?...&chain=arbitrum*` を 410 Gone に返す、(b) マーチャントへ「該当 URL の無効化」を即時通知、の手順を経てから旧バージョンへ revert
- 同じ問題は Checkout 機能 (`/checkout` ルート) にも該当 — `/checkout` 自体が新ルートのため、切り戻すとルート 404 になり silent ではないが、`/pay` の chain パラメタは silent

### EIP-681 互換 QR の rollback は安全 (silent fund misdirection リスク無し)

EIP-681 互換 QR (`feat(qr): EIP-681 互換 QR セクションを QrGenerator に併発行で追加`) は、生成された URI が [EIP-681 仕様](https://eips.ethereum.org/EIPS/eip-681) 準拠の self-contained format (`ethereum:<token>@<chainId>/transfer?...`) のため、**OpenPay の UI を rollback しても既出 QR は他の EIP-681 対応ウォレットで引き続き正しく読み取れる**。multi-chain URL のような silent fund misdirection は構造的に発生しない (token / chainId / receiver / wei が URI 内に確定値として焼き込まれているため、parser の差異で別 chain に送金される経路が無い)。

### x402 paid route (`/api/paid/*`) の rollback は安全

x402 機能 (`feat(x402): add Open Checkout for AI Agents`) は **完全に additive**:

- 既存 route / middleware を改変せず、新規 `/api/paid/*` のみ追加
- 各 paid call は **stateless / one-shot** で永続データを残さない (EIP-3009 nonce は token contract が管理、OpenPay 側に DB なし)
- rollback すると `/api/paid/*` が 404 になるだけ。既出の `/pay` QR や Tip widget URL には影響なし
- 進行中の x402 取引はあり得ない (synchronous、決済成立後即 content delivery)
- silent fund misdirection の構造的可能性なし (paid call は `payTo` env で固定、URL に焼き込まれていない)

→ 任意のタイミングで rollback 可。

### ERC20 Paymaster の approve allowance (USDC mainnet 限定)

USDC mainnet では `prepareUserOperationForErc20Paymaster` が UserOp 先頭に **paymaster コントラクト宛の USDC `approve`** を自動注入する。これは onchain state なのでフロントエンド rollback では消えない:

- **同一 paymaster に rollback** → 既存 allowance がそのまま再利用される (害なし、むしろ approve 1 件分の gas が節約)
- **Pimlico が paymaster コントラクトをアップグレード (アドレス変更)** → 旧 allowance は新 paymaster からは使えず deadlock しないが、ユーザの wallet には未使用 allowance が残る。残存攻撃面ではあるが、Pimlico の paymaster は標準的に minimal trust (transferFrom のみ呼び出す) 設計
- **ユーザに revoke を促したい場合**: Etherscan/BaseScan の token approval 画面 (例: `https://basescan.org/tokenapprovalchecker?search=<user_addr>`) を案内 — フロント側に revoke ボタンは未実装 (v1 candidate)

paymaster コントラクトアドレスは `pimlico_getTokenQuotes` の `paymaster` フィールドで取得される動的値。`hooks/useGasQuoteUsdc.ts` 経由で確認可能だが、**Pimlico 側のアップグレード履歴を独自に追跡する仕組みは無い**。Pimlico の releases / status page を運用フェーズで watch する必要がある。

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

## ロードマップ (v0 out-of-scope、v1 候補)

下記 2 機能は v0 (現バージョン) では明示的に **out of scope**。実装着手は需要シグナルが見えてから判断する。perpetual TODO 化 (永遠の "やる予定") を避けるため、ここに固定:

### B4: サポーターウォール (creator 向け)

**ねらい**: Tip widget の下部に「最近のサポーター (短縮アドレス + 金額)」を opt-in で表示し、社会的証明 + 競争心理で支援を増やす。

**未実装の理由**:
- Polygon / Base の過去 transfer を全件 RPC スキャンするのは重い (1 受取人あたり数千ブロック分の getLogs)
- Etherscan / Basescan の event API + LRU キャッシュ層が現実解だが、API key 管理 + 30 日 retention 設計が必要
- creator 側に opt-in / opt-out の管理画面が必要 (現状 OpenPay は管理画面ゼロ、URL 1 本で運用)

**着手判断**: 5 件以上のクリエイターから「サポーターを表示したい」要望が出たら設計開始。それまでは v0 のまま。

### B5: AI Agent 向け JPYC x402 facilitator

**ねらい**: Coinbase x402 仕様 (HTTP 402 + USDC 自動決済) を JPYC で提供。AI agent / API provider が JPYC で従量課金できる空白地帯を狙う。

**未実装の理由**:
- 5〜10 日工数の独立 feature (新規 endpoint / facilitator service / OpenPay 既存基盤との接続)
- x402 自体の market demand が薄い ([CoinDesk 2026/03 レポート](https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet) — 1 日 $28K のみ、大半が test トランザクション)
- 競合は Coinbase 公式 facilitator (USDC のみ)、JPYC 対応は本リポジトリが先発できる立場

**着手判断**: 日本語圏で「AI agent から JPYC 課金したい」具体ユースケースが 1 件でも出てきたら着手。current state では speculative すぎる。

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

## セキュリティ — `npm audit` の moderate findings 評価

`npm audit --omit=dev` で **12 件の moderate severity** が報告される (2026-04 時点)。すべて transitive 依存 (`@metamask/sdk → @wagmi/connectors → @gemini-wallet/core` 経由) であり、`npm audit fix --force` は Next.js 15→9.3.3 / wagmi メジャーバージョン downgrade を要求するため **破壊的修正は不可**。各 finding の本 dApp における exposure 評価:

| CVE / GHSA | パッケージ | exposure 評価 |
|---|---|---|
| GHSA-3p68-rc4w-qgx5 / GHSA-fvcv-3m26-pcqx | axios (SSRF / Cloud Metadata Exfiltration via Header Injection) | 攻撃には axios で **任意 URL に request** を投げるサーバ環境が必要。本 dApp は client-side only で、axios は `@metamask/sdk-communication-layer` の MetaMask Mobile relay 通信で内部使用されるのみ。ユーザ入力が axios の URL に直接 flow しない。**本番 exposure: 軽微** |
| GHSA-qx2v-qp2m-jg93 | postcss (XSS via `</style>`) | postcss は **build-time のみ** 使用。production runtime には含まれない。**本番 exposure: なし** |
| GHSA-w5hq-g745-h8pq | uuid v3/v5/v6 buffer bounds | 内部 ID 生成のみで使用。ユーザ入力が buffer 引数に flow しない。**本番 exposure: なし** |

**追跡方針**: `@wagmi/connectors` のメジャー更新で transitive が解消する見込み。月次 `npm audit` で再評価し、各 finding が exploit 可能になった場合は即時パッチ適用 (force update を含めて検討)。

## ライセンス

MIT — 商用・改変・再配布いずれも自由。詳細は LICENSE ファイル参照。

Made with ☕ by [cipherwebllc](https://github.com/cipherwebllc) — お問い合わせ・PR は GitHub Issues / PR でお気軽に。
