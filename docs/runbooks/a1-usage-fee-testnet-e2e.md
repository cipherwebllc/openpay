# a1 OpenPay 利用料 — testnet 実機 E2E runbook

> 目的: 本番点灯前の必須ゲート (#297)。ユニット/統合テスト (4001件) は **KV を in-memory fake・on-chain 照合を
> モック**しているため、**実 Upstash KV / 実 on-chain 検証 / 実ウォレット署名→relay broadcast / Vercel serverless
> での `await` 完了** は未実証。これを Amoy (Polygon testnet・chainId 80002) で実機確認する。
> 設計: docs/plans/merchant-gasless-fee-a1.md。

---

## 用意するもの

- **2 ウォレット**: `CUSTOMER`(顧客・店舗へ支払う) / `MERCHANT`(店主・受取＋利用料を払う＋SIWE)。両方 MetaMask 等。
- **testnet JPYC** (Amoy): CUSTOMER に決済額分、MERCHANT に利用料分 (≥ 100 JPYC 程度)。※既存 Amoy E2E と同じ供給元。
- **testnet POL** (Amoy): **RELAYER** ウォレットに数 POL (relayer が顧客決済と利用料の両方を gasless broadcast するガス)。
- **testnet 専用 Upstash KV** (本番 KV とは必ず別)。
- デプロイ先: Vercel preview か `npm run dev` (ローカルでも relay/KV は実物に繋ぐ)。

## env (testnet・**a1 = free モード固定**)

```
NEXT_PUBLIC_ENABLE_USAGE_FEE=1   # ★a1 専用フラグ。旧 CSV ゲートの NEXT_PUBLIC_ENABLE_BILLING とは別物。a1 だけ点灯するならこちらを 1・ENABLE_BILLING は 0 のまま (両方 1 にすると CSV年額 4,980 と二重課金)
ALPHA_ENTITLEMENT_BYPASS=0
OPENPAY_USAGE_FEE_START_PERIOD=2026-05   # ★テスト値。意味=「2026年5月分(=前月)以降が 1% 対象」。
# 【なぜ前月(2026-05)か】清算(Phase3)も関所(Phase5)も必ず【前月】を課金/判定する(後払い=前月分を翌月請求)。
#   今 6月に実行すると前月=2026-05。start を当月 2026-06 にすると前月 2026-05 が「開始前=0%」扱いで、清算は
#   nothingDue・関所は遮断せず → Phase3/5 がテストできない。なので「前月」を指す 2026-05 を入れる(=「前月から課金」と読める)。
#   ※ 別の月に実行するなら「その月の前月」を入れる。迷うなら過去日付 2020-01 (=全期間1%) でも確実に動く(自動テストはこれ)。
# 【本番 go-live では別】本番はここを実際の開始月 2026-07 にする (7月の取引から 1%・8/1 に初回徴収)。テスト専用の値。
OPENPAY_USAGE_FEE_BPS=100                # 1% (既定)
NEXT_PUBLIC_FEE_RECEIVER_ADDRESS=<testnet の OpenPay 受領アドレス>   # burn(0x…dEaD) 以外
RELAYER_PRIVATE_KEY=<testnet relayer 秘密鍵 (POL 保有)>
KV_REST_API_URL=<testnet Upstash URL>
KV_REST_API_TOKEN=<testnet Upstash token>
NEXT_PUBLIC_POLYGON_AMOY_RPC_URL=<Amoy RPC>
# ⚠️ NEXT_PUBLIC_JPYC_FORWARDER_AMOY は **未設定**にする (設定すると recover モードになり a1 と排他)
# BILLING_METER_DISABLED は未設定 (=メーター有効)
```

> Amoy は testnet ゆえ `RELAY_MAX_GAS_COST_WEI` 未設定でも可 (mainnet hardening 対象外)。KV は a1 が必須。

### 当月 / 前月の早見 (これさえ押さえれば下の手順は読み替え不要)

メーターのキーも清算対象も **UTC のカレンダー月** で決まる。手順中の「当月」「前月」は下記に置き換える:

- **いま 2026年6月に実行する場合 → 当月 = `2026-06` / 前月 = `2026-05`** (以下の手順はこの前提で具体値を書いてある)。
- 別の月に実行するなら、ターミナルで算出:
  ```
  node -e "const d=new Date(),p=n=>String(n).padStart(2,'0'),cur=d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1),pm=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),0));console.log('当月',cur,'/ 前月',pm.getUTCFullYear()+'-'+p(pm.getUTCMonth()+1))"
  ```
- `<merchant小文字>` = MERCHANT のウォレットアドレスを**全部小文字**にした文字列 (`0xAbC…` → `0xabc…`)。

---

## Phase 0 — 設定の健全性確認 (電源ランプ確認・10秒)

1. **請求の窓口URLが「点いていて・サインイン必須」かを確認**する。`/api/billing/invoice` は店主 UI が裏で
   呼ぶ「今月の請求を返す窓口」。これを**サインインせず**に開いて、ちゃんと門前払い (401) されればOK。
   - ブラウザ: **シークレットウィンドウ**で `https://<host>/api/billing/invoice` を開く → 短い JSON + **401**。
   - または curl: `curl -i https://<host>/api/billing/invoice` → 1 行目が `HTTP/... 401`。
   - **判定**: `{"ok":false,"error":"unauthenticated"}` (401) =正解 (a1 点灯済・SIWE 必須の証。この文字列は
     フラグ ON のときだけ返る — OFF なら手前で 404 になる)。
     `{"ok":false,"error":"billing_disabled"}` (404) =NG (`NEXT_PUBLIC_ENABLE_USAGE_FEE=1` が未反映・再ビルド漏れ)。
   - ※未ログインで試す理由=「機能が点いてるか」と「他人が請求データを覗けないか」を1回で確認できるため。
2. relay が free モードか: Amoy で forwarder 未設定なら、顧客決済の署名画面が `TransferWithAuthorization`(to=店舗) であること (recover の `ReceiveWithAuthorization`(to=forwarder) でない)。

## Phase 1 — メーター (実 KV LPUSH)

1. CUSTOMER で **/pay** (または /checkout) を開き、MERCHANT 宛に JPYC ガスレス決済 (例 1,000 JPYC・Amoy)。署名のみ。
2. 期待: relay 成功・Amoy explorer に tx・MERCHANT に **全額(1,000)着金**(利用料は引かれない)。
3. **検証 (Upstash console / redis)**: 当月キーに 1 件記録される。
   ```
   LLEN  meter:2026-06:<merchant小文字>      → 1        # 2026-06 = 当月 (6月実行時)
   LRANGE meter:2026-06:<merchant小文字> 0 -1 → {"v":"1000000000000000000000","c":80002,"t":...}
   ```
   (1,000 JPYC = `node -e "console.log((1000n*10n**18n).toString())"`)

## Phase 2 — インボイス (実 KV LRANGE + 料率)

1. MERCHANT で **/billing** を開く → 「サインインして請求を確認」→ SIWE 署名。
2. 期待表示: 「今月これまで: 中継 1 件 / 出来高 1,000 JPYC（確定は翌月）」。前月分(due)は後述のシード次第。
3. **API 検証** (SIWE cookie 必要・devtools の Cookie をコピーして): 
   ```
   curl -s https://<host>/api/billing/invoice -H "cookie: <SIWEセッションcookie>" | jq
   → current.feeWei == 当月出来高 × 1% (1000 → "10000000000000000000")・due は前月
   ```

## Phase 3 — 清算 (実署名→relay→**実 on-chain 照合**→fee-current)

> settle は **サーバが previousPeriod(now)=前月を課金**する。当日テストで「請求あり」を作るには前月キーをシードする
> (実時間で前月に決済しても可だが時間がかかる)。これは testnet の時短手順で、本番挙動ではない。

1. **前月シード** (Upstash console。前月=2026-05・10,000 JPYC → 利用料 100 JPYC。`<merchant小文字>` は MERCHANT アドレスを全部小文字にしたもの):
   ```
   LPUSH meter:2026-05:0xあなたのmerchantアドレス小文字 {"v":"10000000000000000000000","c":80002,"t":1778803200000}
   LPUSH billing:merchants:2026-05 0xあなたのmerchantアドレス小文字
   ```
   (2026-05 = 前月。`v` は 10,000 JPYC = `node -e "console.log((10000n*10n**18n).toString())"`。`t` は参考値で
    計上月には影響しない — 計上月はキーの `2026-05` で決まる。**2 行目の `billing:merchants:2026-05` は admin 照合
    [請求 vs 入金] 用の店主索引** — 実リレーなら自動で入るが、手シード時は手動で入れないと /admin/billing の照合に
    この店主が出ない。収益台帳自体は清算で別途記録されるので 2 行目を忘れても収益額・入金一覧には影響しない。)
2. /billing を再読込 → 「2026-05 分: 1 件 / 10,000 JPYC × 1% / 利用料 **100 JPYC**」+「100 JPYC を支払う」ボタン。
3. ボタン押下 → MERCHANT が **ガスレス署名のみ** (native gas 不要) → relayer が `MERCHANT→FEE_RECEIVER` を broadcast → settle が **実 receipt を照合** → fee-current 付与 → 「お支払いありがとうございます」。
4. **検証**:
   - Amoy explorer に MERCHANT→FEE_RECEIVER の 100 JPYC tx。
   - `GET fee:current:<merchant小文字>` → `{"expiresAt":1783468800000,"lastPaidPeriod":"2026-05","lastTxHash":"0x…"}`
     (`1783468800000` = 前月 2026-05 の 2 か月後の月初 2026-07-01 + 猶予 7 日 = **2026-07-08 00:00 UTC**)。
   - /billing が「お支払い済みです（有効期限 …）」表示。
   - **利用料支払いはメーターに計上されない**: `LLEN meter:2026-06:<feeReceiver小文字>` → 0 (当月キー・FEE_RECEIVER 宛除外)。
   - **収益台帳**: `LLEN billing:revenue` → 1 (settle 成功で 1 件記録)。
5. **admin 収益ビュー検証** (運営側): 別ウォレット (= `ADMIN_WALLETS` に入れた弊社 wallet) を接続し `/admin/billing` を開く →
   SIWE → ダッシュボードに「累計収益 100 JPYC・入金 1 件」、照合に MERCHANT が「**入金済み**」、CSV ダウンロードで
   1 行 (100 JPYC) を確認。非 admin wallet では「権限がありません」。
   ※ env に `ADMIN_WALLETS=<弊社 wallet>` を設定し再起動しておくこと (未設定だと全員 403)。

## Phase 4 — 冪等性 (実 KV nx)

1. **replay**: Phase 3 の txHash で settle を再 POST:
   ```
   curl -s -X POST https://<host>/api/billing/settle -H "cookie: <cookie>" -H "content-type: application/json" \
     -d '{"txHash":"<phase3のtxHash>","chainId":80002}' | jq
   → { ok:true, replay:true, expiresAt:<phase3と同値> }   # 再付与されず満了が動かない
   ```
2. **並行** (任意): 同 txHash で 2 本同時 POST → 片方 200・片方 409(already_processed) か replay・**fee-current は1回のみ**。

## Phase 5 — 関所ゲート (arrears・**未払い遮断**)

> 前提: 当月 **UTC 8日以降** (grace=7日)。1〜7日 UTC は猶予で遮断しない (その場合はこの Phase をスキップ or 待つ)。

1. 別の MERCHANT2 を用意し、**前月キーをシード** (Phase 3 手順1 と同様・MERCHANT2 で) するが **清算しない** (未払い状態)。
2. CUSTOMER から MERCHANT2 宛にガスレス決済を試行 → **402 `fee_required`** で relay 拒否。
3. CUSTOMER 側 UI は standard モード (顧客が自分でガス負担) なら決済可能 = **コアは無料のまま** (関所はガスレスのみ)。
4. MERCHANT2 が /billing で利用料を清算 → fee-current 付与 → 再度ガスレス決済を試行 → **通る**。

## Phase 6 — ロールバック確認 (kill-switch)

各 env を切ってデプロイ → 即 inert になることを確認 (docs/plans/…a1.md「ロールバック手順」):
- `OPENPAY_USAGE_FEE_START_PERIOD` 未設定 → 料率 0% → 請求 0・遮断なし。
- `ALPHA_ENTITLEMENT_BYPASS=1` → 全店 current 扱い・遮断なし・/billing 無料表示。
- `BILLING_METER_DISABLED=1` → 決済しても meter キーが増えない (relay は無影響)。
- `NEXT_PUBLIC_ENABLE_USAGE_FEE=0` (要再ビルド) → /api/billing/* が 404・relay ゲート無効。

---

## 合否チェックリスト

- [ ] P1: 実 gasless 決済で `meter:{当月}:{merchant}` に正しい v/c が LPUSH される (実 Upstash)
- [ ] P2: /billing と /api/billing/invoice が出来高×1% を正しく算出 (実 LRANGE)
- [ ] P3: 利用料をガスレス1署名で払い、**実 on-chain receipt 照合**が通り fee-current が付く・FEE_RECEIVER 宛は非計上
- [ ] P4: 同 txHash 再 POST が replay で満了不変 (実 nx)・並行で二重付与なし
- [ ] P5: 未払い店主のガスレスが 402・standard は通る・清算後に解除 (day>7 UTC)
- [ ] P6: 4 つの kill-switch が即 inert 化

## 落とし穴

- **forwarder env を設定したまま**だと recover モードになり a1 が動かない (利用料支払いの `merchant===feeReceiver` を recover が拒否)。Amoy の forwarder env は**必ず未設定**。
- **KV は testnet 専用** (本番の meter/fee-current と混ぜない)。
- **grace 7日**: 当月 1〜7日 UTC は gate が遮断しない (Phase 5 は 8日以降に)。
- **UTC 期間境界**: 深夜 JST の決済は計上月が前後 (UTC 月初 = JST 9:00 が境界)。
- **relayer POL 残高**: 枯渇すると relay 失敗 (顧客決済・利用料支払いの両方が止まる)。
- これらが通って初めて本番点灯 (mainnet env + S7 開示改訂の同時適用)。

## 本番化 検証状況 (2026-06-09・正直な棚卸し)

a1 は本番 LIVE (env 点灯済) だが、検証の「深さ」は項目で差がある。
**CI/コードレベルで検証済 ✅** と **運用レベルで未確認/要ユーザ確認 ⚠️** を分けて明記する。

### ✅ CI/コードで検証済 (証拠あり)
- 全 3973 vitest green (実コードパス・モックは hook/fetch 境界のみ)。
- 本番ビルド (`npm run build`) 成功・typecheck・lint クリーン。
- `vitest` は devDependencies のみ = 本番バンドル非同梱 (npm audit critical は test 専用)。
- 依存 pin (package-lock) + npm audit 全件 triage (`docs/npm-audit-triage.md`)。
- money-path のエラーは loud (settle は HTTP 4xx/5xx + `billing.*` ログ・meter 失敗は
  非ブロッキングで `billing.meter.record_failed` ログ)。秘密は env 外部化 (.env.local は gitignore)。
- Sentry アラート tag が実 emit 文字列と一致することを source 走査テストで恒久 fence
  (`tests/scripts/setup-sentry-alerts.test.ts`・bad tag 注入で fail することを実証済)。

### ⚠️ 運用レベルで未確認 / 要ユーザ確認 (Claude は権限外)
- **Sentry catch-all アラート「OpenPay billing failures」が enabled で実発火するか** — 未確認
  (test event での発火確認が必要)。per-event script 規則は未実行。
- **本番 env の実値** — `NEXT_PUBLIC_ENABLE_USAGE_FEE=1` / `ALPHA_ENTITLEMENT_BYPASS=0` /
  `OPENPAY_USAGE_FEE_START_PERIOD=2026-07` / `FEE_RECEIVER` 設定 / `NEXT_PUBLIC_NETWORK_ENV=mainnet`
  が実際にセットされているか目視確認。**NETWORK_ENV が unknown だと Sentry アラートが
  別 env を向き監視が静かに無効化する**。
- **Vercel 最新デプロイの green** — ローカル build 成功は確認済だが Vercel 実デプロイは未確認。
- **ロールバック (env-flip → redeploy) の実動** — フラグの存在は確認済だが end-to-end 未実行。

### 🔮 本質的に未証明 (初回まで検証不能)
- **実 mainnet の課金 (settle)** — testnet E2E のみ検証済。7月利用分の初回 settle (8月) が
  実 JPYC で想定通り (検証/付与/収益記録/冪等) 動くかは初回まで未証明。初回だけ実機監視する。
- **想定負荷下の実測性能** — 設計は非ブロッキング + KV bounded (AbortSignal/maxDuration) だが、
  合成ロードテスト基盤は未整備 (将来 k6/autocannon)。
