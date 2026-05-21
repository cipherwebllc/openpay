# Deploy Checklist

OpenPay 本番 deploy 時のチェックリスト。コード外で人手検証が必要な項目のみ。

## 1. Pre-deploy

```bash
cd /Users/masia02/openpay
git status                                  # working tree clean を確認
git log --oneline origin/main..HEAD         # push 予定 commits を確認
npm run typecheck && npm run lint && npm run test:run   # local 全 pass
./scripts/predeploy-backup.sh               # .env.local を backup (Vercel CLI 上書き対策)
```

## 2. Deploy (user-manual)

Vercel CLI deploy は `feedback_vercel_cli_env_local.md` の方針で常に user-manual。
Claude Code の auto-mode は production deploy を block するため terminal で直接実行:

```bash
git push origin main
vercel --prod --yes
./scripts/predeploy-backup.sh --verify-after   # backup と現 .env.local が同一か検証
```

## 3. Post-deploy 検証

### 3.1 自動 smoke (production URL)

```bash
# 200 OK + 期待 path
curl -sI https://open-pay.jp/ja/pay?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=usdc&amount=10 | head -1
curl -sI https://open-pay.jp/en/checkout | head -1
curl -sI https://open-pay.jp/ja/tip/0x52d4901142e2B5680027da5EB47C86CB02a3cA81?token=jpyc | head -1

# x402 paid route は 402 を返すこと
curl -s -o /dev/null -w '%{http_code}\n' https://open-pay.jp/api/paid/hello
```

### 3.2 Sentry dashboard 目視 (3 項目)

| 項目 | 確認場所 | 期待 |
|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` が production に設定済 | Vercel Project Settings → Environment Variables | DSN 値 set |
| Alert rule 存在 (error spike notification) | Sentry → Alerts | "Error frequency > threshold" rule active |
| Deploy 後 5 分の新規 error 数 | Sentry → Issues | 0 件 (新規 error 出現なし) |

#### Sentry Alert rule 仕様 (logger 経由のイベント名で発火条件を pin)

logger.warn / logger.error は Sentry の `event:` tag に msg を載せる
(`lib/logger.ts` の reportToSentry 経由)。以下を Sentry → Alerts → Create Alert
Rule で個別に設定する:

| Alert 名 | 条件 (filter) | 閾値 (発火) | 重大度 / 対処 |
|---|---|---|---|
| `scan.decode_error spike` | `event:"scan.decode_error"` | 10 events / 5 min | camera worker / video track が壊れた可能性 → /scan を一時的に hide 検討 |
| `scan.external_qr` | `event:"scan.external_qr"` | 20 events / 1 hour | フィッシング QR の流通可能性 → 警告 UI 文言の強化 + Slack 通知 |
| `scan.eip681_rejected` | `event:"scan.eip681_rejected"` | 5 events / 1 day | ethereum: URI の実需要 signal → Phase 2 検討入り |
| `scan.unrecognized_qr` | `event:"scan.unrecognized_qr"` | 30 events / 1 hour | 未知 QR が連発 → 別決済 system QR の誤読 / URL 仕様変更の可能性 |
| 全体 error level spike | `level:error` | 任意 (既存) | 既存 generic alert を継続 |

注: `scan.before_hydrate` も logger には残してあるが、`useOrigin` の useEffect が
mount 直後 synchronously に origin を set するのに対し、handleScanned は camera
permission + decode を経て数百 ms 後にしか発火しない (race window 実質ゼロ)。
そのため alert rule の閾値を設定しても永久に発火せず、運用 noise になる。
発火した場合のみ「異常事象」として Issues 一覧で確認する運用とし、
alert rule は設置しない。

filter 構文の前提: `lib/logger.ts:35-58` の `reportToSentry` は `captureException` /
`captureMessage` 双方に `tags: { event: msg }` を set する (logger.test.ts で
保証)。よって Sentry の Alert Rule で `tags[event]:"scan.*"` または UI 上では
`event:"…"` で filter 可能。

### 3.3 iOS Safari 実機 QA (emulation 不能パート)

playwright mobile-safari emulation で再現しない iOS 固有 quirk があるため、
**実 iPhone Safari で以下を目視**:

1. `https://open-pay.jp/ja` を Safari で開く
2. 「Tip widget (クリエイター)」タブをタップ
3. 受取アドレス欄に `vitalik.eth` を入力
4. **確認**: 「✓ vitalik.eth → 0xd8dA...6045」が表示され、**画面右端を突き抜けない**
5. ページ全体を左右にスワイプ → 横スクロールが発生しないこと

iOS Safari は `font-family` 切替時に親の `word-break` 継承が不安定で、emulation
(playwright WebKit) では再現しないことが LARP audit で確認済 (commit `74647fe` 参照)。

### 3.4 /scan (Pre-connect PWA, alpha) の実機 QA

playwright で emulation 不能な carbon 部分:

1. `https://open-pay.jp/ja/scan` を iPhone Safari で開く
2. WalletConnect で wallet を接続 → 緑 dot + shortAddress 表示
3. Safari 共有メニュー → 「ホーム画面に追加」 → home から PWA を再起動
4. PWA 内で `/ja/scan` が `display-mode: standalone` で開く (install hint が消える)
5. `Start camera` をタップ → camera permission 許可 → live preview が出る
6. 別端末で店舗 QR を表示 → スキャン → `/ja/pay?...` へ即遷移 + wallet 接続継続
7. (Android Chrome の場合) `beforeinstallprompt` → 「ホーム画面にインストール」が出る
8. 外部 origin の QR (例: 任意のサイトの URL) を読んで「OpenPay 以外」banner が出ること

計測:
- `scan.deeplink` (kind=pay/tip/checkout) breadcrumb 件数 / 週 ≥ 10
- `scan.camera_denied` 率 < 30%
- `scan.external_qr` / `scan.eip681_rejected` / `scan.unrecognized_qr` の異常値監視

### 3.5 LocaleSwitcher の手動回帰

各ページで「日本語 / English」ボタンを切替えて URL + 表示変化を目視:

| Page | URL | 期待 |
|---|---|---|
| `/ja/pay?to=0x...&amount=10` | English ボタン | `/en/pay?to=...&amount=10` query 維持、`Connect a wallet` 表示 |
| `/en/checkout?items=Coffee:2:5.00` | 日本語 ボタン | `/ja/checkout?items=...` 維持、`合計 10 USDC` 表示 |
| `/ja/tip/0x...?name=...` | English ボタン | `/en/tip/...?name=...` 維持、name 表示維持 |
| `/ja/scan` | English ボタン | `/en/scan` 維持、`Scan to pay` 表示 |

## 4. Rollback

問題発生時の復旧 path (検証済、`fatal: revert failed` の `.git/sequencer` 残留に注意):

### 4a. Git revert (推奨、commit history 残る)

```bash
git revert --abort 2>/dev/null     # 中断状態あれば clean
rm -rf .git/sequencer 2>/dev/null
git revert --no-edit <bad-commit>..HEAD
# rollback 検証 (production deploy 前に必ず local で):
rm -rf .next                       # stale type cache を消す (revert 後の typecheck が誤判定する)
npm run typecheck && npm run build # rollback 後の state が green か確認
git push origin main
# Vercel が auto deploy → 復旧
```

### 4b. Vercel dashboard (最速)

Vercel Dashboard → Deployments → 直前の安定 deployment → "Promote to Production"

## 5. 既知の前提 (deploy 前に確認)

- `NEXT_PUBLIC_NETWORK_ENV` = `mainnet` (Vercel production)
- `NEXT_PUBLIC_PIMLICO_API_KEY` 設定済 + balance 残あり
- `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` 設定済 (mainnet)
- JPYC v3 contract `0xE7C3...3c29` が 4 chain (Polygon/Sepolia/Avalanche Fuji/Amoy) で alive
- Sentry breadcrumb は wallet address を含み得るため `sendDefaultPii: false` を維持
- **`npm audit --production` の vulnerabilities が production-blocking 数を超えていない**
  - 2026-05 audit: 37 件 (15 low / 22 moderate)、主に `@reown/appkit-*` 系 (WalletConnect)
  - mainnet deploy 前: `npm audit fix --review` で breaking change 影響を確認しつつ moderate を 0 に
  - `npm audit fix --force` は walletconnect の major bump を巻き込むため別 PR で扱う

## 6. 監視ダッシュボード

| 用途 | URL / location |
|---|---|
| Vercel deployment logs | https://vercel.com/cipherwebllc/openpay |
| Sentry errors | (Sentry org dashboard) |
| Vercel Analytics (pageviews) | Vercel Project → Analytics tab |
| Pimlico balance | (Pimlico dashboard、低残のとき alert を別途設定) |

## 7. Kaia chain 投入手順 (kaia-poc branch merge 前のチェックリスト)

memory:project_kaia_evaluation の通り Kaia 対応は demand 顕在化まで `kaia-poc`
branch で draft 保留。下記 6 項目を **全て** 完了してから main へ merge:

### 7.1 + 7.2 contract bytecode + EIP-2612 permit 検証 (自動 script)

`scripts/verify-kaia-jpyc.mjs` で 14 項目を一括検証 (bytecode 存在 / ERC-20
標準 7 関数 / name+symbol+decimals が JPYC v3 spec と一致 / EIP-2612 permit
3 関数 / JPYC v3 cross-chain consistency)。

```bash
# Kaia mainnet 上の JPYC contract 検証 (env.local の NEXT_PUBLIC_JPYC_KAIA_ADDRESS を使用)
node scripts/verify-kaia-jpyc.mjs

# Kairos testnet 側
node scripts/verify-kaia-jpyc.mjs --testnet

# 明示的に address / RPC を指定 (kaiascan.io から取得した address での先行確認)
node scripts/verify-kaia-jpyc.mjs --address 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 \
  --rpc https://public-en.node.kaia.io
```

- [ ] `verify-kaia-jpyc.mjs` (mainnet) → 全 14 項目 pass で exit 0
- [ ] `verify-kaia-jpyc.mjs --testnet` (Kairos) → 全 14 項目 pass で exit 0
- [ ] DOMAIN_SEPARATOR() の値が JPYC 公式 docs (もしあれば) の値と一致
- [ ] 既知の Polygon address との一致 (script 内で自動報告、確認は人手)

**2026-05-22 既知の実測結果**: Kaia mainnet 上に address `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` で JPYC が deploy 済、ERC-20 + permit selector 全 OK、ただし `DOMAIN_SEPARATOR()` が revert する (要調査、permit 自体は selector exist で別 reason で revert)。本投入前に JPYC 発行体に確認推奨。

### 7.3 Pimlico Kaia bundler capability 検証 (自動 script)

`scripts/verify-kaia-pimlico.mjs` で 5 項目を Kaia mainnet + Kairos testnet 両方で検証 (endpoint 到達性 / supportedEntryPoints に v0.7 / chainId 一致 / 3 tier gas price / pimlico_getUserOperationStatus)。

```bash
NEXT_PUBLIC_PIMLICO_API_KEY=<key> node scripts/verify-kaia-pimlico.mjs
```

- [ ] 全 5 × 2 = 10 項目 pass で exit 0
- [ ] gas price standard tier ≪ `NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI` 設定値

**2026-05-22 既知の実測結果**: Kaia mainnet + Kairos testnet 共に EntryPoint v0.6/v0.7/v0.8 対応、standard 31.5 gwei (default ceiling 50 gwei 内、margin 60%)。

### 7.4 Kairos testnet 実 UserOp smoke (手動、要 funded EOA)

script で自動化できない部分: 実 Smart Account の EIP-7702 delegate + UserOp submit。

**JPYC Faucet が Kairos 対応 (2026-05-18 公式発表)** で大幅に軽量化:
- https://prtimes.jp/main/html/rd/p/000000316.000054018.html
- Kairos 用 JPYC を無償取得可能 → funded EOA 準備が即時化

```bash
# Step 1: Kairos 用 JPYC を JPYC Faucet から取得 (公式 URL は JPYC docs 参照)
# Step 2: 同 EOA の Kairos KAIA gas を Kairos public faucet から取得
# Step 3: OpenPay を Kairos 向けに起動
NEXT_PUBLIC_NETWORK_ENV=testnet \
NEXT_PUBLIC_JPYC_KAIROS_ADDRESS=0x... \
NEXT_PUBLIC_KAIROS_RPC_URL=https://public-en-kairos.node.kaia.io \
npm run dev
# → /pay?to=...&token=jpyc&chain=kaia&amount=1 で sponsored gasless 経路を実機 submit
```

- [ ] JPYC Faucet (Kairos) から testnet JPYC 取得
- [ ] UserOp submit → receipt 取得まで通る
- [ ] sponsorship paymaster の policy id が Kairos でも適用される
- [ ] Sentry に `gas_congested` 等の予期せぬ event 無し

### 7.5 gas ceiling tune (実測値)

```bash
# Pimlico fast tier の Kaia mainnet quote を 1 週間サンプリングし、
# 安全側 50 gwei 既定値 (lib/gasCeiling.ts) が妥当か確認。
# spike 時の最大値 + α を ceiling に設定。
NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI=<observed_max>
```

- [ ] 1 週間 sampling で 平常 P99 gas price 記録
- [ ] sponsorship 経済性確認 (1 tx ≪ 1 円目安)
- [ ] env 投入後 Sentry の `gas_congested` 発生率 < 0.1%

### 7.6 HashPort + Kaia 警告 UI (実装済)

MAv2 経路は Pimlico Kaia 非対応で早期 throw され、`errorMav2KaiaPolygon`
i18n message で「Polygon チェーン版の決済 QR をご利用ください」と案内する
(commit に実装済、Payment/Tip/Checkout 3 form ×ja/en 全カバー)。

- [x] `lib/smartAccount/mav2.ts` chainId 8217/1001 で `errorMav2KaiaPolygon` i18nKey throw
- [x] i18n message を `messages/{ja,en}.json` の Payment/Tip/Checkout 3 namespace に追加
- [x] `tests/lib/i18nKeys.test.ts` で 6 件全て存在を fence
- [ ] **実機 QA**: HashPort wallet + Kaia chain QR で警告文が表示されるか目視確認

### 7.7 監視 / alert 追加

logger.warn による Sentry observability は既に code 側で実装済:

- `smart_account.mav2_disabled` (HashPort × flag off)
- `smart_account.unknown_delegation` (未知 delegate)
- `smart_account.mav2_kaia_rejected` (MAv2 × Kaia chain) — Polygon フォールバック観測用
- 既存 `gas_congested` event (chain 共通)

Sentry dashboard 側で alert rule を追加 (code change なし、dashboard 操作のみ):

- [ ] `event:"smart_account.mav2_kaia_rejected"` の発火頻度を週次 alert (HashPort × Kaia の需要シグナル)
- [ ] `gas_congested` × `chainId:8217` filter (既存 polygon rule の複製)
- [ ] Pimlico Kaia API balance を別 alert で監視
- [ ] /api/log/payment に kaia chain 集計を追加 (gmv 把握)

### 7.8 Rollback path 確認

env unset で完全 kill-switch (`lib/tokens.ts` の deployment skip で UI 非露出)。

```bash
# Kaia を即座に無効化したい場合
vercel env rm NEXT_PUBLIC_JPYC_KAIA_ADDRESS production
vercel --prod
```

- [ ] dry-run で env 削除 → Kaia chain selector が消えることを staging で確認
- [ ] kaia-poc branch を main から revert する手順を README に明記
