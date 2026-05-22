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

`npm audit --omit=dev` で検出される脆弱性のうち、**upstream fix が無く** OpenPay
側で直接対処不能 / 影響が限定的なものを accepted risk として明示。deploy 前に
本項を確認し、新規追加・状況変化があれば update。

### 7.1 HIGH severity 単一 root: `js-cookie` (GHSA-qjx8-664m-686j)

**Evidence-verified facts** (2026-05-22 時点、`npm audit --omit=dev --json` で確認済):

- **Root advisory**: [GHSA-qjx8-664m-686j](https://github.com/advisories/GHSA-qjx8-664m-686j)
  — "JavaScript Cookie: Per-instance prototype hijack in `assign()` enables cookie-attribute injection"
- **Root package**: `js-cookie@3.0.1`、affected range `<= 3.0.5`
- **Propagation chain** (`npm ls js-cookie` で確認):
  ```
  @account-kit/smart-contracts@4.88.2  ← lib/smartAccount/mav2.ts:35 で import
    └─ @account-kit/infra@4.88.2
      └─ @account-kit/logging@4.88.2
        └─ @segment/analytics-next@1.74.0
          └─ js-cookie@3.0.1                  ← 脆弱性の root
  ```
- npm audit は chain 上の 5 package すべてに HIGH severity を伝搬させて報告するが、
  **underlying vulnerability は 1 件** (js-cookie)
- `fixAvailable: false` (@segment/analytics-next が js-cookie@3.0.1 を peg しているため)

**Exploit mechanism** (advisory 記載):
- `js-cookie` の `assign()` は per-instance prototype を共有する設計のため、
  cookie attribute (Path, Domain, etc.) に攻撃者制御の値を注入できると、
  以降の同一 instance の cookie write にその attribute が漏れる
- 攻撃成立条件: **攻撃者が Segment Analytics の cookie write path に任意 value を流し込めること**

**Reachability assessment for OpenPay** (= 推測ではなく code 上の constraints):
- `@account-kit/smart-contracts` の `createModularAccountV2` は wallet 構築時に
  EOA address + chainId + factory 設定を受け取るのみ (lib/smartAccount/mav2.ts)
- Alchemy SDK が internal で Segment Analytics を init する場合、event payload は
  Alchemy 側で wallet creation context (固定 schema) を組み立てる
- OpenPay から **任意 string を Segment.track / identify に流し込む API は無い**
  → 攻撃者が cookie attribute に injection するのに必要な input chain が存在しない
- **ただし完全な非到達性は保証できず** — Alchemy SDK 内部実装が将来 user-controlled
  field (例: wallet label) を analytics に渡し始めた場合、reachable に転じうる

結論: **現時点の使用範囲で practical exploitability は低**いが、上記前提が
将来変わる可能性は残存。Sentry に @account-kit / Alchemy 関連の異常 error が
連続発生 (= SDK 内部挙動変化の signal) したら即 reassess。

### 7.2 CI gate: allowlist 方式 (`scripts/audit-gate.mjs`)

`.github/workflows/ci.yml` の audit step は `node scripts/audit-gate.mjs` を呼ぶ。
本 script は `npm audit --omit=dev --json` を parse し、HIGH/CRITICAL advisory を
GHSA URL で同定、`ALLOWED_ADVISORIES` 辞書と照合して:

- accepted (allowlist 一致): log 表示のみ、CI pass
- unaccepted (新規 advisory): 詳細 log + **exit 1** で CI fail
- stale (allowlist にあるが現在検出されない): upstream fix の signal、log のみ

allowlist 追加 / 削除は本 §7 の update と必ず同期させること (= 監査 trail を
両ファイルの diff で残す)。現在 allowlist には GHSA-qjx8-664m-686j (js-cookie)
1 件のみ。

実行例:
```bash
$ node scripts/audit-gate.mjs
audit-gate: HIGH/CRITICAL advisories detected: 1 (accepted: 1, unaccepted: 0, stale-allowlist: 0)
...
audit-gate: OK
```

### 7.3 再評価手順

```bash
# HIGH advisory の count と root を抽出 (= 期待値: 1 root / js-cookie)
npm audit --omit=dev --json | python3 -c "
import json, sys
data = json.load(sys.stdin)
seen = set()
for name, info in data.get('vulnerabilities', {}).items():
    if info.get('severity') == 'high':
        for via in info.get('via', []):
            if isinstance(via, dict) and via.get('severity') == 'high':
                u = via.get('url', '')
                if u not in seen:
                    seen.add(u)
                    print(f\"{via.get('name')}: {u}\")"
```

期待出力: `js-cookie: https://github.com/advisories/GHSA-qjx8-664m-686j` の 1 行のみ。
**他の advisory が追加で出現したら deploy 前に本 §7 を update**。

### 7.4 再評価 trigger (Action 起こす条件)

| Trigger | Action |
|---|---|
| `@segment/analytics-next` が js-cookie@>=3.0.6 に更新 release | 即 `npm install`、CI green に戻る |
| `@account-kit/smart-contracts` の major upgrade で chain 解消 | 即 npm install + smoke test |
| Alchemy SDK 内部 analytics の opt-out flag 提供 | 即適用、依存連鎖断ち切り |
| GHSA-qjx8-664m-686j に EXPLOITABLE PoC 公開 | 即 alternative SDK 評価 (= lib/smartAccount を viem + Pimlico 経路のみで再構築、@account-kit を完全 drop) |

## 8. Sentry observability の前提条件

DEPLOY_CHECKLIST §3.2 の Alert Rules はすべて Sentry が event を受信していることが
前提。以下を **deploy 前に Vercel Project Settings で確認**:

| 環境変数 | 役割 | 未設定時の挙動 |
|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | client + server 双方の Sentry init key | `instrumentation.ts:27` / `instrumentation-client.ts:7` で early return、`Sentry.*` が no-op に degrade。**console fallback のみで Sentry には 1 件も送られない** |
| `SENTRY_AUTH_TOKEN` | source map upload | 未設定でも runtime は動く、ただし stack trace が minified |

**確認手順**:
```bash
# Vercel CLI で production env を一覧 (要 vercel login)
vercel env ls production | grep SENTRY
```

DSN 設定状況を未確認のまま deploy すると **alert rule が永遠に発火しない silent
failure** に陥る。`lib/logger.ts` のコメント (line 5-6) と一致する degrade 設計
だが、deploy 前に必ず 1 度確認する。
