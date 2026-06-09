# npm audit triage (依存脆弱性の受容判断)

最終更新: 2026-06-09 / 監査コマンド: `npm audit`

## サマリ

`npm audit fix`（**非破壊のみ**・`--force` は実行しない）を適用後の状態:

| severity | 件数 |
|---|---|
| critical | 1 |
| high | 0 |
| moderate | 22 |
| low | 13 |
| **total** | **36** |

**結論: 36 件すべて transitive（推移）依存であり、OpenPay 自身のサーバ実行経路に
exploit 可能な脆弱性は無い。** 内訳は (a) dev/build/test ツール、(b) ウォレット接続系の
推移依存（クライアント側・上流が修正主体）、(c) 未使用の推移依存（Solana）に分類される。
いずれも修正には上流パッケージのメジャー更新（破壊的）が必要で、`npm audit fix --force`
はウォレット接続・ビルドを壊すため**意図的に実行しない**。受容し、定期再監査＋上流が
非破壊修正を出した時点で追従する。

`npm audit fix`（非破壊）は適用済み（37→36・package-lock.json のみ変更・全 3962 test green）。

## triage（分類と受容理由）

### A. dev / build / test ツール — 本番ランタイムに載らない

| パッケージ | sev | 依存経路 | 受容理由 |
|---|---|---|---|
| vitest | **critical** | 直 devDependency | テストランナー。脆弱性は「Vitest UI サーバ起動時に任意ファイル読取/実行」。`vitest --ui` を**起動・公開しない**限り無害。CI/本番に載らない。修正=vitest メジャー更新（破壊的）→上流安定後に追従。緩和: UI モードを使わない / ポート非公開。 |
| esbuild | moderate | @vitejs/plugin-react → vite | 開発サーバの CORS 問題。dev 専用・本番ビルド成果物には影響しない。 |
| vite / vite-node | moderate | @vitejs/plugin-react（テスト） | 同上（dev/test 専用）。 |
| postcss | moderate | vite / autoprefixer | CSS stringify の XSS。**ビルド時**に自前 CSS を処理するのみで、攻撃者制御の CSS を実行時に処理しない。実リスク低。 |
| next | moderate | 直依存（経由 postcss） | 上記 postcss を間接参照。next 自体の実行時脆弱性ではない。 |

### B. ウォレット接続系の推移依存 — クライアント側・上流が修正主体

| パッケージ | sev | 依存経路 | 受容理由 |
|---|---|---|---|
| @metamask/utils / abi-utils / rpc-errors | moderate | wagmi → @wagmi/connectors → @metamask/sdk | 根本は `uuid` の buffer 境界 + rpc-errors。ウォレット接続時にクライアントで動作。非カストディなので資産は利用者ウォレット側。上流（MetaMask SDK）の更新待ち。 |
| @metamask/sdk / sdk-communication-layer | moderate | 同上 | 同上（uuid 経由）。 |
| @metamask/delegation-core / delegation-toolkit | moderate | 同上 | 同上（abi-utils/utils 経由）。MAv2 系は flag off で未使用経路。 |
| @gemini-wallet/core | moderate | wagmi → @wagmi/connectors | rpc-errors 経由。Gemini ウォレットコネクタ。 |
| wagmi / @wagmi/connectors | moderate | 直依存（wagmi） | 上記コネクタ群を束ねるだけ。wagmi 自身のコードの脆弱性ではない。 |
| hono | moderate | wagmi → @wagmi/connectors → porto → hono | Porto ウォレットの内部サーバ lib。OpenPay は **hono をサーバとして使っていない**（Next.js）。hono の脆弱性（IP 制限回避・Cookie/JWT 処理）は hono を自前サーバに使う場合のみ該当 → OpenPay では到達しない。 |
| uuid | moderate | @metamask/* / jayson 経由 | v3/v5/v6 で `buf` 指定時の境界チェック欠落。OpenPay は該当 API を直接呼ばない。 |
| x402 / x402-fetch / x402-next | moderate | 直依存 | 「via wagmi」= wagmi（→metamask/uuid 連鎖）に依存しているだけで、x402 自体のコード脆弱性ではない。 |

### C. 未使用の推移依存（Solana 系）— コード経路に存在しない

| パッケージ | sev | 依存経路 | 受容理由 |
|---|---|---|---|
| @solana/web3.js | moderate | @account-kit/smart-contracts → alchemy-sdk | OpenPay は **Solana を一切使わない**。alchemy-sdk が同梱するだけの dead transitive。実行されない。 |
| jayson | moderate | @solana/web3.js | 同上（Solana RPC クライアント）。uuid 経由の moderate。未使用経路。 |

### D. ethers v5 系（low ×12）+ elliptic — alchemy-sdk 経由の推移依存

| パッケージ | sev | 依存経路 | 受容理由 |
|---|---|---|---|
| @ethersproject/* (abi/providers/wallet/hash/transactions/signing-key/hdnode/json-wallets/contracts/abstract-* /wordlists) | low | @account-kit → alchemy-sdk | ethers v5 を alchemy-sdk が同梱。OpenPay 本体は viem を使用。low かつ推移。 |
| elliptic | low | @ethersproject/signing-key | 「リスクのある暗号プリミティブ実装」。広く既知の low。上流追従。 |

## 決定（受容）

- **`npm audit fix`（非破壊）は適用済み**。`--force`（メジャー更新）は wagmi / alchemy-sdk /
  vitest / next を破壊するため実行しない。
- 残 36 件は上表のとおり **OpenPay のサーバ実行経路に exploit 可能なものは無い**ため受容。
- **緩和策**: `vitest --ui` を起動・公開しない（critical の唯一の現実的トリガを断つ）。
- **再評価条件**（いずれかで本判断を見直す）:
  - 上流（wagmi / @account-kit / alchemy-sdk / vitest / next）が**非破壊**で修正版を出した → 追従。
  - Solana / hono を実際に使う構成に変えた → C/B-hono を再評価。
  - high/critical が **本番ランタイム経路**で新規に出た → 即対応。
- **運用**: リリース前 or 月次で `npm audit` を再実行し、本表を更新する。
