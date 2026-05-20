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
