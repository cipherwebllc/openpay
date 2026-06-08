# (a1) OpenPay 利用料（店主側・月1署名）+ relay 関所ゲート

> Status: **✅ S1〜S9 実装完了 (2026-06-08/09・全 3969 test green・build/lint/typecheck pass・flag OFF で inert)**。
> 残 = Codex review (起動済) + go-live (env 点灯 + S7 開示改訂の同時適用) + testnet 実機 E2E。
> 当初計画: **6月中に S1〜S9 を作り切り + 検証 (flag OFF) → 7月ベータで点灯 (1%) → 8/1 初回徴収** (2026-06-08 ユーザ確定)。
> タイムライン: **6月=アルファ (0%/無料) / 7月=ベータ (1% 課金開始) / 8/1=初回徴収**。flag OFF で実装し、
> tests + Codex + **testnet 実機 E2E** を通してから点灯。「寝かせる」案は traction が遠い前提だったため撤回
> (ベータが来月なので作り切り＋検証が正解・作り込みリスクは締切確定で消滅)。
> 名称: 「ガスレス利用料」でなく **「OpenPay 利用料」** (gasless relay は売り物でなく徴収の関所)。作成 2026-06-08。

## Context — なぜ (a1) か

FSA FinTechサポートデスクが「4登録すべて不要・A/B/C案すべて・署名済tx broadcast 関与でも同様」と回答
([[fsa-clearance]]・2026-06-08) → **手数料徴収もガスレスリレーも法的にクリア**。これを受けユーザが
「周辺だけ課金は理想だが確実に徴収できねば意味がない・コア有料が法的に問題ない以上コア有料で良い」と
**「コア有料」を許容へ方針転換** ([[project_monetization_strategy]])。

徴収設計の検討で確定した原理:
- **価値提供の「後」に請求するもの (月次後払い) は permissionless/非KYC では回避可能** (毎月ウォレットを変えれば
  逃げ得)。塞げない。
- **回避不能なのは「決済の瞬間に取る (per-tx)」だけ**。だが per-tx の atomic split は顧客署名を
  `ReceiveWithAuthorization(to=forwarder)` に変え、**Polygon で Blockaid を誘発**する (Kaia は無風)。
- → per-tx は Polygon で詰む / 月次は Blockaid 安全だが回避可能、という**ジレンマ**。

**(a1) はこのジレンマを解く**: 手数料を「顧客の決済」でなく **「店主」から** 取り、サービス (ガスレスリレー) を
**支払い状態でゲート**する。

- **顧客**: 今まで通り pristine な `transferWithAuthorization(顧客→店舗・正確額)` に 1 署名 → うちがリレー。
  **顧客フロー無改変 = 全チェーンで Blockaid 悪化ゼロ**。店主は 100% 着金。
- **店主**: その期間の利用料を **EIP-3009 で 1 署名** (店主→FEE_RECEIVER・確定額) → うちがガスレスにリレー。
  = JPYC EC「おまかせの月額 署名1回」と同型。**この手数料レグ自体も pristine な単一宛先 transfer = Blockaid 無害**。
- **関所 (teeth)**: 利用料が current な店主だけ、うちが顧客決済をガスレスでリレーする。未払い→ガスレス relay 停止
  (→ standard/自己回収=顧客が自分でガスを払う**無料 tier**に落ちる)。**新ウォレットに変えてもサービスを受けるには
  再び利用料署名が要る = 逃げ得が成立しない (回避耐性)**。

**料金 (確定・2026-06-08 ユーザOK)**: おまかせ/ガスレス = **1%** (月次・出来高連動)。**アルファ 0% → ベータ 1%**。
**基本料は traction 前は ¥0 (純 1%)** — 小規模店を incumbent (JPYC EC おまかせ 2%) より高くしないため。任意で
「月間出来高が閾値未満は無料」(最小店に寛容) は可だが、**最低額 (min fee) は設けない**。**基本料は将来 Pro tier の
付加価値 (freee 連携 / 複数店舗 / ブランド除去 等) に紐づけて検討** (例 ¥500-1,000/月 + 1%・WTP が見えてから)。
セルフ回収 tier (うちがガス負担しない・将来) は安く (例 0.5%)。
率の根拠: カード ~3.3-3.6% / QR ~1.6-2% / JPYC EC 1%・2% に対し **1% で価格優位**、かつ小額決済でもおまかせの
**ガス負けを回避** (0.5% は小額でガス負け+後の値上げが定型約款変更で重く不可)。**基本料を traction 前に乗せると
小規模店の実効が 2% 超 = incumbent 超になり獲得を殺す** (固定費はスケール + 将来 Pro で回収・前倒しでは埋まらない)。

## 既存資産 (調査済・再利用)

- **EIP-3009 リレー**: `lib/jpycEip3009.ts` (純コア) + `app/api/relay/jpyc/route.ts` (self-host relayer が
  `transferWithAuthorization` 直叩き)。→ **店主の手数料署名のリレーにそのまま使える** (顧客決済と同じ機構)。
- **利用権**: `lib/entitlement.ts` (KV `entitlement:{wallet}`→expiry・tier・bypass)。→ **「fee-current until expiresAt」
  に転用** (店主 wallet 別)。後方互換維持。
- **支払い検証**: `/api/fee/verify` (SIWE 必須・from=セッション wallet 束縛・on-chain JPYC Transfer 照合・
  txHash 冪等・`lib/feeVerify.ts`)。→ **「月次インボイスの消し込み」に拡張** (検証成功→fee-current 30日延長)。
- **SIWE**: `app/api/auth/siwe/_session.ts` `requireSession()`・`hooks/useSiweSession`・`hooks/useEntitlement`。
  → 店主の identity。
- **フラグ**: `NEXT_PUBLIC_ENABLE_USAGE_FEE` (a1 専用・既定 OFF・`lib/env.ts`)・`ALPHA_ENTITLEMENT_BYPASS` (既定 ON)。
  旧 `NEXT_PUBLIC_ENABLE_BILLING` (履歴CSV年額ゲート) とは**別フラグ**で、a1 だけ独立点灯できる (両方 1 にすると二重課金)。
- **KV**: `lib/kv.ts`。**FEE_RECEIVER**: `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` (burn-address ガード済)。
- **観測性**: PROD-1 で relay にログ追加済 → **どこまで店主別 volume を永続化しているか要確認** (S1 の起点)。

## 実装ステップ (すべて flag OFF で inert)

**S1 — リレイヤー出来高メーター (課金基盤・最優先の安い一手)** ✅実装済 (2026-06-08・`lib/billingMeter.ts` + `route.ts` handleFree 成功フック + 17 tests・typecheck/lint green)
- gasless relay 成功時 (`route.ts`) に `(merchant=to, chainId, amount, ts)` を KV に永続化し、**店主×期間で集計**。
  これが改ざん不能な「メーター」(うち自身が中継した記録)。
- **flag に関係なく今から記録開始してよい** (純加算ログ・挙動不変・option value 高: 記録してない過去 volume には
  後から課金できない)。まず PROD-1 の既存ログが店主別 volume を残しているか確認し、無ければ追加。
- メーター対象は **gasless 中継分のみ** (standard/直接送金は不可視=無料 tier に倒れる・honest)。USDC (Circle
  Paymaster 経路) は別メーター・後回し。

**S2 — インボイス計算** ✅実装済 (2026-06-08・**`lib/usageFee.ts`** 純関数・16 tests。※既存 `lib/billing.ts` は tier 利用権用で別物のため新規ファイルに分離。料率はアルファ0%/ベータ1%を `OPENPAY_USAGE_FEE_START_PERIOD` で制御・既定 inert)
- `computeInvoice(merchant, period)` = `sum(period の出来高) × feeRate` (+ 下限/閾値)。`feeRate`(=1%)・最低額・
  無料閾値を定数化。純関数 + 単体テスト (率/下限/閾値/0件)。

**S3 — fee-current 利用権モデル** ✅実装済 (2026-06-08・**`lib/feeCurrent.ts`** 新規・10 tests。`lib/entitlement.ts` 拡張でなく別系統で衝突回避・bypass は ALPHA_ENTITLEMENT_BYPASS 共有・grant は max 延長 + 応答ロス読み戻し。併せて S1 メーターに FEE_RECEIVER 宛=利用料支払い tx の除外を追加)
- `isFeeCurrent(merchant): boolean` / `feePaidThrough(merchant): expiresAt`。settlement で付与/延長。既存 entitlement
  (basic/pro) と**後方互換** (別キー or tier 共存)。bypass 時は current 扱い。

**S4 — ガスレス手数料支払い + 検証** ✅実装済 (2026-06-08・**`/api/billing/settle` 新設**・14 tests。SIWE 必須・インボイス額をメーター(S1)+料率(S2)からサーバ権威算出・on-chain 照合(feeVerify 流用・from=session/to=FEE_RECEIVER/額≥invoice)・txHash idempotency(lock→result 昇格)・成立で fee-current(S3)付与。請求0(アルファ/出来高0/閾値未満)は検証不要で nothingDue 付与)
- 店主が `transferWithAuthorization(店主→FEE_RECEIVER, invoiceAmount)` に署名 → 既存 relay でガスレス送信 →
  server が on-chain 照合 (`feeVerify` 再利用) → **当該期間を settled + fee-current を 30 日延長**。txHash 冪等で
  二重消し込み防止。インボイス額と settlement を紐付け (額不足/別from/別to は reject)。

**S5 — relay 関所ゲート (teeth)** ✅実装済 (2026-06-08・**`lib/feeGate.ts`**・17 tests。`handleFree` 前段に組込・arrears 尊重 (前月に請求あり・未current・月初猶予超過のみ遮断=delinquent)・利用料支払い(FEE_RECEIVER宛)/standard/アルファ/billing OFF は通す・KV障害は fail-open・未払いは 402 `fee_required`)
- `route.ts` で **flag ON かつ !bypass** のとき、店主の顧客決済をリレーする前に `isFeeCurrent(merchant)` を確認。
  未払い (かつ猶予超過) → gasless relay を拒否し `fee_required` を返す → client は「利用料を清算 / 自己回収へ」を提示。
  **顧客決済自体は standard/自己回収 (顧客がガス負担) で無料継続可**。
- **猶予**: 新規店主は初月無料 (アルファ無料→翌月従量→翌々月1日清算、の arrears)。grace 期間/締め日を定数化。
- **flag OFF は完全 inert** (現挙動・既存テスト不変)。

**S6 — 店主向け課金 UI** ✅実装済 (2026-06-08・`/api/billing/invoice` + `hooks/useBillingInvoice.ts` +
**`components/OpenPayFeePanel.tsx`** + ページ `app/[locale]/billing/page.tsx` + i18n 新 namespace `UsageFee` (ja/en)。
SIWE → インボイス (due=前月/current=当月) 表示 → ガスレス支払い (`useJpycEip3009Payment` free 分岐を FEE_RECEIVER
宛で再利用・店主は native gas 不要) → `/api/billing/settle` 清算。billing OFF はパネルが「アルファ無料」を表示し請求
UI を出さない。invoice 5 tests + panel 6 tests + i18n parity 730 green)

**S7 — 開示/法務** ✅ドラフト確定 (2026-06-08)・**ライブ適用は go-live 時** (現コピーは正確なので今は変更しない)
- **現状調査結果**: 既存コピー (Terms art5 / Disclaimer s7 / Tokutei price・paymentTiming・returnPolicy・additionalFees)
  は**すでに「alpha は 0% 無料」「将来有料化は事前周知し変更後取引に適用 (定型約款変更=民法548条の4・Terms art10)」を
  網羅**。Terms art5(5) は「その場合の手数料は別途、利用者のウォレットから当社指定ウォレットへ送金されることがあります」
  と a1 の徴収フローまで予告済み。→ **今は live コピー変更不要** (現に 0% 無料なので現コピーが正確)。
- **⚠️ go-live 時に改訂が必須な箇所** (今 "1%課金" と書くと現に無料の事実と矛盾するため、点灯と同時に適用):
  - **Terms art5(2)**: 現在「gas 肩代わり経路では…その回収その他いかなる名目によっても利用者から相当額を徴収しません」
    と**現在形で約束**している。点灯時に「ガスレス決済の提供に対する OpenPay 利用料 (中継出来高の {rate}%・月次) を
    店主から別途収受する。商品代金は引き続き全額店主へ直接送金され、当社は売上を受領・保管しない」へ改訂。
  - **Terms art5(1)/(5)・Disclaimer s7・Tokutei price/paymentTiming/returnPolicy**: 「alpha は無料」→「{施行日}以降、
    ガスレス決済モードの利用について月額利用料 (前月の中継出来高 × {rate}%) を申し受ける。standard (顧客がガス負担)
    モードおよび決済の受領自体は無料」。施行日 bump。
  - **Landing**: 「無徴収・100%着金」表現を「決済受領は無料・ガスレスは月額 {rate}% (店主負担・任意)」へ。
- **プロセス**: 民法548条の4 (定型約款変更) に基づき、変更内容と効力発生時期を**効力発生前に**サイト掲示等で周知し、
  **変更後の取引にのみ適用**。FSA は登録該当性をクリア ([[fsa-clearance]]) だが本件は消費者周知レイヤー (別) で必須。
  弁護士レビューは go-live 時にまとめて ([[project_monetization_strategy]])。

**S8 — フラグ/env** ✅実装済 (2026-06-08)
- **a1 専用フラグ `NEXT_PUBLIC_ENABLE_USAGE_FEE`** (課金 UI/relay ゲート/清算を gate) + `ALPHA_ENTITLEMENT_BYPASS` (=fee-current bypass)。
  旧 `NEXT_PUBLIC_ENABLE_BILLING` は履歴CSV年額ゲート (将来 Pro tier) 専用に分離済 — a1 を点灯しても旧 CSV ゲートは点かない (二重課金回避)。
- 新 env (すべて process.env 直読・既定 inert): **`OPENPAY_USAGE_FEE_BPS`** (既定 100=1%)・**`OPENPAY_USAGE_FEE_START_PERIOD`**
  ('YYYY-MM'・未設定なら全期間 0%=安全)・**`BILLING_METER_DISABLED`** ('1' でメーター緊急停止)。FEE_RECEIVER 流用。
- **Go-live = `NEXT_PUBLIC_ENABLE_USAGE_FEE=1` + `ALPHA_ENTITLEMENT_BYPASS=0` + `OPENPAY_USAGE_FEE_START_PERIOD=2026-07` + FEE_RECEIVER 設定確認**
  + S7 開示改訂の同時適用。メーター (S1) は flag 無関係なので 6月から記録開始してよい (`BILLING_METER_DISABLED` 未設定)。

**S9 — 検証/テスト/Codex** ✅実装/検証完了 (2026-06-09)
- 新規テスト: billingMeter 17 / usageFee 16 / feeCurrent 10 / settle 14 / feeGate 17 / invoice 5 / OpenPayFeePanel 6 = **85**。
- **全 178 files / 3969 tests green**・typecheck clean・`npm run build` pass (/api/billing/* 含む)・lint clean (既存 vendored 警告のみ)。
- Codex review = バックグラウンド起動済 (feat/openpay-fee-a1 diff)。指摘が出たら対応。

## 制約 / 不変

- **standard/自己回収 (顧客が自分でガスを払う) は本当に無料**のまま残す = 「コア有料」を bait-and-switch にしない
  無料 tier の根。direct wallet-to-wallet QR も無料。
- メーターは **gasless 中継分のみ** (standard/直接は不可視→無料に倒れる・honest)。USDC は別・後回し。
- **顧客署名は無改変 = 全チェーンで Blockaid 新規露出なし**。手数料レグ (店主→FEE_RECEIVER 単一宛先) も Blockaid 無害。
- flag OFF + bypass ON で本番挙動を変えない。
- OpenPay の手数料受領の会計/税務 (時価・期末評価) は別途整備 ([[option-b-accounting]])。

## リスク / 不明点

- **回避耐性の限界**: 関所で「ガスレスを受けるには利用料署名が要る」ので回避不能だが、店主が **standard モード
  (自分でガス負担) に全振りすれば無料**で使える = 意図した無料 tier。ガスレスの利便性に価格が乗る構造。許容。
- **メーター不可視分**: standard/直接送金は課金できない → ガスレスへ誘導する設計意図と一致。
- **率/下限の単位経済**: 母数小×attach 低の現実 (traction 前)。点灯は実需後・導入0%で種まき。
- **on-chain 検証の堅牢性**: from/to/token/額の厳密照合 + txHash 冪等 (既存 feeVerify の hardening 流用)。
- **実質主義での料金性質**: FSA で登録不要は確定 ([[fsa-clearance]]) だが、消費者契約/定型約款変更/税務は別 →
  弁護士レビュー (実着手時)。

### 正直な限界 (監査 2026-06-09・自信過剰を避けて明記)
- **🚩 本番未実証 (最重要)**: 全 4001 テストは **KV (in-memory fake) と on-chain 検証 (verifyJpycFeeOnChain) を境界で
  モック**している。実 Upstash KV の nx 原子性/LRANGE/TTL を**複数 serverless インスタンス間の真の並行**で、実 on-chain
  受領照合、実ウォレット署名→relay broadcast、Vercel での `await` メーター書込完了 — これらは**一度も実環境で動いて
  いない**。「テストで検証済」≠「本番で動く」。**testnet 実機 E2E (G6) が点灯前の必須ゲート**。
- **🚩 月次ウォレットローテで回避可能**: gate は「閉じた前月に請求あり・未払い・猶予超過」のみ遮断するため、店主が
  毎月**別ウォレットに移れば**前月債務を踏み倒せる (新 wallet は前月メーターが空)。非カストディ/非 KYC の月次後払いの
  原理的限界。コスト = 履歴/印刷 QR/顧客の信頼/会計継続性の喪失のみ。本物の店は回さないが**濫用者は逃げ得** = 想定内の
  漏れ (per-tx 即時徴収のみが回避不能だが Polygon Blockaid で不可)。
- **メーターは gasless JPYC のみ**: standard モード (顧客自己ガス)・直接送金・USDC (Circle Paymaster) は**非計上 = 無徴収**。
  ガスレス利便性への課金という設計意図とは一致するが、USDC ガスレスのコストは現状回収しない。
- **KV 障害時は fail-open**: gate は isFeeCurrent/getMeteredCount が KV 失敗時に安全側 (not blocked) に倒れる → **KV
  ダウン中は徴収されず全店ガスレス無料**。決済を壊さない意図的トレードオフだが、KV 停止 = 収益漏れ。
- **meter (KV) ↔ chain の照合なし**: メーターは best-effort (書込失敗は warn ログ + undercount)。実 relay 出来高との
  突合ジョブが無いため、書込ドリフトは**過少請求**として静かに残る (overcharge はしない)。robust 化は将来課題。
- **期間境界は UTC 月初**: `previousPeriod`/`meterPeriod` は UTC。JST では月初 9:00 が境界 → 深夜 JST (例 6/30 23:00
  JST = 6/30 14:00 UTC) は当月、早朝 (7/1 8:00 JST = 6/30 23:00 UTC) は前月扱い。店主の会計月とズレうる点を要周知。
- **hot-path コスト**: gate は全ガスレス relay で走り、未 current 時 +1〜2 KV 読 (isFeeCurrent + LLEN)・成功時 +2 KV 書
  (LPUSH+EXPIRE)。小〜中規模では許容。`count>0 ⟹ feeWei>0` 近似 (実決済は volume ≥ 1 JPYC ゆえ sub-wei 総額は到達不能)。

## Go-live (ユーザ deploy 操作・別途明示承認)

`NEXT_PUBLIC_ENABLE_USAGE_FEE=1` + `ALPHA_ENTITLEMENT_BYPASS=0` + FEE_RECEIVER 確認 + 料率/grace 確定 → 段階反映。
※ traction 優先につき、本プランは**書いて寝かせる**。点灯は実店舗が数件乗ってから。

## 検証 (E2E・testnet, flag ON + bypass OFF)

SIWE → 顧客決済をガスレス relay → メーターに加算 → 月次インボイス表示 → 店主が利用料を 1 署名 (ガスレス) →
settle → fee-current 付与 → 翌期の顧客決済が relay 許可。未払い店主は gasless 拒否・standard へ fallback。
同 txHash 再清算は拒否。新ウォレットでも利用料署名なしには gasless を受けられないこと (回避耐性) を確認。

## ロールバック手順 (G1・独立した kill-switch が 4 つ)

点灯後に問題が出た場合、**段階的に**無効化できる (いずれも env 変更 + 再デプロイで反映)。コア決済 (受取/relay
free モード) は常に無影響:
1. **料率だけ 0% に戻す (最小влияние)**: `OPENPAY_USAGE_FEE_START_PERIOD` を未設定にする → 全期間 0% =
   インボイス feeWei 0・gate は前月請求なしと判定し遮断しない・settle は nothingDue。メーター記録は継続。
2. **ゲート/徴収を全停止 (課金システムを inert に)**: `ALPHA_ENTITLEMENT_BYPASS=1` → 全店 current 扱いで
   gate は遮断せず・課金 UI は「無料」表示。または `NEXT_PUBLIC_ENABLE_USAGE_FEE=0` (要再ビルド) で UI/関所/清算を 404 化。
3. **メーター緊急停止**: `BILLING_METER_DISABLED=1` → relay 成功時の出来高記録を停止 (relay 自体は無影響)。
4. **完全撤回**: ブランチ `feat/openpay-fee-a1` を未マージなら破棄、マージ済なら revert。
- 既存データ (KV の meter/fee-current) は TTL で自然失効するため、無効化後に残骸が課金を引き起こすことはない。

## 監視 / アラート (G2)

**監視 (整備済)**: 全失敗モードが構造化ログ (`logger.*` → Sentry) を吐く。システム障害は **error** レベル
(= 既定の Sentry error アラートで surface)、ユーザ/一過性は **warn**。
- **アラート推奨 (error・要 page)**: `billing.settle.rpc-error` (RPC 障害で検証不能)・`billing.settle.grant-failed`
  (支払い確認したが付与失敗 = 顧客体験毀損)・`billing.settle.misconfigured` (FEE_RECEIVER 未設定)・
  `billing.settle.unexpected`・`billing.settle.release-failed` (ロック焼失リスク)。
- **監視のみ (warn・閾値で気付ければ可)**: `billing.settle.verify-failed` (大半は顧客の誤 tx)・
  `billing.settle.promote-failed`・`billing.meter.lpush_failed` / `billing.meter.dropped_entries` /
  `billing.meter.capped` (課金根拠データの欠落 — 継続的に出るなら KV 健全性を疑う)・`billing.meter.record_failed`。
- **[user] 残**: 上記 error イベントに対する Sentry アラート規則の作成 (dashboard 設定・コード外。既存
  `billing.fee.*` 規則と同様)。

## 関連

[[fsa-clearance]] [[project_monetization_strategy]] [[jpyc-fee-takable-okabe]] [[reference_jpyc_eip3009]]
[[project_crosschain_fee_collection]] / 旧 Phase B 課金プラン = `.claude/plans/swift-puzzling-sky.md` (年額CSV版・
本プランで上書きする思想)
