# Supply Chain Risks (npm audit accepted residuals)

**Updated**: 2026-05-24
**Last `npm audit --omit=dev` snapshot**: 29 vulnerabilities (13 low, 16 moderate, **0 high/critical**)

## 解消済 (production deploy で対応済)

| パッケージ | 元 CVE | 対応 |
|---|---|---|
| `js-cookie@<=3.0.5` | GHSA-qjx8-664m-686j (HIGH, CVSS 7.5) — Per-instance prototype hijack | `package.json` overrides `"js-cookie": "^3.0.7"` で全 tree 3.0.7 に強制 |
| `ws@8.0.0-8.20.0` | GHSA-58qx-3vcg-4xpx (MOD, CVSS 4.4) — Uninitialized memory disclosure | overrides `"ws@>=8.0.0 <8.20.1": "^8.21.0"` で 8.x 系のみ 8.21+ に bump (7.x はこの CVE 対象外なので不変) |
| `postcss@8.4.31` (devDep) | GHSA-qx2v-qp2m-jg93 (MOD, CVSS 6.1) — XSS via Unescaped `</style>` | devDep を `^8.5.15` に bump |

これにより HIGH 5 件 → 0 件、Total 47 → 29 に削減 (=2026-05-24 deploy 時点)。

## 残存 (accepted, runtime 影響なし / upstream patch 待ち)

### 1. `postcss@8.4.31` (transitive via Next.js 15.5.18)

| 項目 | 値 |
|---|---|
| CVE | GHSA-qx2v-qp2m-jg93 (MOD 6.1) |
| Path | `next@15.5.18 > postcss@8.4.31` |
| なぜ override 不可 | Next.js が `dependencies.postcss` を **exact `"8.4.31"` で pin** (caret/tilde なし)。npm の nested override は `invalid` で reject される (npm peer dep resolver の挙動)。 |
| なぜ accept 可能 | 本 CVE は **CSS stringify output に user input が混じる場合** の XSS。Next.js が内部 build 時に使う postcss は **OpenPay の user input を 1 度も通さない** (build step は CI/Vercel 側、user request path には登場しない)。production runtime での exposure ゼロ。 |
| Re-evaluate trigger | Next.js 15.6+ release で内部 postcss が 8.5.10+ にバンプされた時点で `npm install` で自動解消 |

### 2. `uuid <11.1.1` (transitive via @metamask/* + @walletconnect/* + jayson)

| 項目 | 値 |
|---|---|
| CVE | GHSA-w5hq-g745-h8pq (HIGH 7.5、ただし下記の通り **MOD として OpenPay には適用**) |
| Path | 多数 (Alchemy MAv2 / MetaMask SDK / WalletConnect / Solana web3.js) |
| 本実 exploit 範囲 | `uuid.v3()` / `uuid.v5()` / `uuid.v6()` を **`buf` パラメタ付きで呼ぶ場合のみ** バッファ境界チェック欠落。`uuid.v4()` (random、最も一般的) は **影響なし**。OpenPay が pull する uuid v8/v9 は v3/v5/v6 namespace 関数を実際に呼ぶコードパスを持たない (random session ID / connector tracking 用途のみ)。 |
| なぜ accept 可能 | 上記の通り **本 OpenPay の使用形態では実 exploit パスがゼロ**。npm audit は version range `<11.1.1` で 8.x/9.x を一律 flag するが、CVE 本文は v3/v5/v6 + buf API 限定。 |
| なぜ override 不可 | uuid v10/v11 は ESM-only + namespace API 削除の breaking changes。 v8/v9 強制 upgrade は @metamask/sdk-communication-layer / @walletconnect/utils / jayson の dep 互換性破綻。 |
| Re-evaluate trigger | Alchemy / MetaMask / WalletConnect / Solana の各 upstream が uuid v11+ に対応した時点で `npm install` で解消 |

### 3. その他の transitive (downstream of 上記 2 root)

残 16 MOD と 13 LOW は全て上記 2 root の downstream:
- `@metamask/*` (sdk-communication-layer, utils, sdk, rpc-errors) → uuid
- `@walletconnect/*` (utils, sign-client, core, universal-provider, ethereum-provider) → uuid / postcss-related
- `@reown/appkit-*` (controllers, ui, scaffold-ui, utils, pay) → @walletconnect/utils
- `@wagmi/connectors`, `wagmi`, `viem` → 上記 chain 経由
- `x402`, `x402-fetch`, `x402-next` → wagmi 経由
- `@ethersproject/*`, `alchemy-sdk` → @ethersproject/abi (legacy ethers v5)
- `@solana/web3.js`, `jayson` → uuid
- `@gemini-wallet/core` → @metamask/rpc-errors
- `next` → postcss

これらは root を fix すれば全て連鎖解消される。

## 監視と再評価方針

### 自動 (CI で running)

GitHub Actions の `.github/workflows/ci.yml` で `npm audit` 実行済 (情報のみ、CI fail なし設定)。新規 HIGH/CRITICAL 発見時は alert として上がる。

### 手動 (operator quarterly review)

四半期に 1 回:
1. `npm audit --omit=dev` で current vuln count を取得
2. 本ファイルの「解消済」「残存」と diff を取り、新規 HIGH/CRITICAL があれば即対応
3. 上記 "Re-evaluate trigger" の各 upstream の release notes を確認、対応版があれば bump

### 緊急対応 (HIGH/CRITICAL discovered)

1. CVE 詳細を確認 (GitHub Advisory database)
2. 実 exploit パスが OpenPay コードに存在するか確認
3. 存在する場合: hot-fix (override / 依存削減 / 別 lib 移行) を 24h 以内に deploy
4. 存在しない場合: 本ファイルに「残存 (低リスク)」として追記 + Re-evaluate trigger を設定

## 参考

- npm audit advisory database: https://github.com/advisories
- npm overrides docs: https://docs.npmjs.com/cli/v10/configuring-npm/package-json#overrides
- Next.js postcss pinning issue: https://github.com/vercel/next.js/discussions (内部 build 専用)
