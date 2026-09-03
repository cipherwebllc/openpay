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

### 7.5 HIGH: `ws` (GHSA-96hv-2xvq-fx4p)

**Root advisory**: [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p)
— "ws: Memory exhaustion DoS from tiny fragments and data chunks"
（§7.4 の旧 ws advisory GHSA-58qx・RESOLVED とは**別物**。2026-06 時点で **upstream に
修正版が無く**、最新 8.21.0 も影響範囲のため override での upgrade では解消できない。）

**Propagation chain**:
```
@reown/appkit / @walletconnect/* / viem → ws (websocket client)
```

**Exploit mechanism**: ws を **server** として動作させた時、攻撃者が極小 fragment /
data chunk を大量送信してメモリを枯渇させる DoS。

**Reachability for OpenPay**:
- OpenPay の ws は WalletConnect リレー / RPC subscription の websocket **client**
- server mode は本 codebase で一切起動しない → DoS の攻撃面が存在しない
- 修正版が無いため accepted risk (client 用途・低到達性) として gate を通す

**Reassess triggers**:
- ws が本 advisory の patched 版をリリース (8.21.0 超で fix 済) → override で bump し allowlist 削除
- OpenPay が ws を server mode で利用する機能を追加 (webhook server 等)
- GHSA-96hv-2xvq-fx4p に client-side exploit PoC 公開

### 7.6 ✅ RESOLVED: `@opentelemetry/core` (GHSA-8988-4f7v-96qf)

**2026-07-22 解消**: `npm update @sentry/nextjs` (→10.53.2+) が patched
`@opentelemetry/core >=2.8.0` を採用し `npm audit` で no longer detected。
Reassess triggers の 1 項目目どおりの自然解消。`scripts/audit-gate.mjs` の
allowlist からも削除済。以下は歴史的記録。

**Root advisory**: [GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf)
— "OpenTelemetry Core: Unbounded memory allocation in W3C Baggage propagation"

**Propagation chain**:
```
@sentry/nextjs → @sentry/node → @opentelemetry/instrumentation-http → @opentelemetry/core (<2.8.0)
```

**Exploit mechanism**: 信頼できない W3C Baggage ヘッダを大量処理した際の非有界
メモリ確保 (DoS)。

**Reachability for OpenPay**:
- @opentelemetry/core は @sentry/nextjs (サーバ側エラー/トレース計測) の transitive dep
- OpenPay は外部からの Baggage 伝播を計測対象にしておらず (Sentry 既定計装のみ)、
  攻撃者制御の Baggage が core に流れる実運用経路はない
- clean な単独修正は @sentry/opentelemetry チェーンの広範な再解決 (≈90 package churn) を
  要し、MODERATE・低到達性に対しリスク不相応 → accepted risk

**Reassess triggers**:
- @sentry/nextjs が patched @opentelemetry/core (>=2.8.0) を含む版へ更新 → npm update で解消し allowlist 削除
- OpenPay が外部 W3C Baggage ヘッダを計測/伝播する機能を追加
- GHSA-8988-4f7v-96qf に高到達性の exploit PoC 公開

### 7.8 HIGH: `sharp` (GHSA-f88m-g3jw-g9cj)

**Root advisory**: [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
— "sharp inherited vulnerabilities in libvips" (CVE-2026-33327 / 33328 / 35590 / 35591、
sharp <0.35.0)

**Propagation chain**:
```
next (optionalDependencies sharp ^0.34.3) → sharp → libvips
```

**Exploit mechanism**: libvips による**不正な画像ファイルの解析**時に trigger する
メモリ安全性の脆弱性群。攻撃者が細工画像を sharp に処理させる経路が必要。

**Reachability for OpenPay**:
- sharp は next/image の画像最適化ランタイムとしてのみ動作
- `next.config.mjs` に `images.remotePatterns` / `domains` が**無い**ため、next/image は
  外部 URL 画像を最適化できない = sharp が処理するのは**リポ内静的アセット**
  (トークン/チェーンロゴ・LP 画像) のみで、攻撃者制御の画像が libvips に到達する経路が無い
- ユーザ提供のアバター等は素の `<img>` 直リンクで描画し sharp を通らない
- 修正版 sharp 0.35 は next の `^0.34` range 外。native module の override は
  到達性ゼロの脆弱性に対しリスク不相応 → next 側の bump 待ち accepted risk

**Reassess triggers**:
- next が sharp>=0.35 を含む版へ更新 → npm update で解消し allowlist 削除
- `next.config.mjs` に `images.remotePatterns` / `domains` 等の remote 画像最適化を導入
  (**到達性が変わるため導入 PR で即再評価**)
- GHSA-f88m-g3jw-g9cj に next/image 経由の exploit PoC 公開

### 7.9 HIGH: `postcss` (GHSA-6g55-p6wh-862q)

**Root advisory**: [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q)
— "PostCSS: Arbitrary file read and information disclosure via attacker-controlled
sourceMappingURL in CSS comments" (postcss <=8.5.11)

**Propagation chain**:
```
next (exact pin postcss 8.4.31) → postcss
※ root の postcss は 8.5.15 で修正済み。next 内包 copy のみ該当。
```

**Exploit mechanism**: 攻撃者が書いた CSS コメント内の `sourceMappingURL` を postcss が
処理した際、**ビルドマシン上で**任意ファイル読取・情報漏えいが起きる。

**Reachability for OpenPay**: §7.2 (GHSA-qx2v) と同一 —
- postcss は build pipeline 内でビルド時にのみ動作し、入力は OpenPay 自身のソースのみ
- 第三者由来の CSS が postcss に流れる経路が存在しない (テーマ入稿等の機能なし)
- next 内包 copy は exact pin のため単独更新不可。override はビルド基盤への介入で
  到達性ゼロの脆弱性にはリスク不相応 → next 側の bump 待ち accepted risk (user 裁定 2026-07-24)

**Reassess triggers**:
- next が postcss>=8.5.12 を内包する版へ更新 → npm update で解消し allowlist 削除
- 第三者由来の CSS を build/postcss で処理する機能を追加 (**導入 PR で即再評価**)
- build-time 以外の exploit 経路の報告

### 7.10 HIGH: `postcss` (GHSA-r28c-9q8g-f849)

**Root advisory**: [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849)
— "PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL)
leads to Arbitrary .map File Disclosure" (postcss <=8.5.17)

**Propagation chain**:
```
next (exact pin postcss 8.4.31) → postcss
※ root の postcss は 8.5.23 へ更新済み (本 wave で 8.5.15→8.5.23)。next 内包 copy のみ該当。
```

**Exploit mechanism**: §7.9 (GHSA-6g55) と同族の sourceMappingURL 系。攻撃者が
制御する CSS の `sourceMappingURL` にパストラバーサルを仕込むと、postcss の
previous source map 自動読込が**ビルドマシン上の**任意 .map ファイルを開示する。

**Reachability for OpenPay**: §7.2 / §7.9 と同一 —
- postcss は build pipeline 内でビルド時にのみ動作し、入力は OpenPay 自身のソースのみ
- 第三者由来の CSS が postcss に流れる経路が存在しない (テーマ入稿等の機能なし)
- next 内包 copy は exact pin のため単独更新不可。override はビルド基盤への介入で
  到達性ゼロの脆弱性にはリスク不相応 → next 側の bump 待ち accepted risk (user 裁定 2026-07-25)

**Reassess triggers**:
- next が postcss>=8.5.18 を内包する版へ更新 → npm update で解消し allowlist 削除
- 第三者由来の CSS を build/postcss で処理する機能を追加 (**導入 PR で即再評価**)
- build-time 以外の exploit 経路の報告

### 7.11 Dependabot dev-scope 方針 (2026-08-01)

audit-gate は `npm audit --omit=dev` = **本番依存のみ**を gate する。Dependabot は
devDependencies も報告するため、本番 gate 外の dev advisory はここに裁定を記録し、
GitHub 上の alert は本節を根拠に dismiss してよい。

- **vitest CRITICAL (GHSA: Vitest UI server arbitrary file read/exec)**: 脆弱なのは
  `@vitest/ui` の UI server が listen している時のみ。**本リポは @vitest/ui を導入して
  おらず** (package-lock に不存在)、`vitest --ui` を実行しても server は起動できない =
  攻撃面が存在しない。v2 系に修正版は無く fix は vitest@4 (major×2・config/API 破壊変更)。
  → accepted。**vitest 4 移行は別タスク**として backlog (8,500+ tests の回帰確認込み)。
- **vite HIGH/MODERATE (fs.deny Windows bypass / optimized-deps .map / launch-editor NTLM)**:
  すべて dev server 経路。dev は macOS/Linux のみ・dev server は localhost 非公開・
  Windows 固有条件は環境に存在しない。fix は vitest@4 連動 → 同上 backlog。
- **esbuild MODERATE (dev server cross-origin read)**: 同じく dev server 限定・
  localhost 非公開。fix は vite major 連動 → 同上。
- **js-yaml / fast-uri / @babel/core / postcss(root 直依存分)**: 2026-08-01 に
  semver 内で修正版へ更新済み (js-yaml 4.3.1 / fast-uri 3.1.5 / @babel/core 7.29.7 /
  postcss 8.5.25。next 内包 postcss は §7.2/7.9/7.10 の受容が継続)。
- **x402-mcp (公開パッケージ)**: @modelcontextprotocol/sdk 1.30.0 (DNS rebinding 既定
  有効化・shared-transport leak 修正) / @hono/node-server 2.0.12 (SDK の宣言 range 内)
  へ更新済み。stdio transport 運用のため旧版でも実害経路は薄いが、公開物のため更新を
  優先した。**npm publish は user 承認後** (§14 の公開手順)。

### 7.12 MODERATE: `decode-uri-component` (GHSA-vcc3-ghjq-m6fr)

**Root advisory**: [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)
— "decode-uri-component: Denial of service via exponential decoding of malformed
percent-encoded input" (decode-uri-component <=0.4.2・修正版 0.5.0)

**Propagation chain**:
```
wagmi → @wagmi/connectors → @walletconnect/ethereum-provider@2.21.1 (exact pin)
  → @walletconnect/utils@2.21.1 → query-string@7.1.3 → decode-uri-component@0.2.2
```

**Exploit mechanism**: 不正な percent-encoding を含む入力のデコードが指数時間になり、
呼び出したプロセスの CPU を枯渇させる DoS。

**Reachability for OpenPay**: クライアントのみ —
- server 側 (app/api・lib) に @walletconnect / query-string / decode-uri-component の
  import はゼロ (grep 確認 2026-09-01)。WalletConnect の URI 解析として**ブラウザ内で
  のみ**動作する
- 最悪ケースは「細工された wc: URI を処理したユーザ自身のタブが固まる」= 資金・
  サーバへの影響なし (§7.5 ws client-only DoS と同型の判断)
- 修正版 0.5.0 は ESM 専用で、CJS の query-string@7 が `require` で読むため override は
  ウォレット接続導線を壊すリスク。@walletconnect/ethereum-provider@2.24.0 (query-string
  撤去済) への override は接続スタック 3 minor 一括差し替えで moderate/client-only には
  リスク不相応 → wagmi/connectors 側の bump 待ち accepted risk (user 裁定 2026-09-01)

**Reassess triggers**:
- @wagmi/connectors が @walletconnect/ethereum-provider>=2.24.0 を pin する版へ更新
  → npm update で解消し allowlist 削除
- server 側コードに WalletConnect URI / query-string 解析を追加 (**導入 PR で即再評価**)
- 本 advisory にタブのフリーズを超える exploit 経路 (RCE 等) の報告

### 7.7 CI gate: allowlist 方式 (`scripts/audit-gate.mjs`)

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
| GHSA-qx2v-qp2m-jg93 | postcss | MODERATE | §7.2 |
| GHSA-w5hq-g745-h8pq | uuid | MODERATE | §7.3 |
| GHSA-96hv-2xvq-fx4p | ws | HIGH | §7.5 |
| GHSA-f88m-g3jw-g9cj | sharp | HIGH | §7.8 |
| GHSA-6g55-p6wh-862q | postcss | HIGH | §7.9 |
| GHSA-r28c-9q8g-f849 | postcss | HIGH | §7.10 |
| GHSA-vcc3-ghjq-m6fr | decode-uri-component | MODERATE | §7.12 |

(§7.1 js-cookie / §7.4 ws〔GHSA-58qx〕/ §7.6 otel core〔GHSA-8988〕は upstream fix 済で
allowlist から削除済 = 上表は現行の実体。)

(2026-05-22 から moderate も gate 対象に昇格、warning-only count threshold は廃止)

実行例:
```bash
$ node scripts/audit-gate.mjs
audit-gate: MODERATE+ advisories detected: 4 (accepted: 4, unaccepted: 0, stale-allowlist: 0)
...
audit-gate: OK
```

### 7.8 再評価手順

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
| `NEXT_PUBLIC_SENTRY_DSN` | **必須** | browser 側 logger.warn/error が console のみ。本番 error 検知ゼロ (`smart_account.*`, `cross-chain.*`, `payment.*` 全 event 喪失)。**server / edge も同じ変数を読む** (`instrumentation.ts` の `register()` / `onRequestError`) ため、未設定なら Route Handler 側の error 検知もゼロ (/api/log/payment 等の障害が観測不能) |
| `NEXT_PUBLIC_PIMLICO_API_KEY` | **必須** | gasless 決済全 fail (bundler 認証不能) |
| `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` | **必須** | 案A: JPYC sponsorship のガス代 reimbursement 送り先。未設定で build fail (lib/env.ts:guard)。0x...dEaD fallback に送ると運営が立替えた gas を回収できず赤字 |
| `NEXT_PUBLIC_NETWORK_ENV` | **必須** | `mainnet` 想定 (testnet は preview/dev のみ) |
| `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` | **必須** (mainnet) | mainnet では未設定/空で `lib/env.ts` の guard が throw (sponsorship 残高悪用防止)。testnet のみ未設定可 = policy なし運用 (chain ごとの上限なし) |
| `PAYMENT_LOG_ADMIN_TOKEN` | 任意 | `/api/log/payment/export` + `/stats` の Bearer 認証トークン (`app/api/log/payment/_auth.ts`)。未設定なら両 admin endpoint が 503 `admin_token_not_configured` を返し log を取り出せない (`/api/log/payment` への POST 自体は認証不要) |

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

### §11.6 負荷測定 (本格運用前 必須、scripts/load-test.mjs)

ゼロ依存の負荷スクリプトで LP / market-rates API / payment page を重み付き mix で
叩き、レイテンシ p50/p90/p99・RPS・エラー率を実測する。エラー率 > 上限 or
p99 > 上限で exit 1 (gate 化可能)。

```bash
# preview / 本番 URL に対して (deploy 済を対象に):
npm run load-test -- --url https://open-pay.jp -c 50 -d 30 --max-error-rate 0.01 --max-p99-ms 1500
# ローカル build で baseline を取る:
npm run start &  # 別途 build 済前提
npm run load-test -- --url http://localhost:3000 -c 20 -d 15
```

ローカル build baseline (2026-05-29 実測、Apple Silicon、concurrency=20 / 12s):
| scenario | rps | p50 | p90 | p99 | err |
|---|---|---|---|---|---|
| LP (/ja) | 308 | 42ms | 53ms | 66ms | 0% |
| market-rates | 184 | 11ms | 17ms | 35ms | 0% |
| payment-page | 121 | 34ms | 43ms | 54ms | 0% |
| **overall** | **613** | — | — | **66ms** | **0%** |

- [ ] **本番/preview URL に対して負荷測定を実行**し、p99 と error_rate が許容範囲か確認
      (本番は Vercel cold start / network 込みで local より遅くなる前提)。market-rates は
      CoinGecko 5 分キャッシュ層の挙動 (cache hit/miss 比) を併せて観察。
- [ ] 想定ピーク同時接続数で error_rate < 1% を確認

### §11.5 Accepted production risks (現状未対処)

| Risk | 現状の緩和 | 将来の選択肢 |
|---|---|---|
| `/api/log/payment` の rate limit は KV 障害時 fail-open (KV 停止中は DDoS で Vercel function 実行費用 spike 可能) | 匿名化 IP prefix ごとに 60 req / 60s (`checkReadRateLimit`、route.ts:228)、`MAX_BODY_BYTES=8KB` で body 制限 (route.ts:17)、Vercel platform DDoS protection (built-in、attack mode 設定可) | (a) Vercel Firewall WAF rule で per-IP rate limit (KV 非依存の層を足す)、(b) Upstash Ratelimit (Vercel Marketplace) で sliding window、(c) /api/log/payment は KV write 量 cap で kill switch 化済 (paymentLog.ts fire-and-forget) |
| `setup-sentry-alerts.mjs` 自動実行 CI なし (idempotent script を operator 手動実行に依存) | script は idempotent (既存 rule は skip)、人為的に rule が消えない限り再実行不要 | GH Actions workflow に sentry-setup を追加 (SENTRY_AUTH_TOKEN secret 必要) |
| punycode deprecation build warning | §10.11 受容済 noise (修正不能、機能無影響) | upstream packages (whatwg-url / uri-js) が `require('punycode/')` 採用するまで wait |
| **A3 デバイス共通ラッチ (2026-09-03 レビュー裁定・受容)**: 同一端末で wallet を切り替えた同一人物が、状態不明のガスレス送金の直後にもう一方の wallet で再送すると二重支払いになり得る | ラッチは wallet 単位 (端末単位にしていない)。端末単位にすると共用 POS タブレット (店頭の 1 台を客が順に使う) で**他人の支払いを誤って阻止/誤帰属**するため、被害の大きい側を避けている。pending 応答は client の standard fallback を禁止済 (relayRoute) | 再評価トリガ = メトリクスで**同一端末の複数 wallet 利用**が観測されたとき (その時点で端末ラッチ or 端末+wallet の複合キーを再検討) |
| **A6 feeKind 束縛 (2026-09-03 レビュー裁定・受容)**: 改造クライアントは `feeKind` を送らないことで 1%/3% ではなく 2 JPYC フロアだけを払える | @handle 経由の注文は notify の `feeUncollected` で検出できる (受注側に不足が記録される)。@handle を使わない直接利用は現状ほぼ皆無で、実損は最大でも 1 注文あたり数十円規模 | 再評価トリガ = モバイル注文の流量が増えたとき、または `feeUncollected` の alert が実際に出たとき (その時点で feeKind を注文レコード側の権威値から server 決定に変える) |

**判断根拠**: いずれも `validate demand before building speculative features`
方針 + 「現状障害なし + 緩和層あり」のため、demand signal 出現前の preemptive
engineering を避ける。将来 incident で demand 確認後に対処する。A3/A6 は加えて
「塞ぐ側の副作用 (他人の決済を止める・money-path の制御フロー変更) の方が現状の実害より
大きい」ため、上記トリガまで現状維持とする。

### §11.7 SIWE セッション cookie の `__Host-` 化 (2026-09-03 投入・一度だけ全員サインアウト)

- 本番の SIWE セッション cookie 名を `op_sess` → **`__Host-op_sess`** に変更した
  (`lib/siwe.ts` の `sessionCookieName()` が唯一の情報源。dev/test は `op_sess` のまま —
  http://localhost では `__Host-` prefix がブラウザに拒否されるため)。
- **この変更を deploy すると、既存の `op_sess` cookie を持つ全員が一度だけサインアウトされる**
  (新しい名前しか読まないため。KV 側のセッションレコードは 7 日 TTL で自然消滅する)。
  再サインインは通常の SIWE 署名 1 回。deploy 直後に「/history が未ログインになった」問い合わせが
  来た場合はこれが原因なので、障害ではないと案内する。
- 発行属性は `Secure` + `Path=/` + `Domain` 属性なし の 3 点が必須 (`__Host-` の受理条件)。
  1 つでも欠けるとブラウザが cookie を黙って捨て、**ログインできない**状態になる。
  検証は `tests/app/api/auth-siwe.test.ts` (本番名 + 3 属性) と `tests/lib/siwe.test.ts`。

## §12 Phase B billing (2段階 後払い利用権) go-live SOP

決済コアは無料のまま、`/history` 整形閲覧・会計CSV (basic ¥300/月) と freee 連携
(pro ¥3,000/月) を後払い月額でゲートする。JPYC を `FEE_RECEIVER` へ送金 → 自己申告
txHash をサーバが on-chain 照合 → 30 日 tier 自動付与。詳細実装は memory:project_jpyc_free_pivot。

### §12.1 既定 (現状 = inert)
- `NEXT_PUBLIC_ENABLE_BILLING` 既定 **OFF** → paywall / `/history` ぼかし / `/api/fee/verify`
  (404) が一切出ない。`ALPHA_ENTITLEMENT_BYPASS` 既定 **ON** → `getEntitlement` が KV を読まず
  pro 固定を返す = ゲート全開放。**この既定の組み合わせが安全状態であり、ロールバック先でもある**。

### §12.2 go-live 手順 (順序厳守)
1. **先に testnet で実機 E2E (必須・下記 §12.4)**。これを通すまで mainnet 点灯しない。
2. `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` に実受領アドレスが設定済か確認 (mainnet は未設定だと
   env が build を throw 停止。testnet は未設定だと burn になるため route が 503 で弾く)。
3. `NEXT_PUBLIC_ENABLE_BILLING=1` をセット (build-time inline → 再デプロイ必須)。
4. `ALPHA_ENTITLEMENT_BYPASS=0` をセット (利用権必須運用へ。server runtime)。
5. Sentry alert を登録: `node scripts/setup-sentry-alerts.mjs` (SENTRY_AUTH_TOKEN 等必要・§11.5)。
   billing.fee.* 4 rule が idempotent に作成される。

### §12.3 ロールバック (安全状態へ即復帰)
- **最速 (UI 全停止)**: `NEXT_PUBLIC_ENABLE_BILLING=0` に戻して再デプロイ → paywall/ゲートが消え
  挙動完全 inert。
- **ゲートのみ開放 (UI は残す)**: `ALPHA_ENTITLEMENT_BYPASS=1` → 全 wallet が pro 相当で全機能開放。
- **コード巻き戻し**: 該当 commit を `git revert`。
- ※ NEXT_PUBLIC_* は build-time inline のため env 変更には再デプロイが要る (Vercel)。

### §12.4 testnet 実機 E2E (リリース前必須・未自動化の唯一の経路)
on-chain 検証経路 (実 `getTransactionReceipt` → 実 JPYC `Transfer` log 解析) は単体テストでは
合成ログ/fake client でしか検証していない。**実チェーンでの実証はこの手順のみ**:
1. SIWE ログイン → `/history` がぼかし + paywall になる。
2. ¥300 相当 JPYC を `FEE_RECEIVER` へ送金 → txHash を `/api/fee/verify` へ提出。
3. basic 付与 → `/history` 解除・CSV 可・freee は pro 要求。
4. ¥3,000 で pro → freee 同期可。
5. **同 txHash 再提出が 409 `already_processed` で拒否される**ことを確認 (二重付与防止)。

### §12.5 監視 (§12.2-5 で登録される alert)
| event (tag) | 閾値 | 意味 / 対処 |
|---|---|---|
| `billing.fee.grant-failed` | >3/h | 支払い済だが KV 永続化失敗 (顧客未付与)。KV/Upstash 不調を疑う |
| `billing.fee.unexpected` | >3/h | money-path の想定外 throw。RPC エンドポイント障害を疑う |
| `billing.fee.misconfigured` | >1/h | billing ON なのに FEE_RECEIVER 未設定。即 env 修正 or flag OFF |
| `billing.fee.release-failed` | >1/h | idempotency claim 解放失敗 = txHash 焼失。log の usedKey を手動 KV 削除 |

### §12.6 既知の前提 / 制約 (accepted)
- **maxDuration=20s** (`app/api/fee/verify/route.ts`) は Vercel plan が 20s 以上を許す前提
  (freee sync は 60s で稼働実績あり)。`lib/kv.ts` は per-call 5s timeout (AbortSignal.timeout) を
  持つので、KV ハング時は 5s で reason=timeout に倒れ slot に張り付かない (maxDuration は二重の backstop)。
- 検証成功後の KV 書込応答ロス時、read-back で landed 確認できなければ claim を release し再提出を
  許す。再提出は max マージで満了が数秒〜分延長され得る (self-only・非 farmable・許容)。
- soft-gate (`/history` ぼかし) は回避可能 (生データは本人の localStorage・思想と整合)。サーバ強制は
  freee (`isEntitled(_,'pro')`) と CSV 由来データのみ。
- 料金性質 (前払式該当性・決済額非連動の定額) の**弁護士確認は実績後に後ろ倒し** (合意済)。

## §13 モバイル注文 / レジ システム利用料 go-live SOP

決済コアは無料のまま、モバイル注文 (店頭 1% / 事前 3%) と レジ standard (7 月から 1%) の
システム利用料を**経路非依存**で課金する。料金は決済と同一 tx 内で `FEE_RECEIVER` へ分割
(ノンカストディ不変)。詳細実装は memory:project_mobile_order_fee。料率の真実点は
`lib/mobileOrderFee.ts` (legal `DISCLOSED_MOBILE_ORDER_FEE` フェンス) と `RECOVER_FEE_BPS`
(legal `DISCLOSED_RECOVER_FEE` フェンス)。

### §13.1 既定 (現状 = inert・ロールバック先)
- `NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE` / `NEXT_PUBLIC_ENABLE_REGISTER_FEE` 既定 **OFF**。
  OFF では CheckoutForm が feeKind を分割せず、relay route が feeKind を無視 (従来 recover に倒す)、
  MobileOrderView / RegisterMode が feeKind を URL に付けない = **完全 inert (本番挙動不変)**。
- **この OFF の組み合わせが安全状態であり、ロールバック先でもある**。

### §13.2 go-live 手順 (順序厳守)
1. **先に testnet 実機 E2E (必須・§13.4)**。通すまで mainnet 点灯しない。
   ⚠️ 本機能の on-chain settle は単体/統合テストでは forwarderRecover を **mock** しており**未実証**。
   settle 機構は LIVE の recover (Polygon/Kaia/Avalanche 本番稼働) と同一だが、feeKind を nonce に
   コミットした実 settle はこの手順が初回。
2. **開示の同梱** (法務本文は条件付きでマージ済・施行日 2026-06-17):
   - モバイル注文 fee 点灯時は `lib/news.ts` にお知らせ (モバイル注文システム利用料・店頭 1% / 事前 3%)
     を**同一リリースで追加** (flag OFF 中は未提供機能の告知になるため未追加が正・点灯と同梱が正)。
   - レジ fee は `RECOVER_FEE_BPS` の既存スケジュール + 「standard=無料」への carve-in (マージ済) に追従。
3. `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` に実受領アドレスが設定済か確認 (mainnet 未設定は build throw)。
4. **モバイル注文の対象 chain に forwarder が設定済か確認** (`NEXT_PUBLIC_JPYC_FORWARDER_<CHAIN>`)。
   未設定 chain で mobile fee を点灯すると free 経路となり hook が `mobile_fee_requires_recover` を
   throw → standard fallback (mobile fee は recover 経路必須・素通りはしない)。
5. フラグ点灯 (NEXT_PUBLIC_* は build-time inline → **再デプロイ必須**):
   - モバイル注文公開: `NEXT_PUBLIC_ENABLE_MOBILE_ORDER=1` + `NEXT_PUBLIC_ENABLE_ORDER_RELAY=1`
     (受注が店主へ届く・KV 必須 §11) + `NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE=1`。
   - レジ利用料: `NEXT_PUBLIC_ENABLE_REGISTER_FEE=1` + (7 月から) `RECOVER_FEE_BPS=100`。
     ⚠️ `RECOVER_FEE_BPS` は決済QR / relay の既存 recover 利用料と**共有**。7 月前は 0 = フラグ ON でも
     レジ standard は無料。変更は開示済数値の変更 → legal フェンス (`DISCLOSED_RECOVER_FEE`) 確認必須。

### §13.3 ロールバック (安全状態へ即復帰)
- **最速 (課金全停止)**: 該当 flag を `0` に戻して再デプロイ → feeKind が付かず/無視され完全 inert。
- **レジだけ止める**: `NEXT_PUBLIC_ENABLE_REGISTER_FEE=0` (RECOVER_FEE_BPS を 0 にすると決済QR/relay の
  recover 利用料も全部 0 になるので注意)。
- **コード巻き戻し**: 該当 commit を `git revert` (本機能は 9027b9c / 507e96c + 硬化 37dff56〜88c9036)。
- ※ NEXT_PUBLIC_* は build-time inline のため env 変更には再デプロイが要る (Vercel)。

### §13.4 testnet 実機 E2E (リリース前必須・未自動化の唯一の経路)
flag ON + forwarder 設定済の testnet (Amoy / Fuji / Kairos) で実 settle を確認する。route テストは
forwarderRecover を mock しているため、**実 on-chain 分割の実証はこの手順のみ**:
1. **モバイル 店頭 (storefront・店舗負担)**: 注文 → 顧客は原価のみ支払い → settle で merchant = 原価−1%・
   `FEE_RECEIVER` = 1% が同一 tx で着金することを explorer で確認。履歴/CSV が feeAmount (システム利用料) 記帳。
2. **モバイル 事前 (preorder・顧客上乗せ)**: 客の表示総額 = 原価+3% → merchant = 原価満額・`FEE_RECEIVER` = 3%。
3. **モバイル 事前 (preorder・店舗負担)**: 客 = 原価のみ → merchant = 原価−3%・`FEE_RECEIVER` = 3%。
4. **改竄耐性**: 改ざんした feeValue で relay POST → `fee_value_mismatch` で拒否 (server 権威・率は再計算)。
5. **forwarder 未設定 chain**: mobile fee 付き注文 → hook が `mobile_fee_requires_recover` で standard
   fallback (free 経路で素通りしない) を確認。
6. **レジ standard (`RECOVER_FEE_BPS=100` 相当)**: レジ JPYC standard 決済 → merchant = 売上−1%・
   `FEE_RECEIVER` = 1% の 2-tx 分割。relay 経路は既存 recover のまま不変。USDC レジ standard = 0 (対象外)。

### §13.5 監視
- 既存の relay route ログ (`checkout.relay.failed` 等・§3.2) + `components/CheckoutForm.tsx` の
  relay error effect で fee / relay 失敗が Sentry へ届く。fee 固有の専用 metric は現状なし
  (relay tx に相乗り)。点灯直後は `FEE_RECEIVER` の着金 + `checkout.relay.*` を目視。
- 起動時 `relay.jpyc.fee_disclosure_divergence` (recover の env↔開示乖離) は §12 同様 Sentry へ。
  モバイル料率は静的定数で CI フェンス (`tests/lib/mobileOrderFeeDisclosure.test.ts`) が担保するため
  runtime 診断は持たない (env を読む recover 版とは非対称・意図的)。

### §13.6 既知の前提 / 制約 (accepted)
- **standard 経路は client 主導**ゆえサーバ強制が原理的に不可 (feeKind 削除 / 手動 checkout リンクで
  回避余地)。relay は on-chain 強制済。店舗負担ゆえ顧客に剥がす動機なし・店舗の回避はレジ不使用と同等。
- **feeKind 申告で安い kind を主張可** (例: preorder を storefront と詐称)。server は率を**定数表から
  再計算**するため率自体は下げられず、残余は過少徴収のみ (資金毀損なし)。
- 決済QR (`/pay`)・チップ (`/tip`)・USDC・手動 checkout リンクは**対象外** (本機能で不変)。
- 料金性質の弁護士確認は不要 (memory:project_fsa_clearance: % 連動でも資金決済法上の登録不要)・
  税務は別 (税理士)。特商法 / 景表法の開示は条件付き本文 (施行日 2026-06-17) でマージ済。

## §14 x402 facilitator (JPYC 都度課金) go-live SOP

AI エージェント向け x402 (HTTP 402) ファシリテーター + 公開カタログ (discovery)。買い手上乗せ手数料
max(1 JPYC, 1%) を**非カストディ**に forwarder 分割 (seller = 表示額・feeReceiver = 手数料)。settle は LIVE の
recover (`lib/relay/forwarderSettleService`) と同一コアを再利用。詳細は memory:project_x402_facilitator。
料率の真実点は `lib/x402/facilitatorConfig.ts` (legal `DISCLOSED_X402_FEE` フェンス)。対象 chain は
Polygon (mainnet) / Amoy (testnet)。

### §14.1 既定 (現状 = inert・ロールバック先)
- `NEXT_PUBLIC_ENABLE_X402_FACILITATOR` 既定 **OFF**。OFF では全 route (`/api/facilitator/{supported,
  verify,settle,verify-receipt,resources,resources/[id]}` + `/api/discovery` + `/api/paid/{demo,stores}`) が **404 = 完全 inert**。
  X402DiscoveryView もマウントされない。
- **この OFF が安全状態であり、ロールバック先**。

### §14.2 go-live 手順 (server / SDK / MCP の wire rollout 順序は不問)
1. **先に testnet 実機 E2E (必須・§14.4)**。通すまで mainnet 点灯しない。
2. **開示の同梱**: `lib/news.ts` の x402 ファシリテーター手数料お知らせ (施行日 2026-06-28・
   `DISCLOSED_X402_FEE` bps=100 / floor=1 JPYC) がリリースに含まれること。env 料率を変えるなら起動時
   `x402.facilitator.fee_disclosure_divergence` warn が出ないよう本文も改定する。
3. `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` 設定済 (mainnet 未設定は build throw)。手数料の受領先。
4. `X402_PAY_TO_ADDRESS` 設定済。first-party resource (`/api/paid/demo`, `/api/paid/stores`) の seller 受領先。
5. `NEXT_PUBLIC_JPYC_FORWARDER_POLYGON` 設定済 (未設定は readiness 503 `forwarder_unconfigured`)。
6. **専用 receipt 署名鍵**: `X402_RECEIPT_SIGNING_KEY` (server-only・relayer 鍵とは**別の専用鍵**) を投入。
   未設定でも settle は成立するが receipt は null (オフライン検証を提供しない)。公開 signer は
   `/api/facilitator/supported` の `receiptSigner` で配布。
7. **optional reservation / mainnet hardening の前提**:
   - `/verify` の reservation は best-effort。KV が利用可能で記録に成功した場合だけ
     `reservationToken` を追加する。KV 未設定・障害・予約競合でも、従来の verify 成功条件と応答を
     変えず `reservation_unavailable` 等を返さない。
   - `/settle` は予約不在・予約 KV 障害なら従来の冪等・nonce 使用済み検証へ進む。KV 上に既存予約が
     あり、その resource または明示 token が食い違う場合だけ追加防御として拒否する。
   - facilitator server/routes、SDK、MCP の **wire rollout 順序に制約はない**:
     - 新 server + 旧 SDK/MCP: token 無し settle を従来経路で継続する。
     - 旧 server + 新 SDK/MCP: token が返らなくても SDK は従来経路で継続する。
     - 全 component 更新後: token が返った場合だけ facilitator の補助照合も有効になる。
   - npm artifact 作成上は、SDK publish 後に公式 npm registry から
     `packages/x402-mcp/package-lock.json` を再生成し、SDK 0.5.0 entry の `integrity` が入ったことを
     確認して MCP smoke / test を再実行する。これは wire 互換性のための deploy 順序ではない。この
     実装作業では publish しない。
   - 以下は settle を self-host relayer で broadcast する mainnet 固有の従来前提:
     - `RELAYER_PRIVATE_KEY` 設定済 (未設定は `PROVIDER!=self-host` → settle 503
       `relay_not_configured`)。
     - `RELAY_MAX_GAS_COST_WEI` (Polygon native gas 上限・wei) 設定済。未設定 (=0) は settle 503
       `gas_ceiling_required` で**意図的に止まる** (赤字 broadcast 防止)。値は §9.5 同様の実測ベースで調整。
     - KV (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) 設定済。mainnet settle の既存冪等 claim が
       fail-open になると二重 submit しうるため、未設定は従来どおり 503 `kv_required`。
8. フラグ点灯 (NEXT_PUBLIC_* は build-time inline → **再デプロイ必須**):
   `NEXT_PUBLIC_ENABLE_X402_FACILITATOR=1`。必要なら運営自身の resource を SIWE で seed 登録 (空カタログ回避)。

### §14.3 ロールバック (安全状態へ即復帰)
- **最速 (全停止)**: `NEXT_PUBLIC_ENABLE_X402_FACILITATOR=0` + 再デプロイ → 全 route 404 = 完全 inert。
- **settle だけ止める (登録/閲覧は残す)**: `RELAYER_PRIVATE_KEY` を外す → settle 503 `relay_not_configured`
  (verify / discovery / resources は生存)。
- **コード巻き戻し**: x402 facilitator の commit を `git revert` (PR 列は memory:project_x402_facilitator)。
- ※ NEXT_PUBLIC_* は build-time inline のため env 変更には再デプロイが要る (Vercel)。

### §14.4 testnet 実機 E2E (リリース前必須・未自動化の唯一の経路)
flag ON + forwarder/JPYC 設定済の Amoy (80002) で 1 周する。route テストは settleViaForwarder を実コアで
回すが (poll/submit を mock)、**実 on-chain broadcast はこの手順のみ**:
1. **登録**: SIWE サインイン → `/discovery` で resource 登録 (POST /api/facilitator/resources) → 201 +
   paywallSnippet。公開カタログ (`/api/discovery`) に accepts (fee 込み) 付きで現れる。
   first-party resource (`/api/paid/demo`, `/api/paid/stores`) が `/api/discovery` の先頭に並ぶことも確認。
2. **verify**: 正しい署名 → 常に従来どおり `isValid:true`。KV 正常時は `reservationToken` が追加され、
   KV 未設定・障害時も reservation 系エラーにならないこと。改竄 feeValue →
   `fee_value_mismatch` (broadcast せず)。SDK の同一 gate instance では同じ authorization の並列
   verify が一件だけ settlement capability を得ること。
3. **settle**: token あり・なしの両方が従来の settle core へ進み、既存予約との resource/token
   不一致だけが 409 `reservation_invalid` になること。実 settle → 成功 tx を explorer で確認。
   merchant = 表示額・`FEE_RECEIVER` = 手数料 (max(2,1%)) が同一 tx で着金。
   `recordSettlement` が会計記録。
4. **receipt**: settle 応答の receipt を `/api/facilitator/verify-receipt` で検証 → `valid:true`・
   signer = `/supported` の receiptSigner。
5. **first-party demo**: `scripts/x402-buyer-example.mjs` を `BUYER_PRIVATE_KEY=... RESOURCE_URL=https://open-pay.jp/api/paid/demo node ...`
   で実行し、1 JPYC + 手数料 1 JPYC の unlock と `X-PAYMENT-RESPONSE` を確認。
6. **モデレーション**: 無料公開 URL を登録 → 400 `resource_not_gated`。正当性表明なし → `attestation_required`。
7. **owner-auth**: 他人の resource を PATCH/DELETE → 403。
   ※ Amoy 1 周は本リリース準備中に実施済 (register→discover→settle→receipt verify)。点灯前に再確認。

### §14.5 監視
- settle / 登録系の障害は `x402.facilitator.*` (16 イベント: `gas_ceiling_required` / `kv_required` /
  `reverted` / `pending` / `relay_error` / `settlement_record_failed` / `resource_{list,count,create,
  update,deactivate}_failed` / `resource_not_gated` 等) として logger 経由で Sentry へ。discovery は
  `x402.discovery.requirements_failed`。Sentry alert rule を §11.3 に追加すること。
- 起動時 `x402.facilitator.fee_disclosure_divergence` (env 料率 ↔ 開示乖離) を Sentry で監視。
- 点灯直後は `FEE_RECEIVER` の着金 + settle tx + 上記イベントを目視。
- 負荷: `/api/discovery` は §11.6 load-test mix に含む (`x402-discovery` シナリオ)。discovery は edge キャッシュ
  (`Cache-Control: s-maxage=10, stale-while-revalidate=30`) + `resolveIds` 有界並列 (同時 25) のため、
  カタログ増でも 1 リクエスト当たりの KV ファンアウトは有界。

### §14.6 既知の前提 / 制約 (accepted)
- **resource server は加盟店が自前で 402 ゲートする前提**。facilitator はリソースを proxy / ゲートしない
  (verify / settle / discovery のみ)。登録時に正当性表明 (権利 + ゲート実装) を必須化し、無料公開 URL を
  probe で弾く (moderation・SSRF 多層防御済) が、ゲート実装の最終責任は登録者。
- **手数料は買い手上乗せ**ゆえ seller は表示額を満額受領。料率 (bps/floor) の変更は開示済数値の変更 →
  legal フェンス (`DISCLOSED_X402_FEE`) 確認 + 本文改定が必須。
- discovery は edge キャッシュで最大 ~10 秒の鮮度ラグ (新規登録 / 無効化の反映遅延)。soft-delete 済 resource が
  最大 TTL 間カタログに残りうるが、settle は `resource.active` に依存しない (支払い自体は有効) ため資金毀損なし。
- `listResourcesForMerchant` (owner 一覧) は有界並列 (同時 25) で取得。1 件でも KV 取得失敗なら null →
  GET 503 (outage 中に「登録ゼロ」と誤表示して重複登録させない)。
- 料金性質の登録不要は memory:project_fsa_clearance (金融庁回答)・税務は別 (税理士)。
- **KV 未設定 = vanilla USDC の二重解錠防御 (resource 束縛 claim) が OFF になる (fail-open・warn 1 回)**。
  未設定時は `x402.vanilla.claim_unconfigured` をプロセス 1 回だけ warn し、同一 authorization の
  別 resource 同時再利用 (同額の組) を弾けない。課金は settle の原子性で 1 回のままだが、
  コンテンツは複数解錠されうる。`KV_REST_API_URL` / `KV_REST_API_TOKEN` を必ず設定する。

### §14.7 エージェント注文 (agent-order) の運用注記
- **範囲**: `@handle` 店舗のモバイルオーダーを openpay-x402-mcp から x402 で支払う。新レールは作らず、
  支払いは §14 の facilitator (forwarder-split・買い手上乗せ 1%)、受注登録は §15.x の受注リレー
  (`/api/order/notify`・on-chain 検証込み) を **そのまま再利用** する (`/api/agent-order/{menu,pay}`)。計画: `plans/agent-order-x402.md`。
- **フラグ (server-only・AND ゲート)**: `ENABLE_AGENT_ORDER` (NEXT_PUBLIC を付けない) + `NEXT_PUBLIC_ENABLE_X402_FACILITATOR`
  + `NEXT_PUBLIC_ENABLE_ORDER_RELAY` の 3 つが全 ON でなければ全 route 404。**既定 OFF = 完全 inert がロールバック先**。
  点灯順序は先に facilitator (§14) + 受注リレー (§15.x) を go-live 済みにしてから最後に `ENABLE_AGENT_ORDER=1`。
- **権威**: 金額は **サーバーが menu から再計算** (顧客申告額は使わない)・受取先は `record.config.to` (@handle 権威)・
  対象 chain は storefront.chain の deployment (forwarder 未設定チェーンは 422 `unsupported_chain`)。options 付き商品は v1 非対応 (`item_has_options`)。
- **隔離 (掟13)**: settle 成功後の受注登録 (notify) 失敗は決済成功を巻き込まない → 200 + `orderRegistered:false` + `txHash` を返す
  (店主は履歴/txHash で追える)。notify は txHash 冪等ゆえ二重登録は既存機構で防がれる。
- **go-live 前 E2E**: 自店舗 (@handle・storefront 設定済み) に対し testnet で `order_menu` → `order_quote` → `x402_pay` を実行し、
  店主の受注画面に注文が届くことを確認する。MCP の `MAX_PER_CALL_JPYC` は既定 10 JPYC で注文合計を超えやすいので引き上げる。

## §15 Web Push 着金通知 go-live SOP

決済/受注の成功を店主端末に Web Push で届ける (`/history` の PushNotifyPanel + 素の `public/sw.js`)。
VAPID 秘密鍵/subject は `lib/push/server.ts` (server-only) に閉じ、client には公開鍵と flag のみ。金額は
opt-in (既定 OFF)。詳細は plans/a2hs-retention-roadmap.md Phase 2・memory:project は A2HS ロードマップ。

### §15.1 既定 (現状 = inert・ロールバック先)
- `NEXT_PUBLIC_ENABLE_PUSH_NOTIFY` 既定 **OFF**。OFF では `/api/push/subscribe` が **404**・PushNotifyPanel は
  **null (完全 inert)**・relay/order の `after()` push トリガも張られない。
- **この OFF が安全状態であり、ロールバック先**。

### §15.2 go-live 手順 (順序厳守)
1. **VAPID 鍵ペア生成**: `npx web-push generate-vapid-keys`。公開鍵 (base64url) / 秘密鍵 (base64url) を得る。
2. env 4 つを設定 (NEXT_PUBLIC_* は build-time inline → **再デプロイ必須**):
   - `NEXT_PUBLIC_PUSH_VAPID_PUBLIC_KEY` = 公開鍵 (client bundle に出る・購読 applicationServerKey)。
   - `PUSH_VAPID_PRIVATE_KEY` = 秘密鍵 (**server-only**・絶対に NEXT_PUBLIC を付けない)。
   - `PUSH_VAPID_SUBJECT` = `mailto:ops@…` 等の連絡先 (VAPID 仕様の subject)。
   - `NEXT_PUBLIC_ENABLE_PUSH_NOTIFY=1` (最後に点灯)。
   - ⚠️ **公開鍵/秘密鍵は同一ペア**であること。ずれると全 endpoint が送信失敗 → prune される。
3. KV (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) 設定済 (購読は `push:subs:{wallet}` に保存)。
4. **iOS は A2HS 済 PWA のみ push 可**。iOS Safari 通常タブでは PushNotifyPanel は購読 UI を出さず A2HS
   hint に誘導する (仕様どおり・要ホーム画面追加)。
5. `.env.local.example` 同期を確認 (ドリフト厳禁)。

### §15.3 ロールバック (安全状態へ即復帰)
- **最速 (全停止)**: `NEXT_PUBLIC_ENABLE_PUSH_NOTIFY=0` + 再デプロイ → `/api/push/*` 404・panel 非表示・
  トリガ不発。既存購読レコードは KV TTL (90 日) で自然失効 (手動 flush 不要)。
- ※ NEXT_PUBLIC_* は build-time inline のため env 変更には再デプロイが要る (Vercel)。

### §15.4 VAPID 鍵ローテ手順
1. 新 VAPID ペアを生成し `NEXT_PUBLIC_PUSH_VAPID_PUBLIC_KEY` / `PUSH_VAPID_PRIVATE_KEY` を差替え → 再デプロイ。
2. 旧鍵で暗号化された既存購読 (`vapidKeyId` が旧公開鍵ハッシュ) への送信は **失敗 → 404/410 で自動 prune**
   される (`lib/push/server.ts` の pruned 経路)。運営側の手動削除は不要。
3. 利用者は `/history` で **再購読が必要** (旧 subscription は無効化されるため)。panel の「通知を有効にする」を
   再度押すと新鍵で購読し直す。移行期間中の二重運用 (旧鍵での送信継続) はしない設計。

### §15.5 監視
- 送信/購読/設定の障害は logger 経由で Sentry へ:
  - `push.send_failed` (endpoint 個別の送信失敗・endpoint は hash のみ)・`push.notify_failed`
    (トリガ処理の例外)・`push.vapid_misconfigured` (鍵/subject 未設定で送信 skip)。
  - 補助: `push.subscriptions_read_failed` / `push.notify_*` (pending/coalesce の KV 障害)。
- 点灯直後は実 payment を 1 件流し、店主端末で通知が届くこと + 上記イベントが無出力なことを目視。
- **push 失敗は決済/受注を rollback しない** (契約)。通知が届かなくても着金・受注は成立する。

### §15.6 既知の前提 / 制約 (accepted)
- payload 既定は「着金がありました」(金額なし)。金額表示は購読ごとの opt-in (`includeAmount`) で、ON の
  購読にだけロック画面に売上額を出す。payer / wallet / txHash / 注文 items は payload に入れない。
- wallet 単位 coalescing (1 分 1 通 + 「新着 n 件」集約)。金額ラベルは coalesce の NX 勝者 (単一 count===1)
  イベントのみ表示 — n>=2 は件数のみで金額は合算しない。
- 購読は 1 wallet 最大 5 台 (oldest prune)・TTL 90 日 (送信成功で更新)・404/410 で即削除。
- **ブラウザ内の FCM 購読→受信は自動 E2E 不可** (2026-07-03 testnet E2E で確定): Playwright 同梱
  Chromium は FCM API キー非搭載、自動化起動の実 Chrome (`channel:'chrome'`) も push service 登録を
  `AbortError: Registration failed - permission denied` で拒否する (permissions granted でも)。
  自動検証済みの範囲 = SIWE 認証チェーン・実 Amoy recover 決済 (成功ブランチ=after() トリガ通過・
  tx 0x507fe0…84ad)・fee 権威 mismatch 拒否・購読パネル全ゲート実描画・購読 API/store/送信/prune/
  coalesce (unit+API 38 件)。**残る最終リンク (購読→通知受信) は点灯後に実機 smoke で確認する**:
  スマホ Chrome (or A2HS 済み PWA) で /history → SIWE サインイン → 通知を有効にする → 別端末から
  少額テスト着金 → 通知受信 (~5 分)。iOS は A2HS 済み PWA のみ受信可の点も同時に確認。

圏外の屋台/イベント/地下で、店主が「前回の受け取り QR」を提示できる (お支払いは顧客側の回線で行う・
店側は提示のみ)。SW の fetch 拡張は **enable マーカー方式**で gating し、push だけ使う利用者・flag OFF には
一切介入しない (計画 plans/a2hs-retention-roadmap.md Phase 4)。

- **既定 (現状 = inert・ロールバック先)**: `NEXT_PUBLIC_ENABLE_OFFLINE_QR` 既定 **OFF**。OFF では
  Cache Storage に enable マーカーが無く SW の fetch handler は **全リクエストを素通し** (respondWith しない)・
  `OfflineLastQr` は描画されず・`offline.html` も使われない。**この OFF が安全状態でありロールバック先**。
- **fetch 介入は 3 パターンのみ** (それ以外は絶対に respondWith しない): ①同一オリジン `GET /_next/static/*`
  = cache-first (immutable・上限 60 entries)・②`mode==='navigate'` かつ `/{ja|en}/create` = network-first→cache→
  `offline.html`・③②のフォールバック `public/offline.html` (install 時 precache・ja/en 併記)。**API/POST/
  クロスオリジン・`/pay`・`/scan`・`/checkout` 等の決済経路には一切触れない** (narrow 規則の SoT は
  `lib/offlineSwRoutes.ts`・`tests/lib/offlineSwRoutes.test.ts` が担保)。
- **go-live 手順**: (1) 本番 flag ON でデプロイ。(2) `next build && start` (flag ON) で /create を prime →
  `context.setOffline(true)` → reload で cached /create または offline.html が出て、OfflineLastQr に前回 QR が
  端末内描画されることを実機確認 (この検証は呼び出し元 Fable が prod build で行う。CI e2e は flag OFF 環境ゆえ
  対象外)。(3) `/pay`・`/scan`・`/checkout` を圏外で開いても **決済系には介入しない** (ブラウザ既定エラー) ことを確認。
- **ロールバック**: flag を **OFF** に戻す → 次の /create 訪問で `openpay:offline-disable` メッセージが marker を
  削除し fetch 介入が即停止する。SW を更新デプロイすれば fetch handler は marker 不在で恒久的に no-op 化する。
  push 購読 (§15.1–§15.6) はこの flag と独立で影響を受けない (同一 `sw.js` だが push/notificationclick は不変)。

## §16 クリエイター・デジタルストア go-live SOP

前提: #295-#301 + settle gate PR が main に merge 済み。単一情報源 = `plans/creator-store-v3.md`
(v4 実装契約 A-J)。**flag は 2 系統・既定 OFF** で全 surface が 404/非表示。

### 16.1 flag 構成

| env | 種別 | 効果 |
| --- | --- | --- |
| `ENABLE_CREATOR_STORE` | **server-only** | 出品 CRUD (`/api/store/products`・`/api/store/seller`)・hosted paid route (`/api/paid/hosted/[id]`)・購入 status (`/api/store/purchase/status`)・library/content API・reconcile cron の全 server surface |
| `NEXT_PUBLIC_ENABLE_CREATOR_STORE` | client | /create 管理セクション・@handle「販売中」節・/store/library ページ・WalletBadge の SIWE 導線 |

点灯は **両方 '1'** (server だけ ON = UI 不在で不到達・client だけ ON = API 404 で全操作失敗)。

### 16.2 点灯前チェック (順に)

1. **settle gate PR が merge 済みであること** (点灯前 blocker ①)。`lib/x402/purchaseSettleGate.ts` が
   存在し、`/api/facilitator/settle`・`/api/relay/jpyc` の両方に配線されていること。
2. `vercel.json` の cron `/api/cron/store-reconcile` (0 21 * * * = 日次バックストップ。Hobby プランは
   日次粒度のみ。**買い手のリアルタイム収束は status route の自動 polling が担う** — cron は放置
   セッションの掃除役)。`CRON_SECRET` が Vercel に設定済みであること (reverify と共用)。
3. **開示 3 点セット (掟 14)**: 点灯リリースと同一 deploy で ①LP (デジタル商品販売の言及) ②法務は
   #298 で反映済み (Terms 13 条・特商法・Privacy — 施行日 2026-07-30) ③`public/llms.txt` に
   hosted store (商品は OpenPay が本文保管・買い手手数料 x402 max(1 JPYC,1%)・売り手手数料なし) を
   追記。③はテストフェンスが無いので目視必須。
4. 残 blocker の裁定記録: ②forwarder rotation 後の旧 tuple settle (rotation 実施時まで inert・
   deploymentVersion 保存済み) ④content purge×pending intent 協調 (現状 = 署名前 content 実在
   確認 + settle 前 content_unavailable 409 + 所有者への「提供終了」表示 + Terms 13(7) 救済分離)。
5. **testnet (Amoy) E2E**: 出品 (販売者情報→商品作成→販売開始) → @handle 販売中節に表示 →
   購入 (402→最終確認→署名→settle→ライブラリ) → content 表示 → 二重購入で冪等 →
   販売停止で新規購入 404・既購入者は取得可、を一巡。
6. 掟 15: 上記すべての後、**user の明示 go 判断**で Vercel env を設定し redeploy。

### 16.3 ロールバック

両 flag を OFF → 全 surface 404/非表示。**進行中 intent は KV に残り無害** (settled は恒久・
pending は cron/status が止まるだけで、再点灯後に reconciler が同じ entitlement へ収束させる)。
署名済み authorization は validBefore (quote 期限 ≤10 分) で自然失効し、settle gate が
汎用入口からの持ち込みを拒否する。
