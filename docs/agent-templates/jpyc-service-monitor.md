# JPYC Service Monitor — 定期実行テンプレート / Scheduled-Job Template

外部 AI エージェントの**週次ジョブ**に組み込む前提で設計された、日本の JPYC/Web3 サービスの変更フィードです。
A weekly change feed for Japan-related JPYC/Web3 services, designed to be wired into an AI agent's recurring job.

- 追加・変更・終了・再確認を **日付 + changeType + 一次ソース URL** つきイベントで返します
- `changedSince=<前回実行日>` を渡すと**差分だけ**を返し、`changes: []` が「重要な変更なし」を明示します(エージェントが推測なしで報告できる)
- 実購入で検証済み: 同一 payer による snapshot → delta の 2 周を Base mainnet の実 settle で確認
  (tx `0xf62b736e…7833` / `0x3577035c…ac88`)
- 姉妹商品: 決済事業者に特化した [Japan Stablecoin Payment Monitor](#japan-stablecoin-payment-monitor)(本ページ後半)— 同じ週次収集・共通 changelog から生成される別ビューです

## 目的と想定利用者 / Purpose

| | |
|---|---|
| 想定利用者 | JPYC・日本の Web3 動向を業務で追う AI エージェント運用者(リサーチ・事業開発・決済導入検討) |
| 実行頻度 | **週 1 回**(それ以上の頻度は差分が空になるだけで課金が無駄) |
| 支払い上限の目安 | 1 回 3 JPYC(JPYC 版・手数料込)/ $0.01(USDC 版)・月あたり最大 12〜15 JPYC / $0.05(teaser で事前確認すれば変更のあった週のみ) |

## エンドポイント / Endpoints

| レール | URL | 価格 |
|---|---|---|
| JPYC (Polygon・OpenPay facilitator) | `GET https://open-pay.jp/api/paid/jpyc/services?changedSince=YYYY-MM-DD` | 2 JPYC + x402 手数料(買い手計 3 JPYC) |
| USDC (Base・標準 x402・手数料なし) | `GET https://open-pay.jp/api/paid/usdc/jpyc/services?changedSince=YYYY-MM-DD` | $0.01 |

- `changedSince` は **YYYY-MM-DD・その日を含む**。省略すると全件スナップショット(`mode: "snapshot"`)。**応答の `nextChangedSince` をそのまま次回に渡すのが正**(取りこぼしなし)
- **無料 teaser(購入前に実データを確認・支払い不要)**: `GET /api/jpyc/services/teaser` / `GET /api/stablecoin-payments/teaser`(直近 3 イベント)
- **買う前に確かめる(空振り課金ゼロ)**: teaser の最終イベント日が手元の `nextChangedSince` より**前(古い)なら**その週は買わない(有料 delta は空になる)。同日以降のイベントがあるときだけ有料 delta を購入する — 「変更なし」に支払う週が無くなります
- **変更は値でも返ります**: 一次ソースが前後の値を明示する場合、`diffs: [{ field, previousValue, currentValue, effectiveAt? }]`(field は assets / chains / fee / limit / status / feature の固定語彙)が付きます。推測では埋めません(無い場合は summary のみ)
- 重複排除キーは `slug + date + changeType`
- OpenAPI(機械可読・`x-agent-usage` つき): `https://open-pay.jp/api/openapi.json`(operationId: `getJpycServiceMonitor` / `getJpycServiceMonitorUsdc`)
- 外部カタログ: [x402 Bazaar / agentic.market](https://agentic.market/services/open-pay-jp) に掲載(USDC 面)

## コピー用プロンプト / Copy-paste prompt

**日本語:**

> 毎週月曜 9 時に JPYC Service Monitor を実行してください。
> まず無料の `https://open-pay.jp/api/jpyc/services/teaser` を取得し、`latestChanges` の最終日付が保存済みの `nextChangedSince` より前(古い)なら「重要な変更なし」と報告して終了してください(購入しない・有料 delta は空になります)。
> その日以降のイベントがある場合のみ `https://open-pay.jp/api/paid/jpyc/services?changedSince=<前回応答の nextChangedSince>` を x402 で購入し(1 回の支払い上限 3 JPYC)、`changes` を日本語で要約してください。応答の `nextChangedSince` を保存し、次回はその値をそのまま渡してください(初回は changedSince なしで可)。
> `changes` が空なら「重要な変更なし」とだけ報告してください。
> 変更がある場合は changeType・事業者名・変更内容・sourceUrl を表にし、判断に使う前に sourceUrl で裏取りしてください。

**English:**

> Every Monday at 09:00, run the JPYC Service Monitor.
> First GET the free `https://open-pay.jp/api/jpyc/services/teaser`; if the latest date in `latestChanges` is before your stored `nextChangedSince`, report "no significant change" and stop (do not buy — the paid delta would be empty).
> Only if it is on or after that date, buy `https://open-pay.jp/api/paid/usdc/jpyc/services?changedSince=<nextChangedSince from your previous response>` via x402 (spend cap $0.01 per run) and summarize `changes`. Store the response's `nextChangedSince` and echo it next run (first run: omit changedSince).
> If `changes` is empty, report exactly "no significant change".
> Otherwise, tabulate changeType, service name, what changed, and sourceUrl — verify against the sourceUrl before acting on any change.

## OpenPay MCP 設定例(JPYC 版・金銭ガードつき)

```json
{
  "mcpServers": {
    "openpay-x402": {
      "command": "npx",
      "args": ["-y", "openpay-x402-mcp"],
      "env": { "BUYER_PRIVATE_KEY": "0x..." }
    }
  }
}
```

MCP の `x402_pay` ツールに上記 URL を渡すだけで、402 チャレンジの検証・JPYC 署名・支払い上限ガードまで自動で行われます。鍵には少額(数十 JPYC)だけ入れた専用ウォレットを使ってください。

## スクリプト例(鍵は env で渡す・ファイルに書かない)

JPYC 版(Polygon・ガス不要):

```bash
curl -fsSL https://raw.githubusercontent.com/cipherwebllc/openpay/main/scripts/x402-buyer-example.mjs -o buyer.mjs
BUYER_PRIVATE_KEY=0x... \
  RESOURCE_URL="https://open-pay.jp/api/paid/jpyc/services?changedSince=2026-08-27" \
  node buyer.mjs
```

USDC 版(Base・ガス不要・要 `npm i x402-fetch viem`):

```bash
curl -fsSL https://raw.githubusercontent.com/cipherwebllc/openpay/main/scripts/x402-vanilla-buyer-smoke.mjs -o buyer-usdc.mjs
PRIVATE_KEY=0x... MAX_USDC=0.02 \
  TARGET_URL="https://open-pay.jp/api/paid/usdc/jpyc/services?changedSince=2026-08-27" \
  node buyer-usdc.mjs
```

Claude Code なら `/schedule`(cron)や Hermes Agent の定期ジョブに上のプロンプトを渡すだけで常設できます。ElizaOS / Strands 等でも「週 1 で URL を x402 購入 → JSON の `changes` を要約」という同じ形で組み込めます。

## サンプルレスポンス(実応答の抜粋・mode=delta)

```json
{
  "schemaVersion": "1.0",
  "mode": "delta",
  "query": { "changedSince": "2026-08-27", "limit": 200 },
  "changes": [
    {
      "date": "2026-08-27",
      "slug": "jpyc-ex",
      "changeType": "updated",
      "summary": "JPYC EX added Kaia support (issuance, redemption, wallet-address registration) and changed the issuance cap from 1M JPY per day to 1M JPY per transaction.",
      "summaryJa": "JPYC EX が Kaia に対応 (発行・償還・アドレス登録)。発行上限を「1日100万円」から「1回100万円」へ変更。",
      "sourceUrl": "https://prtimes.jp/main/html/rd/p/000000315.000054018.html",
      "diffs": [
        { "field": "chains", "previousValue": ["avalanche", "ethereum", "polygon"], "currentValue": ["avalanche", "ethereum", "polygon", "kaia"] },
        { "field": "limit", "previousValue": "1,000,000 JPY per day (issuance)", "currentValue": "1,000,000 JPY per transaction (issuance)" }
      ]
    }
  ],
  "services": [
    {
      "slug": "jpyc-ex",
      "name": "JPYC EX",
      "status": "published",
      "supportsJpyc": true,
      "chains": ["avalanche", "ethereum", "kaia", "polygon"],
      "verifiedAt": "2026-08-27"
    }
  ],
  "totalServices": 20,
  "notice": { "code": "sourced-facts-only" }
}
```

## Japan Stablecoin Payment Monitor

同じ週次収集・共通 changelog から生成される 2 本目のモニターです。**完了する仕事が異なります** — Service Monitor が「JPYC 関連サービス全体の変更を知る」のに対し、こちらは「**日本のステーブルコイン決済事業者・手数料・対応レールを監視する**」ためのフィードです。
A second monitor generated from the same weekly collection: it completes a different job — watching Japan's stablecoin **payment providers** (launches, pilots, partnerships, fee changes, supported assets/chains, closures).

- イベントは `provider` 中心で、`changeCategory`(service_launch / pilot / partnership / fee_change / assets_change / chains_change / closure)と `assets` / `chains` が付きます
- ディレクトリに載らない業界イベント(実証実験・提携)も対象です(例: JCB×Circle MOU、DG・JCB・りそなの実店舗実証)
- 履歴は 2025 年 11 月まで遡って収録済み。実購入検証済み(settle tx `0xef1f0969…546b`)

### エンドポイント / Endpoints

| レール | URL | 価格 |
|---|---|---|
| JPYC (Polygon) | `GET https://open-pay.jp/api/paid/stablecoin-payments?changedSince=YYYY-MM-DD` | 2 JPYC + x402 手数料(買い手計 3 JPYC) |
| USDC (Base・手数料なし) | `GET https://open-pay.jp/api/paid/usdc/stablecoin-payments?changedSince=YYYY-MM-DD` | $0.01 |

`changedSince` の意味・`changes: []` = 「重要な変更なし」・推奨頻度(週 1)・支払い上限・MCP/スクリプトの使い方は Service Monitor と同一です(URL を差し替えるだけ)。OpenAPI operationId: `getStablecoinPaymentMonitor` / `getStablecoinPaymentMonitorUsdc`。

### コピー用プロンプト / Copy-paste prompt

**日本語:**

> 毎週月曜 9 時に Japan Stablecoin Payment Monitor を実行してください。
> まず無料の `https://open-pay.jp/api/stablecoin-payments/teaser` を取得し、`latestChanges` の最終日付が保存済みの `nextChangedSince` より前(古い)なら「重要な変更なし」と報告して終了してください(購入しない・有料 delta は空になります)。
> その日以降のイベントがある場合のみ `https://open-pay.jp/api/paid/stablecoin-payments?changedSince=<前回応答の nextChangedSince>` を x402 で購入し(1 回の支払い上限 3 JPYC)、`changes` を日本語で要約してください。応答の `nextChangedSince` を保存し、次回はその値をそのまま渡してください(初回は changedSince なしで可)。
> `changes` が空なら「重要な変更なし」とだけ報告してください。
> 変更がある場合は provider・changeCategory・対象資産/チェーン・変更内容・sourceUrl を表にし、判断に使う前に sourceUrl で裏取りしてください。

**English:**

> Every Monday at 09:00, run the Japan Stablecoin Payment Monitor.
> First GET the free `https://open-pay.jp/api/stablecoin-payments/teaser`; if the latest date in `latestChanges` is before your stored `nextChangedSince`, report "no significant change" and stop (do not buy — the paid delta would be empty).
> Only if it is on or after that date, buy `https://open-pay.jp/api/paid/usdc/stablecoin-payments?changedSince=<nextChangedSince from your previous response>` via x402 (spend cap $0.01 per run) and summarize `changes`. Store the response's `nextChangedSince` and echo it next run (first run: omit changedSince).
> If `changes` is empty, report exactly "no significant change".
> Otherwise, tabulate provider, changeCategory, assets/chains, what changed, and sourceUrl — verify against the sourceUrl before acting on any change.

### サンプルレスポンス(実応答の抜粋・mode=snapshot)

```json
{
  "schemaVersion": "1.0",
  "mode": "snapshot",
  "changes": [
    {
      "date": "2026-08-10",
      "provider": "DG Stablecoin Payment Service",
      "changeType": "added",
      "changeCategory": "service_launch",
      "assets": ["USDC"],
      "chains": ["base"],
      "summary": "Digital Garage started commercial rollout of DG Stablecoin Payment Service (API-based merchant integration; initially USDC on Base, first offered to JCB and DGFT).",
      "summaryJa": "デジタルガレージが DG Stablecoin Payment Service の商用展開を開始 (API 接続の加盟店向け・当初は Base 上の USDC・JCB/DGFT へ先行提供)。",
      "sourceUrl": "https://www.garage.co.jp/pr/release/20260810/",
      "diffs": [{ "field": "status", "previousValue": null, "currentValue": "commercial" }]
    }
  ],
  "totalEvents": 7,
  "notice": { "code": "sourced-facts-only" }
}
```

## 注意 / Notes

- イベントは公式ソースの記載を要約した**事実**であり、可用性の保証や推奨ではありません。判断に使う前に各 `sourceUrl` で裏取りしてください
- `sourceOk` はソース URL の到達性のみを示し、情報の真偽を示しません
- 支払いは取消不能です。上限(MAX)は必ずクライアント側でも設定してください
- **プロンプトに書いた上限指示は防御になりません**(エージェントは承認文言を捏造し得ます)。上限は本テンプレのようにスクリプト/SDK の引数と**少額専用ウォレットの残高**で技術的に効かせてください
- 利用規約: https://open-pay.jp/ja/terms(英語版 /en/terms)
