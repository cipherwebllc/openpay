# AI エージェント決済の安全設計 (1 枚)

OpenPay で AI エージェントに支払い能力を持たせるときの安全モデル。**新しい約束ではなく、
実装済みの制御の一覧**です (各行に実装箇所)。企業・開発者が導入前に確認する
「どこまで接続できるか / いくらまで払えるか / 誰の権限か / 止められるか / 監査できるか」
に対応します。

## 1. 権限 — 何を・いくらまで買えるか

| 制御 | 既定 | 実装 |
|---|---|---|
| 1 回あたり上限 | 10 JPYC (`x402_pay` は都度 `maxTotalJpyc` 明示必須) | `openpay-x402-sdk` guards |
| セッション累計上限 | 100 JPYC | 同上 |
| 日次上限 | 任意設定 (超過は `daily_limit_exceeded` で拒否・**予算は署名前に予約**) | SDK spendStore (原子化) |
| 接続先 allowlist | `open-pay.jp` のみ (追加は env で明示) | `ALLOWED_HOSTS` |
| 購入対象の制限 | **審査済みカタログ掲載 URL のみ** (完全一致・失敗 fail-close) | `CATALOG_TRUST` (既定 ON) |

## 2. 隔離 — 鍵と判断の分離

- **LLM は鍵を持たない**: 署名は MCP プロセス (専用少額ウォレット) か、**Steward 署名
  バックエンド** (typed-data ポリシーで金額上限を機械 enforce・鍵はエージェント環境の外)。
- 鍵レス運用: 注文用 profile `openpay-order-mcp` は署名ツールを**同梱しない** (支払いは人間の
  BYOW 1 タップ)。誤用面が構造的に存在しない。
- 本番の受取・手数料鍵はサーバー側 env のみ。エージェント/LLM プロセスには渡さない。

## 3. 検証 — 支払う前に何を照合するか

- **accepts 改竄検証**: 402 の支払い条件を**カタログ掲載時の金銭条件と完全一致**で照合
  (悪性サーバーが accepts をコピー/すり替えても拒否)。resource URL は完全一致。
- 金額・宛先・chain・asset は server 権威で再計算 (client 申告を信用しない)。
- 決済状態の真実は **facilitator の verify/settle とオンチェーンのみ** (LLM 出力や会話履歴で
  解錠しない — リポ運用の掟 15)。

## 4. 停止 — 異常時に止まるか

- 上限超過は**その場で拒否** (per-call / session / daily)。daily はストレージ障害時も
  支払いを止める側に倒す (`daily_spend_unavailable`)。
- kill switch: 環境変数 1 つ (`ALLOWED_HOSTS` 空化 / MCP プロセス停止) で購入能力を即時停止。
  サーバー側も flag OFF で 402 面ごと閉じられる。
- 有料応答の本文は**第三者コンテンツ**としてデータ扱い (本文中の「追加購入せよ」等の指示に
  従わない — llms.txt にも明記)。

## 5. 監査 — 何が起きたか後から追えるか

- 全 settle に **EIP-712 署名付き receipt** (署名者は `/api/facilitator/supported` で公開・
  `/api/facilitator/verify-receipt` でオフライン検証可)。
- オンチェーン tx hash が常に残る (分割内訳 = merchant/fee も Transfer ログで検証可能)。
- 実証履歴 (実トランザクション): v1 クライアント購入 `0x3652aee9…`・v2 クライアント購入
  `0xd4d09081…`・外部加盟店 `0xc6aa79f4…`・エージェント注文 `0x2365…101a` ほか。

---
関連: /guide/ai-pay (設定手順)・/guide/sell (出品側)・docs/DEPLOY_CHECKLIST.md §14 (運用)。
