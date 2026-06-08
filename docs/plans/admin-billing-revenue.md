# 計画: OpenPay 利用料の admin 収益ビュー (弊社専用) + 支払い確認 + freee CSV

> ステータス: **✅ 実装済 (Phase1+2・2026-06-09)**。全 3959 test green・typecheck/lint pass。残=ADMIN_WALLETS 本番設定[user]。2026-06-09 起案。a1 OpenPay 利用料 ([[merchant-gasless-fee-a1]]) の
> 運営側 (OpenPay 自社) 向け収益管理。ユーザ要件: 「利用料収益を確認・CSVをfreeeへインポート・弊社だけ見れる
> admin・支払いがちゃんとされたか確認」。
>
> **確定事項 (ユーザ決定 2026-06-09)**: 認証=**SIWE-admin** / スコープ=**Phase1+2 まとめて** (照合・店主索引含む) /
> 収益認識=**入金日基準** (清算日)。
> **CSV の位置づけ (ユーザ確定 2026-06-09)**: 「**収入があった事実がわかる基本データ**」で十分。**税理士に丸投げ**して
> 確認してもらう前提 (JPYC=暗号資産の扱いが初めてのため)。→ **当社で freee の勘定科目/税区分/時価評価を推定しない**。
> CSV は**1入金=1行の生データ** (入金日・金額JPYC・円換算(1:1)・店主アドレス・対象期間・txHash・chain・explorer URL) を
> 完全に出す。freee 取込互換のヘッダにはするが、**税区分は「対象外/未設定」デフォルト**にして取込時に税理士が設定する
> (誤った課税区分を埋め込まない=安全)。`ADMIN_WALLETS`=**env で後日設定** (空=全拒否)。

## (1) 目標 — 何を・なぜ

弊社 (OpenPay 運営) が a1 利用料の**収益を把握し、自社会計 (freee) に入れる**ための admin 専用ビュー。

- **収益確認**: 期間別・合計の利用料収入を一覧。
- **支払い確認 (照合)**: 「誰がいくら請求され、誰が払ったか／未払いか」を期間ごとに突き合わせ (reconciliation)。
  各入金は txHash + explorer リンクで個別に確認可能。
- **収入の基本データ CSV**: 「収入があった事実」がわかる生データ (入金日/金額/店主/txHash 等) をダウンロード。
  税理士へ渡して会計処理してもらう前提 (当社は科目/税区分を推定しない)。freee 取込にも使える形にはする。
- **弊社だけ**: SIWE で接続したウォレットが **admin 許可リスト**に載っている場合のみ閲覧可。

**なぜ**: a1 は店主課金の仕組みは作ったが、**運営側が「いくら入ったか・取りこぼしがないか・会計にどう入れるか」を見る術が無い**。
go-live して実際に徴収が始まると、自社の売上計上・残高照合・未収管理が必要になる。

## (2) 制約・依存・エッジケース

**データモデルの現状ギャップ (最重要)**:
- **収益台帳が無い**: `app/api/billing/settle` は検証→`grantFeeCurrent`→ロック昇格までで、**支払い額/txHash を集計可能な形で残していない**。
  → settle 成功時に**収益台帳へ追記**する必要 (新規)。
- **期間内の店主を列挙する索引が無い**: メーターkeyは `meter:{period}:{merchant}` 単位。`lib/kv.ts` は **list/string/incr のみ**で
  **SCAN/KEYS/SMEMBERS が無い**。→「請求したが未払いの店主」を出すには**店主索引を自前で持つ**必要 (新規・relay hot-path に影響)。

**依存**:
- `app/api/auth/siwe/_session.ts` `requireSession()` (SIWE)。
- `lib/billingMeter.ts` (出来高=請求の基礎)・`lib/usageFee.ts` (料率→請求額)・`lib/feeCurrent.ts` (支払い済み判定)・
  `lib/feeGate.ts` (previousPeriod 等)。
- `lib/csv.ts` (CSV エスケープ・BOM)・`lib/accountingCsv.ts` の freee 行イメージ (流用せず参考)。
- 既存 admin パターン: `app/api/log/payment/export` (Bearer) — 今回は SIWE-admin に置換。

**エッジケース**:
- **二重計上防止**: replay (同 txHash 再POST) で収益台帳に二重追記しない → settle の**初回成功時のみ**追記
  (idempotency claim が `OK` を返した経路の中で1回)。
- **台帳書込失敗は決済を壊さない**: 支払いは既に on-chain 検証+付与済み。収益台帳は**レポート用 (source of truth でない)**
  ので、LPUSH 失敗は warn して続行 (admin 表示が undercount = 正直・店主体験は無傷)。真実は on-chain + fee-current。
- **金額**: `invoice.feeWei` (請求額) を記録。on-chain は `≥ minValue` を許すが UI は exact 送金。過払い時は台帳=請求額で
  実入金と僅差になりうる (注記)。
- **複数チェーン**: Polygon / Kaia で支払われうる → `chainId` を記録し合算。
- **JPYC = JPY 1:1・decimals 18** → CSV 金額 = feeWei / 1e18 (整数 JPYC)。
- **admin 許可リスト空 = 全拒否** (fail-closed)。未設定で「全員 admin」は厳禁。
- **a1 は flag OFF**: 現状 収益ゼロ。本機能は **go-live 準備**。過去分の遡及は無い (台帳はこの機能以降のみ)。

## (3) 既存パターン・API・ライブラリ (流用)

| 用途 | 流用先 |
|---|---|
| SIWE セッション | `requireSession()` → `{ok, address}` |
| 請求額の算出 | `loadUsageInvoice(period, merchant)` (出来高×料率・単一ソース) |
| 支払い済み判定 | `getFeeStatus`/`isFeeCurrent` (`lib/feeCurrent`) |
| 前月/期間 | `previousPeriod`/`meterPeriod` (`lib/feeGate`/`lib/billingMeter`) |
| CSV 整形 | `lib/csv.ts` (エスケープ + UTF-8 BOM) |
| freee 行イメージ | `lib/accountingCsv.ts` の `freeeRows` を**参考**に専用関数を新規 |
| KV | `kvLpush/kvLrange/kvLtrim/kvLlen/kvSet(nx)/kvGet` |
| admin 認証の前例 | `/api/log/payment/export` (Bearer) → 今回 SIWE-admin に置換 |

## (4) アーキテクチャ & データフロー

### 新データ構造 (KV)
1. **収益台帳** `billing:revenue` (単一グローバル list・LTRIM cap=5000)
   - settle 成功時に LPUSH: `{merchant, period(請求対象), feeWei, txHash, chainId, paidAtMs}`
   - 低頻度 (店主×月1) なので 5000 件で数年分。admin は全件読み→期間/月で集計。
2. **店主索引 (照合用・任意=Phase2)** `billing:merchants:{period}`
   - `recordRelayedVolume` で、その (period, merchant) 初回のみ LPUSH (nx guard `billing:midx:{period}:{merchant}` で重複抑止)。
   - relay hot-path に **nx 1回**追加 (毎回 push しない)。これが「請求したのに未払い」を出す前提。

### フロー
```
[徴収] 店主 settle 成功
  └→ (既存) verify→grantFeeCurrent→promote
  └→ (新規) recordFeeRevenue(): billing:revenue へ LPUSH (try/catch・初回のみ)

[計上記録] relay 成功 (既存 recordRelayedVolume)
  └→ (新規・Phase2) 初回のみ billing:merchants:{period} へ店主追加

[admin 閲覧] 弊社が /admin/billing をSIWE
  └→ isAdminWallet(session.address) ? : 403
  └→ GET /api/admin/billing/revenue
       ├ collected: billing:revenue 集計 (合計・期間別・入金一覧 + explorer link)
       └ (Phase2) reconciliation: 期間ごと billing:merchants:{period} を列挙し、
          各店主の loadUsageInvoice (請求額) × fee-current/台帳 (支払い済みか) を突合 → 未払い一覧
  └→ CSV: GET /api/admin/billing/revenue?format=freee → 利用料収入の freee 取引(収入) CSV
```

### 認証 (SIWE-admin)
- env `ADMIN_WALLETS` = カンマ区切り小文字アドレス (既定空=全拒否)。`lib/adminAuth.ts` `isAdminWallet(addr)`。
- `/api/admin/*` は `requireSession()` + `isAdminWallet` の二段。`/admin/billing` ページも同条件で gate (非adminは「権限なし」)。

### 新規ファイル (見込み)
- `lib/feeRevenue.ts` (台帳 record/read/集計 + reconciliation 純ロジック)
- `lib/feeRevenueCsv.ts` (freee 収入CSV・`lib/csv` 流用)
- `lib/adminAuth.ts` (`isAdminWallet`)
- `app/api/admin/billing/revenue/route.ts` (GET・JSON + ?format=freee)
- `app/[locale]/admin/billing/page.tsx` + `components/AdminBillingView.tsx` (SIWE-admin gate・ダッシュボード + CSV DL)
- settle route + `recordRelayedVolume` に追記フック
- env: `ADMIN_WALLETS` / i18n `AdminBilling` namespace (ja/en) / tests / `.env.local.example`

## (5) 不明点・リスク (要ユーザ確認)

**要確認 (会計・御社判断)**:
1. **freee の勘定科目・税区分**: 利用料収入を入れる科目 (売上高? 雑収入?) と税区分。**JPYC=暗号資産の収入の消費税・
   期末時価評価**は税理士確認事項。CSV は「行は出すが科目/税区分は取込時に再マッピング」デフォルトでよいか。
2. **収益認識のタイミング**: CSV を **入金日基準** (清算日) で切る、でよいか (vs サービス提供月基準)。
3. **「支払い確認」の範囲**: (a) **入金済みの一覧+合計**だけで十分か / (b) **未払い店主の照合**まで要るか
   (= relay hot-path に店主索引追加。Phase2)。
4. **ADMIN_WALLETS**: 弊社の管理者ウォレットアドレス (複数可)。

**リスク**:
- admin 許可リスト誤設定 → fail-closed (空=全拒否) で握る。
- 台帳はこの機能以降の支払いのみ (a1 未 live なので実害なし)。
- 店主索引は relay hot-path に nx 1回追加 (Phase2 採用時のみ)。
- crypto 収入の会計/税務は本 CSV では保証しない (利便ツール・専門家確認前提)。

## 実装ステップ案 (確認後)
- **Phase 1 (収益確認 + CSV)**: 台帳記録(settle) + `lib/feeRevenue`/`feeRevenueCsv` + `adminAuth` + admin API + admin ページ
  (collected のみ) + env + i18n + tests。← ユーザの中核要望を満たす最小。
- **Phase 2 (支払い照合)**: 店主索引(relay) + reconciliation (請求 vs 入金 vs 未払い) を admin に追加。←「支払いされたか確認」の完全版。

→ **Phase 1+2 まとめてやるか、Phase 1 先行か**も確認したい (索引は hot-path に触るため)。
