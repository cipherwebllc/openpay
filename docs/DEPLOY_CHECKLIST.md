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

## 6. 監視ダッシュボード

| 用途 | URL / location |
|---|---|
| Vercel deployment logs | https://vercel.com/cipherwebllc/openpay |
| Sentry errors | (Sentry org dashboard) |
| Vercel Analytics (pageviews) | Vercel Project → Analytics tab |
| Pimlico balance | (Pimlico dashboard、低残のとき alert を別途設定) |

## 7. Known Vulnerabilities (accepted risk)

`npm audit` で検出される脆弱性のうち、**upstream fix が無く** OpenPay 側で
直接対処不能 / 影響が限定的なものを accepted risk として明示。deploy 前に
本項を確認し、新規追加・状況変化があれば update。

### 7.1 HIGH severity: `@segment/analytics-next` 経由 (5 件)

| Package | severity | path | fixAvailable |
|---|---|---|---|
| `@account-kit/smart-contracts` (direct) | high | → `@account-kit/infra` → `@account-kit/logging` → `@segment/analytics-next` | **false** |
| `@account-kit/infra` (transitive) | high | 同上 | false |
| `@account-kit/logging` (transitive) | high | → `@segment/analytics-next` | false |
| `@segment/analytics-next` (transitive) | high | 直接の脆弱 module | (Segment 側 release 待ち) |

**OpenPay code path の影響**:
- `@account-kit/smart-contracts` は `lib/smartAccount/mav2.ts:35` で
  `createModularAccountV2` を import。HashPort wallet (Alchemy MAv2 + 7702
  delegate) 経路で実行される production code path
- `@account-kit/logging` の `dist/types/plugins/contextAllowlist.d.ts` 等で
  `@segment/analytics-next` を **type import**。実 runtime で plugin が
  initialize される可能性あり = vulnerability path 到達可能

**Reachability assessment** (= 実際の exploitability):
- `@segment/analytics-next` plugins の役割は Alchemy SDK 内部 analytics の
  context restriction (defensive enforcement)。攻撃者制御の analytics event を
  注入する経路が OpenPay からは無い (= MAv2 wallet 構築は input が事前定義 EOA + chainId のみ)
- 結論: **practical exploitability 低**、ただし HIGH severity rating は維持

**Accepted risk の条件**:
- @account-kit/* が patched version を release するまで継続
- OpenPay 側で attack vector を増やす変更 (例: 任意の analytics event 注入経路追加) を行わない
- Sentry に @account-kit-related の異常 error が連続発生したら **即 reassess**

**再評価 trigger**:
- `@account-kit/smart-contracts` の major upgrade
- `@segment/analytics-next` の patched release
- Alchemy が SDK 内 analytics を opt-out 可能にした場合 → 即適用
- HIGH severity が EXPLOITABLE な PoC 公開時 → 即 alternative SDK 評価 (代替案: 直接 viem + Pimlico 経路のみで MAv2 を構築、@account-kit を完全削除)

### 7.2 確認手順 (再評価時)

```bash
npm audit --omit=dev --json | jq '.vulnerabilities | to_entries[] | select(.value.severity == "high")'
# 上記 5 件以外の HIGH が増えていないこと
# fixAvailable が変化していないこと (= upstream の進捗 signal)
```

新規 HIGH が出た場合は本 section を update してから deploy。
