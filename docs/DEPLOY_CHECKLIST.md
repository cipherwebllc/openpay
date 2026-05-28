# Deploy Checklist

OpenPay 本番 deploy 時のチェックリスト。コード外で人手検証が必要な項目のみ。

## 1. Pre-deploy

```bash
cd /Users/masia/Documents/GitHub/openpay
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
# Tip widget の HTTP smoke (10 件)
node scripts/smoke-tip-production.mjs

# 本番 env が active か (Sentry DSN bundle / Pimlico cron 実 active / API alive)
node scripts/verify-production-config.mjs

# 200 OK + 期待 path
curl -sI https://open-pay.jp/ja/pay?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=usdc&amount=10 | head -1
curl -sI https://open-pay.jp/en/checkout | head -1
curl -sI https://open-pay.jp/ja/tip/0x52d4901142e2B5680027da5EB47C86CB02a3cA81?token=jpyc | head -1

# x402 paid route は 402 を返すこと
curl -s -o /dev/null -w '%{http_code}\n' https://open-pay.jp/api/paid/hello
```

**`verify-production-config.mjs` が 2 件未満 ✗ の場合** — operator が下記を Vercel/GH
secrets に設定済か再確認 (§11 参照):

- ✗ Sentry DSN → Vercel project env `NEXT_PUBLIC_SENTRY_DSN` + `SENTRY_DSN` (server)
- ✗ Pimlico balance cron skip → GitHub Actions secrets `PIMLICO_PAYMASTER_POLYGON`
  / `PIMLICO_PAYMASTER_BASE` / `PIMLICO_PAYMASTER_KAIA` (optional) / `ALERT_WEBHOOK_URL`

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
| `market.rates.upstream_error` | `event:"market.rates.upstream_error"` | 5 events / 15 min | CoinGecko /simple/price の outage または shape 変更 → LP / /create の MarketRates strip が「レート取得不可」表示。client UI は graceful fallback、blocking ではない。10 件超で free-tier rate-limit の可能性も検討 |
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
- `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` 設定済 (mainnet 必須)。案A で JPYC sponsorship のガス代 reimbursement 送り先として使用。未設定だと 0x...dEaD に永久消失し運営赤字 (build で throw)
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

### 7.1 ✅ RESOLVED: `js-cookie` (GHSA-qjx8-664m-686j)

**2026-05-24 確認**: `npm audit` で no longer detected。`package.json` overrides で
`js-cookie>=3.0.7` を強制 (詳細は `docs/SUPPLY_CHAIN_RISKS.md`)、上流 upstream の
`@segment/analytics-next` が `js-cookie>=3.0.6` を採用したことで自然解消。
`scripts/audit-gate.mjs` の allowlist からも削除済。以下は歴史的記録。



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

### 7.2 MODERATE: `postcss` (GHSA-qx2v-qp2m-jg93)

**Root advisory**: [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93)
— "PostCSS has XSS via Unescaped `</style>` in its CSS Stringify Output"

**Propagation chain** (`npm ls postcss --omit=dev` で確認):
```
next@15.5.18 → postcss@8.4.31  ← affected (脆弱性 fix は postcss>=8.5.10)
```

**Exploit mechanism**: postcss の CSS stringify が `</style>` を escape せず、
attacker-controlled CSS が runtime に出力されると HTML context へ抜けて XSS。

**Reachability for OpenPay**:
- postcss は Next.js の Tailwind / CSS build pipeline 内で**ビルド時にのみ**動作
- CSS の入力は OpenPay 自身のソース (`app/*`, `components/*`, Tailwind config) のみ
- ユーザ入力が postcss に流れる経路は無く、stringify 出力は静的 `_next/static/css`
  に書き出され、ランタイムでブラウザは生成済 CSS を読み込むだけ
- XSS の attacker-controlled input chain は構造的に存在しない

**Reassess triggers**:
- Next.js が postcss>=8.5.10 に bump → 即 `npm install`
- runtime CSS-in-JS / ユーザ入力 CSS を受ける機能を OpenPay 側に追加
- GHSA-qx2v-qp2m-jg93 に build-time exploit PoC 公開

### 7.3 MODERATE: `uuid` (GHSA-w5hq-g745-h8pq)

**Root advisory**: [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
— "uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided"

**Propagation chain**:
```
@metamask/utils → uuid@9.0.1     ← affected (脆弱性 fix は uuid>=11.1.1)
jayson → uuid@8.3.2              ← affected
(他 transitive 経路あり、root は同一)
```

**Exploit mechanism**: `uuid.v3(name, namespace, buf)` / v5 / v6 を `buf` 引数付き
で呼んだ時に bounds check 漏れ、out-of-bounds 書き込み。

**Reachability for OpenPay**:
- OpenPay 直接の uuid 呼び出しは無し (`grep -r uuid app/ components/ lib/ hooks/` で空)
- transitive (@metamask/utils 等) は内部で `uuid.v4()` (random、buf 引数なし) を使う
- buf 引数を取る v3/v5/v6 経路は依存ツリー上で reachable でない

**Reassess triggers**:
- @metamask/utils が uuid>=11.1.1 に bump
- OpenPay が uuid を direct dependency 化
- GHSA-w5hq-g745-h8pq に v4 API を含む拡張 advisory 出現

### 7.4 ✅ RESOLVED: `ws` (GHSA-58qx-3vcg-4xpx)

**2026-05-24 確認**: `npm audit` で no longer detected。`package.json` overrides で
`ws>=8.21.0` を強制 (詳細は `docs/SUPPLY_CHAIN_RISKS.md`)、viem 側も後続版で
ws を bump。`scripts/audit-gate.mjs` の allowlist からも削除済。以下は歴史的記録。



**Root advisory**: [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx)
— "ws: Uninitialized memory disclosure"

**Propagation chain**:
```
viem@2.50.3 → ws@8.18.0  ← affected (脆弱性 fix は ws>=8.20.1)
```

**Exploit mechanism**: ws を **server** として permessage-deflate 拡張で動作させた
時の特定 frame 処理で uninitialized memory が response に紛れて leak。

**Reachability for OpenPay**:
- OpenPay の ws は viem の RPC websocket **client** (Pimlico / Alchemy RPC 接続)
  として動作
- server mode は本 codebase で一切利用しない
- client 側にはこの脆弱性は影響しない (CVE 範囲外)

**Reassess triggers**:
- viem が ws>=8.20.1 に bump
- OpenPay が ws を server mode で利用する機能を追加 (= webhook server 等)
- GHSA-58qx-3vcg-4xpx に client-side exploit PoC 公開

### 7.5 CI gate: allowlist 方式 (`scripts/audit-gate.mjs`)

`.github/workflows/ci.yml` の audit step は `node scripts/audit-gate.mjs` を呼ぶ。
本 script は `npm audit --omit=dev --json` を parse し、**MODERATE / HIGH /
CRITICAL** advisory を GHSA URL で同定、`ALLOWED_ADVISORIES` 辞書と照合して:

- accepted (allowlist 一致): log 表示のみ、CI pass
- unaccepted (新規 advisory): 詳細 log + **exit 1** で CI fail
- stale (allowlist にあるが現在検出されない): upstream fix の signal、log のみ

allowlist 追加 / 削除は本 §7 の update と必ず同期させること (= 監査 trail を
両ファイルの diff で残す)。現在 allowlist:
| GHSA ID | Pkg | Sev | docRef |
|---|---|---|---|
| GHSA-qjx8-664m-686j | js-cookie | HIGH | §7.1 |
| GHSA-qx2v-qp2m-jg93 | postcss | MODERATE | §7.2 |
| GHSA-w5hq-g745-h8pq | uuid | MODERATE | §7.3 |
| GHSA-58qx-3vcg-4xpx | ws | MODERATE | §7.4 |

(2026-05-22 から moderate も gate 対象に昇格、warning-only count threshold は廃止)

実行例:
```bash
$ node scripts/audit-gate.mjs
audit-gate: MODERATE+ advisories detected: 4 (accepted: 4, unaccepted: 0, stale-allowlist: 0)
...
audit-gate: OK
```

### 7.6 再評価手順

```bash
# MODERATE+ advisory の root を全部列挙 (期待値: §7.1-7.4 の 4 件)
npm audit --omit=dev --json | python3 -c "
import json, sys
data = json.load(sys.stdin)
seen = set()
for name, info in data.get('vulnerabilities', {}).items():
    if info.get('severity') in ('moderate', 'high', 'critical'):
        for via in info.get('via', []):
            if isinstance(via, dict) and via.get('severity') in ('moderate', 'high', 'critical'):
                u = via.get('url', '')
                if u not in seen:
                    seen.add(u)
                    print(f\"{via.get('severity'):>8}  {via.get('name'):20}  {u}\")"
```

期待出力 (順不同):
```
    high  js-cookie             https://github.com/advisories/GHSA-qjx8-664m-686j
moderate  postcss               https://github.com/advisories/GHSA-qx2v-qp2m-jg93
moderate  uuid                  https://github.com/advisories/GHSA-w5hq-g745-h8pq
moderate  ws                    https://github.com/advisories/GHSA-58qx-3vcg-4xpx
```

**他の advisory が追加で出現したら deploy 前に本 §7 を update + allowlist 同期**。

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

## 9. Kaia chain (JPYC × chainId 8217) 投入 SOP

2026-05-23 demand 顕在化を受けて Kaia 対応を main に投入。本節は **新規 Kaia
deploy 前** または **Kaia 関連変更 deploy 前** に確認する SOP。Polygon 経路と
独立しているため、Kaia でトラブルが出ても Polygon 経路には影響しない。

### 9.1 contract bytecode + EIP-2612 permit 検証 (deploy 前 自動 script)

`scripts/verify-kaia-jpyc.mjs` で 14 項目を一括検証 (bytecode 存在 / ERC-20
標準 7 関数 / name+symbol+decimals が JPYC v3 spec / EIP-2612 permit 3 関数 /
JPYC v3 cross-chain consistency)。

```bash
# Kaia mainnet 上の JPYC contract 検証 (hard-code default address 0xE7C3…3c29)
node scripts/verify-kaia-jpyc.mjs

# Kairos testnet
node scripts/verify-kaia-jpyc.mjs --testnet

# 明示的に address / RPC を指定 (kaiascan.io から取得した address での先行確認)
node scripts/verify-kaia-jpyc.mjs --address 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 \
  --rpc https://public-en.node.kaia.io
```

- [ ] `verify-kaia-jpyc.mjs` (mainnet) → 全 14 項目 pass で exit 0
- [ ] `verify-kaia-jpyc.mjs --testnet` (Kairos) → 全 14 項目 pass で exit 0
- [ ] DOMAIN_SEPARATOR() の値が JPYC 公式 docs (もしあれば) の値と一致
- [ ] 既知の Polygon address との一致 (script 内で自動報告、確認は人手)

**2026-05-22 実測**: Kaia mainnet `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`、
ERC-20 + permit selector 全 OK。`DOMAIN_SEPARATOR()` のみ revert を観測したが、
OpenPay は **permit を使わず transferFrom 直接呼び** (既存 Polygon JPYC v3 と同
経路) のため影響なし。permit 経路を使う上流統合を将来追加する場合は再評価。

### 9.2 Pimlico Kaia bundler capability 検証 (自動 script)

`scripts/verify-kaia-pimlico.mjs` で 5 項目を Kaia mainnet + Kairos testnet 両
方で検証 (endpoint 到達性 / supportedEntryPoints v0.7 / chainId 一致 / 3 tier
gas price / pimlico_getUserOperationStatus)。

```bash
NEXT_PUBLIC_PIMLICO_API_KEY=<key> node scripts/verify-kaia-pimlico.mjs
```

- [ ] 全 5 × 2 = 10 項目 pass で exit 0
- [ ] gas price standard tier ≪ `NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI` 設定値

**2026-05-22 実測**: Kaia mainnet + Kairos testnet 共に EntryPoint v0.6/v0.7/
v0.8 対応、standard 31.5 gwei (default ceiling 50 gwei 内、margin 60%)。

### 9.3 Pimlico sponsorship policy (Kaia 用)

`NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` の 1 つの env が全 chain で共用
される設計 (`lib/pimlico.ts`)。Pimlico の sponsorship 機構は cross-chain で
動作するため、chain ごとに別 policy / 別 env を持つ必要はない。

**2026-05-23 確認済 (Pimlico dashboard)**:
- Sponsorship Policy: 「**All Chains**」トグル ON → Polygon (137) + Kaia
  (8217) + Kairos (1001) + Base / Arbitrum / Optimism mainnet & testnet 全部
  含めて 1 policy で受理
- Billing: **Credit Balance (USD unified)** — sponsor された UserOp の native
  gas cost を Pimlico が実時換算で USD 引き落とし、chain 別 deposit 不要
- Pimlico Kaia capability (`scripts/verify-kaia-pimlico.mjs`): standard
  31.5 gwei (実測)、1 tx ≈ $0.01、Polygon の 1/5 で sponsorship 経済性は良好

確認 checklist (新規 Kaia 関連改修時に再走らせる):

- [x] Pimlico dashboard で sponsorship policy が chainId 8217 (Kaia mainnet)
      と 1001 (Kairos testnet) を許可している (All Chains ON で達成)
- [x] Credit Balance > $0 (Polygon 動作実績で確認済)
- [ ] (新規 chain 追加時のみ) Pimlico dashboard で当該 chain が Active に
      なっていること、policy で chain が受理されること、balance が
      sponsorship 想定量に対し十分であること

### 9.4 Kairos testnet 実 UserOp smoke (手動、要 funded EOA)

script で自動化できない部分: 実 Smart Account の EIP-7702 delegate + UserOp
submit。**JPYC Faucet が Kairos 対応 (2026-05-18 公式)** で大幅に軽量化:

- https://prtimes.jp/main/html/rd/p/000000316.000054018.html

```bash
# Step 1: Kairos 用 JPYC を JPYC Faucet から取得 (公式 URL は JPYC docs 参照)
# Step 2: 同 EOA の Kairos KAIA gas を Kairos public faucet から取得
# Step 3: OpenPay を Kairos 向けに起動 (hard-code default で動作、env override 不要)
NEXT_PUBLIC_NETWORK_ENV=testnet \
NEXT_PUBLIC_KAIROS_RPC_URL=https://public-en-kairos.node.kaia.io \
npm run dev
# → /pay?to=...&token=jpyc&chain=kaia&amount=1 で sponsored gasless 経路を実機 submit
```

- [ ] JPYC Faucet (Kairos) から testnet JPYC 取得
- [ ] UserOp submit → receipt 取得まで通る
- [ ] sponsorship paymaster の policy id が Kairos でも適用される
- [ ] Sentry に `gas_congested` 等の予期せぬ event 無し

### 9.5 gas ceiling tune (実測値、運用中の継続作業)

```bash
# Pimlico fast tier の Kaia mainnet quote を 1 週間サンプリングし、
# 安全側 50 gwei 既定値 (lib/gasCeiling.ts) が妥当か確認。
# spike 時の最大値 + α を ceiling に設定。
NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI=<observed_max>
```

> **重要 (案A / collect-at-ceiling): gas ceiling は 2 役を兼ねる。**
> sponsorship (JPYC) では `useGasQuoteJpyc` が **ceiling 価格を徴収基準**に使う
> (live price ではない)。**保証は PRICE 次元のみ**: `assertGasCeiling` (fast tier)
> が ceiling 超を reject、submit は standard tier 支払いなので `standard ≤ ceiling`
> → 徴収の ceiling 価格 ≥ 実支払い価格 + rate buffer のクッション。**GAS UNITS
> 次元は無条件保証ではない**: 徴収は固定 overhead (200k) 見積で、実 UserOp の units
> が超え (multi-recipient split で transfer 本数増) かつ congestion で standard が
> ceiling 近くまで上がる稀ケースでは徴収 < 実費になり得る。平常時は ceiling/standard
> 比 (Polygon ~3.3x) + rate buffer (POL +37%) で十分カバー。**副作用として ceiling は
> 「混雑 block 閾値」と「徴収価格」を同時に決める** coupling — 下げると徴収額 (顧客/
> 店主負担) 減 but spike reject 増、上げると逆。徴収額は決済額に連動しない
> (gas units × ceiling 価格 × rate) インフラ実費。

- [ ] 1 週間 sampling で 平常 P99 gas price 記録
- [ ] sponsorship 経済性確認 (price 次元は構造的に保護、平常時の over-collect 幅
      = ceiling / 実 standard price 比を許容範囲か確認)
- [ ] **units 次元の残存リスク監視**: 実 sponsored gas (Pimlico 請求) vs 徴収
      gasAmount の差分を log/Sentry で観測。split 利用時に under-collect が頻発
      するなら overhead を call 本数でスケール or rate buffer を厚くする運用判断。
- [ ] env 投入後 Sentry の `gas_congested` × chainId:8217 発生率 < 0.1%
- [ ] 規約 / 特商法に「ネットワーク手数料は混雑時上限価格で固定徴収・余剰返金なし」
      の開示を反映済か確認 (UI 文言は gaslessHintJpyc / gasInfoJpyc に実装済)

### 9.5b native → JPYC rate 検証 (POL / KAIA、本投入前 必須、月次継続)

`hooks/useGasQuoteJpyc.ts` の `DEFAULT_POL_JPYC_RATE` / `DEFAULT_KAIA_JPYC_RATE`
は両方とも実勢に追従させる必要がある。2026-05-23 user 確認値:

| native | 実勢 USD | 換算 (¥159/USD) | over-collect 政策 | default |
|---|---|---|---|---|
| POL | $0.092 | **¥14.6** | +37% (volatility buffer 厚め) | **20n** |
| KAIA | $0.07 (1.34 KAIA = $0.07) | **¥8.21** | +22% | **10n** |

env override で月次調整、未設定時は default フォールバック。

```bash
# 市場価格を取引所 / CoinGecko 等で確認 (例: 2026-05-23 時点 上記表)
# env 上書きが必要な場合 (実勢 ±30% 以上 drift 時):
vercel env add NEXT_PUBLIC_POL_JPYC_RATE production
vercel env add NEXT_PUBLIC_KAIA_JPYC_RATE production
# 例: 実勢 ¥30/POL に上昇 → NEXT_PUBLIC_POL_JPYC_RATE=36 (+20% over)
# Redeploy で baking
```

- [x] **2026-05-23**: POL=¥14.6 / KAIA=¥8.21 確認、default をそれぞれ `20n` /
      `10n` に設定済 (commit: LARP audit 反映)
- [ ] env で更に locked-in したい場合 `NEXT_PUBLIC_*_JPYC_RATE` に明示値を設定
- [ ] 両 chain 経路で実 wallet 1 件 smoke、「ネットワーク手数料見積」が想定
      範囲で表示されるか目視:
  - Polygon: 200_000 × 250 gwei × 20 = 1e18 wei JPYC ≈ **1.0 JPYC**
  - Kaia: 200_000 × 31.5 gwei × 10 = 6.3e16 wei JPYC ≈ **0.063 JPYC**
- [ ] 月次で両 native 価格を再確認、±30% 以上 drift したら env 更新 + 必要なら
      `DEFAULT_*_JPYC_RATE` も commit で追従

env 未設定時の default は両 chain とも over-collect 側に倒している (under-collect
= OpenPay 損失より安全寄り)。運営手数料 1.0% が gas 換算誤差の 100x 大きいため
ズレは UX 上の数値表示問題に留まる。

**rate 変更時の 6 箇所同期 update** (stale 化防止、2026-05-23 audit で「4 箇所」
claim が漏れ ありと判明、6 箇所に拡張):
1. `hooks/useGasQuoteJpyc.ts` の `DEFAULT_*_JPYC_RATE` + 根拠 comment
2. `tests/hooks/useGasQuoteJpyc.test.tsx` の期待値 (×N、test 名内の数値も)
3. `.env.local.example` の env 説明コメント
4. 本 §9.5b の表 + smoke 期待値
5. `lib/env.ts` の `polJpycRate` / `kaiaJpycRate` docstring
6. `lib/gasCeiling.ts` の Polygon ceiling 説明 ("1 tx あたり最大 〜N JPY" 計算式)

`grep -rE "POL.*[0-9]+.*JPY|KAIA.*[0-9]+.*JPY|6[0-9]n|2[0-9]n.*JPY" lib hooks .env.local.example docs/DEPLOY_CHECKLIST.md tests`
で漏れ検出可能 (rate 数値が hardcode された箇所を網羅 grep)。

### 9.6 MAv2 + Kaia defensive UI (実装済)

MAv2 経路は Pimlico Kaia 非対応で早期 throw され、`errorMav2KaiaPolygon` i18n
message で「Polygon / Base / Arbitrum / Optimism 等の他チェーン版をご利用くだ
さい」と案内する (commit `7ee8bc4`、Payment/Tip/Checkout 3 form × ja/en 全カ
バー)。

**注意**: HashPort wallet は Kaia 非対応 (Ethereum/Polygon/Base/BNB/Avalanche/
Arbitrum/Aptos のみ) のため、本ガードは現時点で実発火しない defensive 実装。
将来 MAv2 系 wallet (Alchemy Account Kit 採用の他 wallet 等) が Kaia 対応した
場合に sponsorship 不能を fail-safe で案内する役割。

- [x] `lib/smartAccount/mav2.ts` chainId 8217/1001 で `errorMav2KaiaPolygon`
      i18nKey throw
- [x] i18n message を `messages/{ja,en}.json` の Payment/Tip/Checkout 3
      namespace に追加
- [x] `tests/lib/i18nKeys.test.ts` で 6 件全て存在を fence
- [ ] **将来 MAv2+Kaia wallet 出現時**: Sentry
      `smart_account.mav2_kaia_rejected` の実発火を観測したら、当該 wallet で
      実機 QA + 文言再確認

### 9.7 監視 / alert 追加

logger.warn による Sentry observability は既に code 側で実装済:

- `smart_account.mav2_disabled` (MAv2 wallet × flag off、HashPort 等の運用シグナル)
- `smart_account.unknown_delegation` (未知 delegate)
- `smart_account.mav2_kaia_rejected` (MAv2 × Kaia chain、新 wallet が Kaia 対応した signal)
- 既存 `gas_congested` event (chain 共通)

Sentry dashboard 側で alert rule を追加 (code change なし、dashboard 操作のみ):

- [ ] `event:"smart_account.mav2_kaia_rejected"` の発火頻度を週次 alert
- [ ] `gas_congested` × `chainId:8217` filter (既存 polygon rule の複製)
- [x] Pimlico Kaia API balance を別 alert で監視 — 2026-05-23 完了:
      `scripts/check-pimlico-balance.mjs` に Kaia chain (optional) を追加、
      operator が `PIMLICO_PAYMASTER_KAIA` secret を Vercel/GitHub に設定すると
      6h cron で balance を Slack/Discord webhook に通知
- [x] /api/log/payment に kaia chain 集計を追加 — 2026-05-23 完了:
      `GET /api/log/payment/stats` を新設 (Bearer auth)、chain × token 別の
      GMV / success / reverted / error 集計と chainId / since filter を提供。
      raw export は既存 `/api/log/payment/export` のまま

### 9.8 Rollback path

hard-code default を採用しているため env 削除だけでは止まらない。代わりに:

```bash
# 緊急時の rollback path (any one of):

# (a) 該当 commit を revert (一番 clean)
git revert <feat-kaia-jpyc commit hash>
git push origin main

# (b) Vercel dashboard で前 deployment へ promote (最速、UI 1 click)
# Vercel → Deployments → 前の successful build → "Promote to Production"

# (c) hard-code を local で空 string に書換 → `lib/tokens.ts` で kaia
#     deployment skip → UI から chain chooser button が消える
#     (= partial rollback、git revert より局所的)
```

- [ ] revert / promote 経路の動作を staging で 1 度確認 (git revert は dry-run
      推奨)
- [ ] Vercel deployment 一覧で過去 successful build が delete されていないこと


## §10 Cross-chain USDC Receive (Phase 1-3 投入後の E2E 検証)

[[cross-chain-usdc-receive]] phase 1-3 を本線投入 (2026-05-24)。spec / EIP-712
typehash regression guard / unit + integration test は全 green だが、
**Circle 実 attestation API + GatewayMinter / CCTP V2 contract への mint は
production code path として一度も実走していない** (LARP audit B1 で明示)。
operator は以下の order で testnet → mainnet 段階検証を実施する。

### §10.1 Hard gate 1: HashPort wallet (Alchemy MAv2 + EIP-7702) compatibility

OpenPay 主要ターゲット (memory: [[project_hashport_target]]) で動かなければ
phase 2 本線 UX は事実上意味を成さない。

- [ ] HashPort wallet を testnet (Polygon Amoy) で connect
- [ ] `/[locale]/experimental/cross-chain-demo` で env=true で mount 確認
      (Vercel `NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED=true` を一時設定)
- [ ] GatewayWallet.deposit (Polygon Amoy USDC を 1 USDC pre-deposit)
- [ ] 13-19 分待って Gateway balance 反映確認
- [ ] BurnIntent EIP-712 sign が wallet 上で完了する (HashPort UI で承認可能か)
- [ ] sign を attestation API に POST → attestation 取得成功
- [ ] dest (Base Sepolia) chain に switch + GatewayMinter.gatewayMint
- [ ] dest で USDC が merchant address に着金確認 (block explorer 1 入金 tx)
- [ ] **NG なら**: 別 wallet (MetaMask EOA) で同じ flow を試して挙動差分を log、
      HashPort 個別の不具合か共通の不具合か切り分け

### §10.2 Hard gate 2: 日本 IP から Circle attestation API access

- [ ] 日本 IP (自宅 / data center)、JP region VPN 不使用で
      `curl https://gateway-api-testnet.circle.com/v1/balances` を POST
- [ ] 200 OK (or 4xx の business error) が返ること、403 や 500 等の geo block
      indicator がないこと
- [ ] mainnet `https://gateway-api.circle.com/v1/balances` も同様検証
- [ ] iris `https://iris-api-sandbox.circle.com/v2/messages/6?...` も 200
- [ ] **NG なら**: Vercel server-side proxy 経由 (server fetch) で回避するか
      検討 (Vercel リージョンは us-east、Circle API 動作実績 region)

### §10.3 Soft gate: 各 chain の block height offset 適切性 (LARP A1 fix の動作確認)

`defaultBlockHeightOffset` で Polygon/Base/OP = 600 blocks (~20 分)、
Arbitrum = 5000 blocks (~21 分) を chain-aware で設定済。実機検証:

- [ ] Polygon Amoy source で attestation expire 起きない (典型 user flow ~2 分
      で完了するため余裕は問題ない、念のため)
- [ ] **Arbitrum Sepolia source** で attestation expire 起きないか確認 (
      ~0.25s/block で 5000 blocks = ~21 分、user flow > expire になる典型は
      ないはずだが LARP audit 起因の修正なので明示確認)
- [ ] 緊急時の env override: `NEXT_PUBLIC_CROSS_CHAIN_BLOCK_OFFSET_DEFAULT=8000`
      で全 chain に上書き設定可能であることを 1 度試して動作確認

### §10.4 mainnet smoke (testnet 全 OK 後)

- [ ] 自身の wallet で 1 USDC (mainnet) を Circle Gateway に deposit
- [ ] OpenPay 本線 `/pay?to=<self>&token=usdc&chain=base&amount=1` で
      Gateway path が CrossChainHint に表示される
- [ ] Pay button click → 全 step (sign / attest / switch / mint) 完走
- [ ] dest chain で 1 USDC 着金 + paymentLog で bridge='gateway' 記録確認
      (admin endpoint /api/log/payment/stats?since=YYYY-MM-DD で確認)

### §10.5 CCTP V2 Fast Transfer 実機検証

- [ ] testnet (Arbitrum Sepolia 残高あり、target Base Sepolia) で CCTP V2 path
      が CrossChainHint に表示される
- [ ] Pay button click → approve + burn + iris poll + receiveMessage 完走
- [ ] dest chain で USDC 着金 + bridge='cctp-v2' 記録

### §10.6 Sentry alert 設定

**前提確認**:
- [ ] Vercel production env で `SENTRY_DSN` (or `NEXT_PUBLIC_SENTRY_DSN`) が
      設定済か確認。**未設定の場合 `lib/logger.ts` の Sentry.captureMessage は
      silent no-op となり alert は飛ばない**。

**alert rule 登録**:
- [ ] `SENTRY_AUTH_TOKEN` + `SENTRY_ORG_SLUG` + `SENTRY_PROJECT_SLUG` を取得し
      `node scripts/setup-sentry-alerts.mjs` を **1 度実行** (idempotent、
      `cross-chain.execute.failed` + `cross-chain.balance-query.failed` の
      2 rule + 既存 5 rule を Sentry org に登録/skip)
- [ ] script output で 7 rule すべての `created` or `skip (既存)` を確認
- [ ] Sentry Dashboard → Alerts でも 7 rule の存在を目視確認

**threshold calibration** (alpha 初期値 = production 観測前の guess):
- [ ] cross-chain.execute.failed = 20件/h、balance-query = 100件/h は推測値。
      production 1 週間後に week-over-week で実 traffic baseline 算出 →
      p95 × 2 で threshold を更新 → 旧 rule を Dashboard で delete してから
      `scripts/setup-sentry-alerts.mjs` 再実行

**動作確認**:
- [ ] テスト event を 1 度発火させて alert 通知が来ることを目視確認

### §10.6b Cross-chain kill switch — 真の "instant" 経路

**重要 (audit で誤記訂正)**: `NEXT_PUBLIC_CROSS_CHAIN_DISABLED=true` は
Next.js 仕様で build-time env (client bundle へ inline)。Vercel env を flip
すると auto rebuild がトリガーされ **~2-5 分後** に反映、**instant ではない**。

**緊急時の優先順位**:
1. **Vercel Instant Rollback** (Dashboard → Deployments → 前 successful build →
   "Promote to Production"、rebuild 不要、~10 秒で CDN 反映、**全機能巻き戻し**)
2. **`NEXT_PUBLIC_CROSS_CHAIN_DISABLED=true`** (rebuild 2-5min、cross-chain
   だけ targeted disable、他機能は最新版維持)

**検証**:
- [ ] staging で env=true 設定 → rebuild 完了後に `/pay?token=usdc&amount=10`
      で CrossChainHint が表示されないことを確認
- [ ] Vercel Instant Rollback 経路を 1 度試して所要時間 (~10s 目安) を計測、
      運用 SOP として記録

### §10.6c Supply chain / npm audit

詳細は [`docs/SUPPLY_CHAIN_RISKS.md`](./SUPPLY_CHAIN_RISKS.md) 参照。

**2026-05-24 deploy 時点 baseline**:
- 47 vulnerabilities → 29 (12 low / 30 mod / 5 high → 13 low / 16 mod / **0 high**)
- HIGH 5 件全て解消 (js-cookie / ws / postcss-devDep override 経由)
- 残 29 件は 2 root (postcss-in-Next、uuid-in-MetaMask/WalletConnect) からの transitive で、本 OpenPay の使用形態では実 exploit パスなし (詳細は SUPPLY_CHAIN_RISKS.md)

**operator 四半期 task**:
- [ ] `npm audit --omit=dev` 実行、新規 HIGH/CRITICAL が無いことを確認
- [ ] `docs/SUPPLY_CHAIN_RISKS.md` の "Re-evaluate trigger" 各 upstream release を確認
- [ ] Next.js (postcss 内部 bump) / Alchemy / MetaMask / WalletConnect / Solana が patch 版を release していれば `npm install` で自動解消されるか確認

### §10.7 Production opt-out 経路の確認

- [ ] Vercel env で `NEXT_PUBLIC_EXPERIMENTAL_CROSS_CHAIN_ENABLED=false` (本線 UI
      は別 flag) を再確認、experimental demo route は production で 404 になる
- [ ] QrGenerator の crossChain toggle OFF で URL に `crossChain=false` が付き、
      該当 QR scan 時に CrossChainHint が表示されないこと
- [ ] 本線 UX の direct path (USDC 同一 chain 送金) が cross-chain 機能投入後
      も regression なく動くことを 1 度確認

### §10.8 Phase 4a: Ethereum L1 USDC 受信 chain 追加 (2026-05-24 投入)

phase 4a-1 で USDC 受信 chain を 4 → 5 chain に拡張 (Ethereum L1 追加)。SBI VC
トレード等の merchant 出庫先が L1 限定のユースケース対応。

**重要な制約**:
- Ethereum L1 USDC も Pimlico v2 ERC20 paymaster 対応 (2026-05 解禁)。gasless / standard
  両 mode 利用可。
- Ethereum L1 mainnet gas は他 chain より 1-3 桁高い ($1-5/tx 想定)。smoke は
  **0.5-1 USDC** の小額で済ませ、本 smoke のために 不要な large value tx を
  送らない (gas は L2 chain と比べてマージン消す方向に効く)。

**operator 設定**:
- [ ] Vercel env で `NEXT_PUBLIC_ETHEREUM_RPC_URL` を Alchemy / Infura 等の
      production-grade RPC に設定 (public RPC は rate limit に弱い、cross-chain
      の balance fetch で 12 chain 並列 query 時に 429 リスク)
- [ ] testnet env では `NEXT_PUBLIC_SEPOLIA_RPC_URL` を同様に設定
- [ ] `NEXT_PUBLIC_USDC_ETHEREUM_MAINNET_ADDRESS` は hard-code default
      (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`) のままで OK、emergency
      address 変更時のみ env override 設定 (Circle 公式アドレス変更は事前告知あり)

**testnet 検証**:
- [ ] `/pay?to=<self>&token=usdc&chain=ethereum&mode=standard&amount=0.1` で
      QR 生成 → MetaMask (Sepolia) で 0.1 USDC 支払い → Sepolia 着金確認
- [ ] gasless flag を URL で強制 (`mode=gasless` を直接付与) して reject
      されることを確認 (parser が "gasless mode 非対応" error を返す)
- [ ] QrGenerator UI で chain=Ethereum 選択時に payMode セレクターの gasless
      button が grey-out + 自動 standard に切替わることを確認
- [ ] cross-chain: Polygon Amoy USDC 残高あり buyer で
      `/pay?...&chain=ethereum&mode=standard&amount=0.1` 開く →
      CrossChainHint が "Gateway 経由で domain 7 → domain 0" を提案
      (現状は domain 番号表示、chain 名表示への置き換えは後続 task)

**mainnet smoke** (testnet 全 OK 後):
- [ ] 自身の wallet で 0.5 USDC (Ethereum L1) を保有
- [ ] `/pay?to=<self>&token=usdc&chain=ethereum&mode=standard&amount=0.5`
- [ ] MetaMask / Rabby / Frame 等の EOA で支払い → Ethereum L1 着金 (gas は
      ~$1-3 想定、blocknative 等で事前 confirm)
- [ ] paymentLog に bridge=undefined (direct path) + chainId=1 で記録される

**HashPort 互換性**:
- HashPort wallet は Ethereum/Polygon/Base/BNB/Avalanche/Arbitrum/Aptos 対応
  (memory: [[project_hashport_target]])。Ethereum L1 も対応 chain に含まれる
  ため、phase 4a の direct path (standard mode の EOA transfer) は HashPort
  でも動作するはずだが、L1 上の AA / gasless は未検証。
- [ ] HashPort wallet (Ethereum L1) で `/pay?...&chain=ethereum&mode=standard`
      の direct path が完了することを確認
- [ ] HashPort は MAv2 (7702 delegate) なので standard EOA send が AA に乗らず
      生 EOA send で動くか実機確認 (eth_sendTransaction 経路で動くはず)

### §10.9 Phase 4b-1: Avalanche + Unichain buyer-only chain 追加 (2026-05-24 投入)

phase 4b-1 で **buyer 側 USDC source chain** を 5 → 7 chain に拡張 (Avalanche
C-Chain + Unichain)。merchant 受信 chain は引き続き 5 chain のまま (USDC_CHAINS
は変更なし)、QR/Checkout chain chooser には出ない。

**設計**:
- `CrossChainTarget.role`: `'merchant-and-buyer'` (5 chain) / `'buyer-only'` (2 chain) で区別
- `CROSS_CHAIN_TARGETS` (lib/crossChain/config.ts) は 7 entry、`MERCHANT_RECEIVE_TARGETS` は merchant 用 filter 結果 (5 entry)
- buyer wallet が Avalanche / Unichain に繋がっている → CrossChainHint balance fetch で 7 chain 並列 query、Gateway source として最適 chain を選択
- merchant URL `chain=avalanche` 等は URL parser が reject (isValidChainSlug が false)
- Avalanche/Unichain USDC は `paymasterMode='unavailable'` (Pimlico 未対応 + buyer-only chain で gasless 不要)

**operator 設定**:
- [ ] Vercel env で `NEXT_PUBLIC_AVALANCHE_RPC_URL` / `NEXT_PUBLIC_UNICHAIN_RPC_URL`
      を production-grade RPC (Alchemy / Ankr 等) に設定 (12 chain 並列 balance
      fetch で public RPC 429 リスク)
- [ ] testnet env では `NEXT_PUBLIC_AVALANCHE_FUJI_RPC_URL` / `NEXT_PUBLIC_UNICHAIN_SEPOLIA_RPC_URL` を同様に設定
- [ ] `NEXT_PUBLIC_USDC_AVALANCHE_MAINNET_ADDRESS` / `NEXT_PUBLIC_USDC_UNICHAIN_MAINNET_ADDRESS`
      は hard-code default のままで OK (Circle 公式アドレス変更時のみ env override)

**testnet 検証**:
- [ ] Avalanche Fuji faucet で USDC ゲット
- [ ] `/pay?to=<self>&token=usdc&chain=base&amount=0.5` を Avalanche Fuji 接続済 wallet で開く
- [ ] CrossChainHint が "Gateway 経由で domain 1 → domain 6" を提案
      (現状 domain 番号表示、chain 名表示への置き換えは別 task)
- [ ] Pay button click → 全 step (sign / attest / switch / mint) 完走、Base Sepolia 着金確認
- [ ] Unichain Sepolia 経由でも同 flow を 1 度確認
- [ ] **merchant chooser に Avalanche/Unichain が出ない** ことを QrGenerator UI で再確認
      (USDC button 押下後の chain chooser が 5 ボタンのみ)
- [ ] URL `/pay?token=usdc&chain=avalanche` を直接叩いて 400 (invalid chain) を確認

**mainnet smoke** (testnet 全 OK 後):
- [ ] Avalanche / Unichain mainnet で USDC を 1-2 USDC 保有 (CEX から少額引出)
- [ ] 同 flow で Base mainnet に Gateway path で着金 1 周完了
- [ ] paymentLog に bridge='gateway' + sourceChainId=43114 (or 130) で記録される

**HashPort 互換性 (要確認)**:
- HashPort wallet は Avalanche C-Chain 対応 (公式: Ethereum/Polygon/Base/BNB/
  Avalanche/Arbitrum/Aptos)。Unichain は HashPort 非対応の可能性あり (要確認)。
- [ ] HashPort wallet (Avalanche) で BurnIntent EIP-712 sign が完了するか確認
- [ ] HashPort wallet (Unichain) は対応外の可能性 → 確認後に「対応外」記録 or 別 wallet 推奨を UX に反映

### §10.10 Tip widget parity: JPYC × Kaia + USDC cross-chain (2026-05-24 投入)

Payment page と同等の 2 機能を Tip widget (creator embed) に展開:

- **G1**: JPYC × Kaia chain 選択 — TipEmbedGenerator の chain chooser が JPYC 時にも
  表示され Polygon / Kaia から選べる。URL parser は cleanup commit `b5ce61e` で既に
  Kaia accept 済 (resolveChainSlugParam 集約による副次効果)。
- **G2**: USDC cross-chain 受信 — TipForm が CrossChainHint を mount し、fan が
  他 chain (7 chain) の USDC を Circle Gateway / CCTP V2 経由で creator 指定 chain に
  送れる。creator は TipEmbedGenerator の cross-chain toggle で opt-out 可 (default ON)。

共通 hook / component (`useCrossChainPayment`, `CrossChainHint`, `CrossChainSourceChooser`)
を Payment と完全再利用、Tip 専用の新規ファイル無し、後方互換完全保証。

**設計**:
- `TipParams.crossChain?: boolean` 追加、URL は false 時のみ `crossChain=false` を出力
- `TipSettings.crossChain: boolean` 追加 (default true)、旧 schema 救済 sanitize あり
- TipEmbedGenerator: `JPYC_CHAINS` を grid map (`isGaslessSupported` filter 経由)、
  USDC 時のみ crossChain checkbox 表示
- TipForm: `token === 'usdc' && address` で CrossChainHint mount、PaymentForm と同型 props

**operator 検証** (deploy 後 staging で 8 ケース):

JPYC Kaia 系 (4 ケース):
- [ ] `/ja` home の Tip tab で token=JPYC 選択 → chain chooser に Polygon + Kaia 2 ボタン表示
- [ ] Kaia click → 生成 URL に `&chain=kaia` 含まれる
- [ ] 生成 URL を新タブで開く → TipForm header に "Kaia" 表示 (testnet では "Kairos Testnet")
- [ ] (HashPort 非対応のため Pimlico 経由) Kaia 対応 wallet (例: Metamask Kaia 手動 add)
      で接続 → switchChain → preset click → Pimlico sponsorship 経由で gasless 送信成功

USDC cross-chain 系 (4 ケース):
- [ ] Tip tab で token=USDC + chain=Base 選択 → cross-chain checkbox 表示 (default ON)
- [ ] checkbox OFF にすると URL に `&crossChain=false` が乗る
- [ ] cross-chain ON URL を新タブで開いて fan wallet を Avalanche 接続 →
      CrossChainSourceChooser が Avalanche option を提示
- [ ] 「選択したチェーンで支払う」click → Gateway burn → Base 着金 → SuccessPanel 表示

**Sentry observability**:
- 新規 event は無し (既存の `cross-chain.execute.*` / `cross-chain.balance-query.failed`
  が Tip 経路からも発火するだけ)。surface 区別が必要になったら logger context に
  `surface: 'tip' | 'pay'` を追加する余地あり (本 phase 範囲外)。

**Rollback**:
- 共通 component を再利用しているため Tip 単体での feature flag は無い。problem 時は
  該当 commit (3 件: ee428ca / 9090b58 / b98097e) を git revert。CrossChainHint 自体は
  PaymentForm でも live のため、それを破壊しない単一 commit revert は不可。Tip 側の
  問題だけなら TipForm の `params.token === 'usdc' && address` ガードを一時的に
  `false` に短絡する hotfix commit を当てる方が低リスク。

## §10.11 既知の Build noise (修正不要)

- `(node:NNNN) [DEP0040] DeprecationWarning: The 'punycode' module is deprecated`
  — Node.js built-in `punycode` の deprecation 警告。3rd-party transitive deps
  (`node-fetch/whatwg-url`, `node-fetch/tr46`, `uri-js`) が bare `require('punycode')`
  を使うことで Node の built-in (deprecated 版) を解決してしまうため発火する。
  - **影響**: build stderr に warning が出るだけ、build/runtime 機能には無影響
  - **本リポジトリからの修正可否**: ❌ 不可。`package.json overrides` で userland
    `punycode@2.x` を install 済 (`npm ls punycode` で `punycode@2.3.1`) だが、
    Node は bare `require('punycode')` を built-in にしか解決しない仕様のため、
    upstream package 側が `require('punycode/')` 又は ESM `import` に書き換える
    まで消えない
  - **解消経路**: 待つ (Node 24 以降で built-in 削除される予定、それまでに upstream
    bump)、または当該 package を 1 つでも捨てる (eslint→ajv→uri-js の chain は除去
    困難)
  - **CI/operator action**: 不要 (受容済 noise)

## §11 Operator env precondition (本番 active 条件)

DEPLOY 前に operator が **Vercel project env** + **GitHub Actions secrets** に
設定済かを確認すべき env。設定漏れは silent 失敗 (script は no-op、cron は
graceful skip) で気付けないため、`verify-production-config.mjs` で必ず明示確認。

### §11.1 Vercel project env (production scope)

| Env var | 必須? | 未設定時の影響 |
|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | **必須** | browser 側 logger.warn/error が console のみ。本番 error 検知ゼロ (`smart_account.*`, `cross-chain.*`, `payment.*` 全 event 喪失) |
| `SENTRY_DSN` | **必須** | server side (Route Handler) の error 検知ゼロ。/api/log/payment 等の障害が観測不能 |
| `NEXT_PUBLIC_PIMLICO_API_KEY` | **必須** | gasless 決済全 fail (bundler 認証不能) |
| `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` | **必須** | 案A: JPYC sponsorship のガス代 reimbursement 送り先。未設定で build fail (lib/env.ts:guard)。0x...dEaD fallback に送ると運営が立替えた gas を回収できず赤字 |
| `NEXT_PUBLIC_NETWORK_ENV` | **必須** | `mainnet` 想定 (testnet は preview/dev のみ) |
| `PIMLICO_SPONSORSHIP_POLICY_ID` | 推奨 | 未設定で sponsorship policy なし運用 (chain ごとの上限なし) |
| `NEXT_PUBLIC_PAYMENT_LOG_TOKEN` | 任意 | 設定すれば /api/log/payment の auth 強化 |

確認: Vercel dashboard → Project Settings → Environment Variables → Production scope
を目視 + `node scripts/verify-production-config.mjs` で実行時 active を検証。

### §11.2 GitHub Actions repository secrets (Pimlico balance cron 用)

| Secret | 必須? | 未設定時の影響 |
|---|---|---|
| `PIMLICO_PAYMASTER_POLYGON` | **必須** | cron が `Secrets 未設定` で graceful skip、balance 監視ゼロ |
| `PIMLICO_PAYMASTER_BASE` | **必須** | 同上 |
| `ALERT_WEBHOOK_URL` | **必須** | Slack/Discord 通知先 URL、未設定で skip |
| `PIMLICO_PAYMASTER_KAIA` | 任意 (Kaia 投入後は推奨) | 未設定で Kaia chain は monitor 対象外 |

確認:
```bash
gh secret list --repo cipherwebllc/openpay | grep -E 'PIMLICO|ALERT_WEBHOOK'
# 最新 cron run の log で actual balance check 実行を確認:
gh run list --workflow=pimlico-balance.yml --repo=cipherwebllc/openpay --limit 1 --json databaseId \
  | jq -r '.[0].databaseId' \
  | xargs -I{} gh run view {} --repo=cipherwebllc/openpay --log \
  | grep -E 'balance|skip'
```

### §11.3 Sentry alert rules (一度限り setup)

```bash
SENTRY_AUTH_TOKEN=... SENTRY_ORG_SLUG=... SENTRY_PROJECT_SLUG=... \
  node scripts/setup-sentry-alerts.mjs
```

idempotent — 既に作成済 rule は skip、無ければ POST。実行履歴を私 (operator) が
気付けるよう Sentry Dashboard → Alerts → Issue Alerts で目視確認。

### §11.4 「verify-production-config.mjs」が 0 件 ✗ で deploy 認可

DEPLOY § 3.1 の smoke 全 pass + `verify-production-config.mjs` が `✅ N/N active` を
返すことが本番 deploy の go signal。1 件でも ✗ なら upstream env を設定するまで
deploy 完了とみなさない。

### §11.5 Accepted production risks (現状未対処)

| Risk | 現状の緩和 | 将来の選択肢 |
|---|---|---|
| `/api/log/payment` に明示 rate limit なし (DDoS で Vercel function 実行費用 spike 可能) | Vercel platform DDoS protection (built-in、attack mode 設定可)、`MAX_BODY_BYTES=2KB` で body 制限 (route.ts:99)、Bearer auth (`NEXT_PUBLIC_PAYMENT_LOG_TOKEN` 設定時) | (a) Vercel Firewall WAF rule で per-IP rate limit、(b) Upstash Ratelimit (Vercel Marketplace) で sliding window、(c) /api/log/payment は KV write 量 cap で kill switch 化済 (paymentLog.ts fire-and-forget) |
| `setup-sentry-alerts.mjs` 自動実行 CI なし (idempotent script を operator 手動実行に依存) | script は idempotent (既存 rule は skip)、人為的に rule が消えない限り再実行不要 | GH Actions workflow に sentry-setup を追加 (SENTRY_AUTH_TOKEN secret 必要) |
| punycode deprecation build warning | §10.11 受容済 noise (修正不能、機能無影響) | upstream packages (whatwg-url / uri-js) が `require('punycode/')` 採用するまで wait |

**判断根拠**: いずれも `validate demand before building speculative features`
方針 + 「現状障害なし + 緩和層あり」のため、demand signal 出現前の preemptive
engineering を避ける。将来 incident で demand 確認後に対処する。
