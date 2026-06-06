# Runbook: アルファ版 実機スモークチェックリスト

> 対象: 無料アルファ版 (今月の訴求対象) を **実機 (スマホ + 実ウォレット) で一通り触って壊れていないか**を確認する。
> 自動テスト (vitest 3700+ green) ではカバーできない「実ブラウザ・実ウォレット・実 on-chain・実 relayer」の経路を人手で確認する。
> 各項目はチェックボックス。**P0 が全部通れば「現金店舗に配れる」状態**。P1/P2 は体験の磨き込み。
>
> **このアルファのスコープ (= 訴求している機能)**:
> - JPYC / USDC の店舗 QR 決済 (受取・ノンカストディ・手数料0%・即時着金)
> - JPYC ガスレス (OpenPay がガス全額負担・無徴収・100%着金) — Polygon + Kaia mainnet LIVE
> - 取引履歴 / 顧客向けレシート控え / レジ・カート
>
> **テストしない (= OFF・訴求していない)**:
> - ❌ freee 連携 (`NEXT_PUBLIC_ENABLE_FREEE_SYNC` 未設定 = OFF)
> - ❌ 課金/利用権ゲート (`NEXT_PUBLIC_ENABLE_BILLING` 未設定 = OFF・`ALPHA_ENTITLEMENT_BYPASS` 全開放)
> - ❌ ウォレットログイン (SIWE) UI — 上記2つが OFF のとき非表示 ([[project_jpyc_free_pivot]])
> - ❌ grant / アフィリエイト (未着手)

---

## 0. 事前準備 (Pre-flight) — 触る前に確認

### 0-a. 本番 env (Vercel) — `NEXT_PUBLIC_*` は変更後に**再デプロイ**しないと反映されない

- [ ] `NEXT_PUBLIC_NETWORK_ENV=mainnet`
- [ ] `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` = 本番受領アドレス (placeholder `0x…dEaD` のままだと起動時 throw)
- [ ] `NEXT_PUBLIC_PIMLICO_API_KEY` 設定済 (USDC ガスレス paymaster 用)
- [ ] `NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID` 設定済
- [ ] `NEXT_PUBLIC_SENTRY_DSN` 設定済 (実機エラーを拾うため)
- [ ] `RELAYER_PRIVATE_KEY` 設定済 (JPYC ガスレス self-host relayer)
- [ ] **`NEXT_PUBLIC_JPYC_FORWARDER_POLYGON` / `_KAIA` が未設定 (free)** — 設定すると recover (ガス徴収) が
      点灯し「完全無料化ピボット」に反する。空であること ([[project_jpyc_free_pivot]])。
- [ ] **`NEXT_PUBLIC_ENABLE_FREEE_SYNC` 未設定 (OFF)**
- [ ] **`NEXT_PUBLIC_ENABLE_BILLING` 未設定 (OFF)**
- [ ] `ALPHA_ENTITLEMENT_BYPASS` = 全開放 (空 or `1`・billing OFF なので実質無効だが念のため)

### 0-b. relayer / paymaster 残高 (これが枯れると JPYC/USDC ガスレスが止まる)

- [ ] relayer EOA アドレス確認: `node scripts/relayer-wallet.mjs`
- [ ] relayer の POL (Polygon) / KAIA 残高がガス数十〜数百件分ある (枯渇=ガスレス決済が落ちる)
- [ ] Pimlico 残高確認: `node scripts/check-pimlico-balance.mjs` (USDC ガスレス用)

### 0-c. observability

- [ ] Sentry に本番イベントが届く導線が生きている (デプロイ後にテストエラーが1件でも上がるか後で確認)
- [ ] go-live 時に `node scripts/setup-sentry-alerts.mjs` を1回流してアラートルールを作成済 (未実施なら実施)

### 0-d. ログイン UI 非表示の確認 (free pivot の見た目)

- [ ] 本番 (https://open-pay.jp) ヘッダ右上 = ウォレット接続時に「ログイン/署名」導線が**出ない**
      (freee/billing OFF のとき WalletBadge は「繋ぐ/切る」だけ)。出ていたら env 反映漏れ → 再デプロイ。

---

## P0 — これが壊れてたら配れない (コア決済)

> 端末は **客側スマホ (店の Wi-Fi/モバイル回線)** を想定。可能なら別端末2台 (店=QR提示 / 客=読み取り) で。

### P0-1. JPYC ガスレス決済 (Polygon) — アルファの主役

- [ ] `/create` で金額 (例 1000) を入力し JPYC / Polygon を選択 → 決済 QR を生成
- [ ] 客スマホで QR を読む (`/pay` に着地)・**客ウォレットに POL が無くても**支払いできる
- [ ] ウォレットで署名 (transferWithAuthorization・EIP-3009)・送金が完了する
- [ ] **店 (FEE_RECEIVER ではなく受取アドレス) に満額 1000 JPYC が着金** (手数料/ガス天引きゼロ)
- [ ] Polygonscan で当該 tx を確認: **ガスを払ったのは relayer アドレス** (客ではない)
- [ ] 完了画面が出る・客側にレシート控えが残る (`/scan` で後から確認できる)
- [ ] 店の `/history` に当該取引が記録される (金額・通貨・チェーン・txHash)

### P0-2. JPYC ガスレス決済 (Kaia) — もう1つの mainnet LIVE チェーン

- [ ] 上記 P0-1 と同じ流れを Kaia で実施 → 満額着金・relayer がガス負担・履歴記録

### P0-3. relayer 枯渇/失敗時の振る舞い (壊れ方の確認)

- [ ] (任意・観察) relayer が一時的に失敗した場合、客に**二重送金させない**エラー表示が出る
      (送れていないのに「成功」と出ない) — Sentry に `billing.fee.*` や relay エラーが上がる

### P0-4. ノンカストディの担保 (思想の核)

- [ ] 決済の入出金で **OpenPay が資金を一度も預からない** (client→merchant 直接)・承認/審査フローが無い

---

## P1 — 体験の柱 (主要フローと別チェーン)

### P1-1. USDC ガスレス決済 (Pimlico paymaster)

- [ ] `/create` で USDC を選んで QR 生成 → 客が paymaster 経由でガスレス支払い → 着金・履歴記録
- [ ] Pimlico 残高が減る (`check-pimlico-balance.mjs`)・sponsorship policy が当該チェーンを許可

### P1-2. standard モード (ガスレス不可ウォレットの fallback)

- [ ] ガスレス非対応の状況 (例: 残高のある MetaMask) で standard 送金経路が案内され、通常送金で着金

### P1-3. /checkout (固定金額チェックアウト)

- [ ] `/checkout` 系の URL で金額確定 → 支払い → 着金・履歴記録

### P1-4. /tip/[address] (投げ銭)

- [ ] `/tip/<アドレス>` を開き任意額で送金 → 着金・履歴記録

### P1-5. レジ / カート (POS) — `/create` レジモード

- [ ] レジで複数明細を追加 → 合計が会計サマリに反映 → QR 提示 (フルスクリーンモーダル) → 支払い完了
- [ ] モバイルで下部固定の会計バー/CTA が BottomNav と重ならず押せる ([[project_register_pos_layout]])

### P1-6. 履歴 + CSV (無料・billing OFF なのでゲートなし)

- [ ] `/history` で取引一覧・フィルタ (種別/通貨/状態)・期間・検索・円換算 GMV が表示される
- [ ] 会計 CSV / 売上明細 CSV がダウンロードでき、Excel/数値で開ける (文字化け無し)
- [ ] **ぼかし/paywall オーバーレイが出ない** (billing OFF なので全開放)

### P1-7. 顧客向けレシート控え

- [ ] 支払い後、客ブラウザ (店とは別 localStorage) に控えが残る・`/scan` で確認/印刷/CSV/削除できる

### P1-8. モバイル UX 全般

- [ ] iOS Safari / Android Chrome で主要ページがレイアウト崩れなく表示される
- [ ] QR が画面サイズで潰れず読み取り可能・印刷 (レシート) が切れない

---

## P2 — エッジ / 高度機能 (壊れていても訴求の主役ではない)

### P2-1. 異通貨建て (FX) 動的 QR

- [ ] JPYC⇄USDC の FX 換算 QR を生成 → 3分の有効期限が切れると再生成を促す ([[project_fx_convert_dynamic_qr]])

### P2-2. クロスチェーン受取 (experimental)

- [ ] `/experimental/cross-chain-demo` が想定通り (experimental 表示・本番訴求対象外)

### P2-3. エラーパス / 中断

- [ ] 客が署名を拒否 → 「失敗」が正しく出て二重送金にならない
- [ ] 通信断・タブ離脱からの復帰で状態が壊れない (pending が無限に残らない)
- [ ] 残高不足・非対応チェーン → 分かりやすい案内が出る

### P2-4. 法務表示 (訴求に伴い参照されうる)

- [ ] `/terms` `/privacy` `/disclaimer` `/tokutei` (特商法) が表示され、JPYC 無料化の開示文言が入っている

---

## 記録テンプレ (実施時にコピーして使う)

```
日付: 2026-__-__
端末: (例 iPhone 15 / Safari, Pixel 8 / Chrome)
ウォレット: (例 MetaMask mobile, Rabby)
本番 commit: (git rev-parse --short HEAD or Vercel deployment)

P0-1 JPYC/Polygon: ✅ / ❌  tx: 0x...  着金額: ____ JPYC  ガス負担: relayer?(Y/N)
P0-2 JPYC/Kaia:    ✅ / ❌  tx: 0x...
P1-1 USDC:         ✅ / ❌  tx: 0x...
...
所見 / Sentry に上がったもの:
```

---

## 関連

- JPYC mainnet go-live (recover) 手順: `docs/runbooks/jpyc-mainnet-golive.md`
- Circle Paymaster リリースゲート: `docs/runbooks/circle-paymaster-release-gate.md`
- relayer 準備: `scripts/relayer-wallet.mjs` / `scripts/check-pimlico-balance.mjs` / `scripts/amoy-relay-readiness.mjs`
