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

### 7.4 MODERATE: `ws` (GHSA-58qx-3vcg-4xpx)

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

- [ ] 1 週間 sampling で 平常 P99 gas price 記録
- [ ] sponsorship 経済性確認 (1 tx ≪ 1 円目安)
- [ ] env 投入後 Sentry の `gas_congested` × chainId:8217 発生率 < 0.1%

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
- [ ] Pimlico Kaia API balance を別 alert で監視 (`Pimlico balance alert`
      workflow に Kaia 用 chainId を追加 — 別 PR)
- [ ] /api/log/payment に kaia chain 集計を追加 (gmv 把握、別 PR)

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
