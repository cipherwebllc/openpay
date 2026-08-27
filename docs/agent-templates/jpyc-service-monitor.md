# JPYC Service Monitor — 定期実行テンプレート / Scheduled-Job Template

外部 AI エージェントの**週次ジョブ**に組み込む前提で設計された、日本の JPYC/Web3 サービスの変更フィードです。
A weekly change feed for Japan-related JPYC/Web3 services, designed to be wired into an AI agent's recurring job.

- 追加・変更・終了・再確認を **日付 + changeType + 一次ソース URL** つきイベントで返します
- `changedSince=<前回実行日>` を渡すと**差分だけ**を返し、`changes: []` が「重要な変更なし」を明示します(エージェントが推測なしで報告できる)
- 実購入で検証済み: 同一 payer による snapshot → delta の 2 周を Base mainnet の実 settle で確認
  (tx `0xf62b736e…7833` / `0x3577035c…ac88`)

## 目的と想定利用者 / Purpose

| | |
|---|---|
| 想定利用者 | JPYC・日本の Web3 動向を業務で追う AI エージェント運用者(リサーチ・事業開発・決済導入検討) |
| 実行頻度 | **週 1 回**(それ以上の頻度は差分が空になるだけで課金が無駄) |
| 支払い上限の目安 | 1 回 3 JPYC(JPYC 版・手数料込)/ $0.01(USDC 版)・月あたり約 12〜15 JPYC / $0.05 |

## エンドポイント / Endpoints

| レール | URL | 価格 |
|---|---|---|
| JPYC (Polygon・OpenPay facilitator) | `GET https://open-pay.jp/api/paid/jpyc/services?changedSince=YYYY-MM-DD` | 2 JPYC + x402 手数料(買い手計 3 JPYC) |
| USDC (Base・標準 x402・手数料なし) | `GET https://open-pay.jp/api/paid/usdc/jpyc/services?changedSince=YYYY-MM-DD` | $0.01 |

- `changedSince` は **YYYY-MM-DD・その日を含む**。省略すると全件スナップショット(`mode: "snapshot"`)
- 重複排除キーは `slug + date + changeType`
- OpenAPI(機械可読・`x-agent-usage` つき): `https://open-pay.jp/api/openapi.json`(operationId: `getJpycServiceMonitor` / `getJpycServiceMonitorUsdc`)
- 外部カタログ: [x402 Bazaar / agentic.market](https://agentic.market/services/open-pay-jp) に掲載(USDC 面)

## コピー用プロンプト / Copy-paste prompt

**日本語:**

> 毎週月曜 9 時に JPYC Service Monitor を実行してください。
> `https://open-pay.jp/api/paid/jpyc/services?changedSince=<前回実行日 YYYY-MM-DD>` を x402 で購入し(1 回の支払い上限 3 JPYC)、`changes` を日本語で要約してください。
> `changes` が空なら「重要な変更なし」とだけ報告してください。
> 変更がある場合は changeType・事業者名・変更内容・sourceUrl を表にし、判断に使う前に sourceUrl で裏取りしてください。

**English:**

> Every Monday at 09:00, run the JPYC Service Monitor.
> Buy `https://open-pay.jp/api/paid/usdc/jpyc/services?changedSince=<last run date YYYY-MM-DD>` via x402 (spend cap $0.01 per run) and summarize `changes`.
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
      "sourceUrl": "https://prtimes.jp/main/html/rd/p/000000315.000054018.html"
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

## 注意 / Notes

- イベントは公式ソースの記載を要約した**事実**であり、可用性の保証や推奨ではありません。判断に使う前に各 `sourceUrl` で裏取りしてください
- `sourceOk` はソース URL の到達性のみを示し、情報の真偽を示しません
- 支払いは取消不能です。上限(MAX)は必ずクライアント側でも設定してください
- 利用規約: https://open-pay.jp/ja/terms(英語版 /en/terms)
