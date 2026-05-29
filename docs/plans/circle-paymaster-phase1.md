# Phase 1 実装計画: USDC ガスレスに Circle Paymaster 並行対応（優先）

> ステータス: 計画（実装前レビュー用）。Phase 0 feasibility spike = **GO**
> (`scripts/spike-circle-paymaster.mjs`、Arbitrum Sepolia 実機)。

## 1. 目標
USDC のガスレス決済で gas 支払いを **Circle Paymaster v0.8（優先）** に切替え、
**Pimlico erc20 を fallback** 保持。JPYC は現行 Pimlico sponsorship (v0.7) 維持。
`paymasterMode='erc20'` は不変 — C8 法務ドリフトガード・利用規約/特商法 prose を壊さない
(Circle も「顧客が USDC で gas を Paymaster に支払い・当社徴収0」の ERC20 Paymaster)。

## 2. 制約・依存・エッジ（spike 確定事項込み）
- **EntryPoint 二系統併存**: JPYC=v0.7+Pimlico、USDC-circle=**v0.8**+viem。deployment 毎に
  client を組むため併存可。委任先 impl は両系統とも `0xe6Cae83BdE06E4c305530e199D7217f42808555B`
  (spike 実証) → **既存委任済 EOA は再委任不要で両経路可**。
- **7702 bootstrap 制約は継続**: pristine MetaMask は初回 7702 authorization を gasless に
  張れない (project memory: pristine-eoa-no-gasless-bootstrap)。Circle 経路でも同じ →
  pristine は standard mode 案内に fallback。
- **Circle 統合レシピ（spike 確定・必須）**:
  1. permit は EIP-2612、`deadline=MAX_UINT256`
  2. `paymasterData = encodePacked(['uint8','address','uint256','bytes'], [0, usdc, permitAmount, sig])`
  3. `paymasterPostOpGasLimit ≥ 15000`（未満は AA33 `0x5ff4afc1` revert）
  4. 完全な gas セットで送信（postOp 部分指定は viem "Invalid fields"）
  5. **7702 authorization を自前で本署名**（viem auto は stub → "recovered signer != sender"）
  6. fee は `pimlico_getUserOperationGasPrice` の standard（Arb は maxPriorityFeePerGas≥120000）
- **2 署名**（permit + UserOp）= UX 後退、初期許容。
- **Circle アドレス = spender 信頼境界 (C3)**: permit の spender=paymaster なので、誤/悪意の
  アドレスに USDC allowance(≤permitAmount) を与えうる。→ **per-chain ハードコード allowlist**
  (Circle 公式 docs 由来) を SoT とし、mainnet は**任意 env override 不可**(override は Circle
  identity 検証を通る場合のみ)。deploy 時に paymaster の codehash/アドレスを検証。
- **徴収額 reconciliation = tx-log 必須経路 (C2)**: balanceOf 差分は別タブ/wallet 操作/refund/
  同 block の無関係転送で汚染されるため **audit source にしない**。→ **userOpHash に紐づく tx
  receipt の USDC Transfer ログから「customer→Circle paymaster/documented collector」を集計
  (返金 collector→customer を差引いた net)** を必須経路とする。balance 差分は sanity metric のみ。
  `circlePaymasterNetUsdc` + provider + paymaster アドレスを記録。OpenPay 徴収0は不変。
- **fallback / unknown-submit state machine (C1, critical)**: merchant 転送は不可逆。**fallback は
  (a) 署名/broadcast 前、または (b) 決定的 unsupported エラーのみ**許可。submit RPC の
  **timeout / 5xx / 無応答は「unknown/pending」状態**として扱い (Pimlico 受理後・hash 受信前で
  included しうる) **auto-fallback を禁止**。→ **submit 前に pending record を永続**
  (chainId/sender/nonce(key)/call hash/provider/paymaster/算出 userOpHash or 署名 op fingerprint)
  → recover は bundler receipt/mempool/tx logs で照合 → idempotency で二重決済防止。
- **Circle fee schedule を hard config (C4)**: "×buffer" は fee モデルではない。**per-chain の
  Circle surcharge を hard config 化** (Arb/Base=10%、他は docs 確認まで未定義扱い)。quote /
  permitAmount / reconciliation / 法務 copy に反映。**fee 式が不明な chain は Circle 有効化を
  block**。permitAmount は「実費+surcharge の max」を賄い、かつ過剰 allowance を避ける算定に。

## 3. 既存パターン / ライブラリ
- 受け皿: `resolvePaymasterMode`（erc20 維持）、account builder 群、`useGasQuote` router。
- 新規: viem `toSimple7702SmartAccount`(v0.8) + `createBundlerClient` + 手動 permit/paymasterData
  (spike コードが移植元)。permissionless は JPYC 用に残す（**2 AA SDK 併存**）。

## 4. アーキテクチャ & データフロー

### 新規/変更ファイル
1. **`lib/circlePaymaster.ts`（新規）**: `CIRCLE_PAYMASTER_ADDRESSES`(v0.8 per chain・**ハードコード
   allowlist が SoT**、mainnet 任意 override 不可)、`CIRCLE_SUPPORTED_CHAIN_IDS`、
   `CIRCLE_MIN_POSTOP_GAS=15000n`、`resolveUsdcGaslessProvider(deployment, chainId)`、
   permit/paymasterData ヘルパ。deploy 時に paymaster codehash/アドレス検証 (C3)。
2. **`lib/smartAccount/circleAccount.ts`（新規）**: viem v0.8 client builder（spike レシピを関数化）。
   署名は wagmi walletClient 経由。
3. **client 契約を discriminated union 化 (C6)**: `{ provider:'pimlico', entryPointVersion:'0.7',
   smartAccountClient, pimlicoClient }` | `{ provider:'circle', entryPointVersion:'0.8',
   bundlerClient, account, sign関数群 }`。`useSmartAccount` の React Query key に **provider +
   entryPointVersion を含める**(現状 address/chain/symbol のみ・staleTime Infinity でキャッシュ汚染
   防止)。`useBatchPayment` を circle/pimlico/standard で **exhaustive 分岐**。
4. **`hooks/useSmartAccount.ts`（変更）**: USDC + provider==='circle' → Circle builder へ routing。
5. **`hooks/useBatchPayment.ts`（変更/分岐）**: provider 別送信フロー。**fallback state machine (C1)**:
   署名/broadcast 前 or 決定的 unsupported → fallback 可。**broadcast 後の不確定 (wait timeout) は
   auto-fallback 禁止** → hash 永続 + recovery/手動 receipt 探索 + idempotency。calls は merchant
   (+split) 転送のみ (USDC feeAmount=0/徴収0)。
6. **`hooks/useGasQuoteCircle.ts`（新規, C4）**: estimate(units)×pimlico gas price×USDC/native rate
   × **per-chain Circle surcharge (hard config)** で UI quote。permitAmount は max(実費+surcharge)
   を賄いつつ過剰 allowance を避ける算定。
7. **audit pipeline = end-to-end + receipt 検証 (C2/C3)**: `provider`・`circlePaymasterNetUsdc`・
   paymaster アドレスを `lib/paymentLog.ts`・`app/api/log/payment/route.ts` allowlist・stats・
   export(CSV)・HistoryEntry・履歴 UI まで通す。ただし /api/log/payment は**未認証・client 申告の
   shape のみ**なので pass-through だけでは監査に不適。→ **server/offline verifier を追加**:
   (chainId, txHash/userOpHash) から receipt を取得し設定済 Circle paymaster/collector の USDC
   Transfer から circlePaymasterNetUsdc を**再計算**、`verificationStatus`/`source` 付きで保存。
   stats/export は **verified(on-chain) と client-reported を区別**。
   **verifier の binding 不変条件 (C3深)**: client 申告フィールドではなく **pending store record を
   source of truth** とし、receipt が expected userOpHash/sender/nonce(key)/callHash/token/merchant
   転送/設定済 paymaster を含むことを証明してから採用。集計は **eth_getUserOperationReceipt の
   per-UserOp logs、または UserOperationEvent の log-index range (postOp 徴収を含む範囲) で scope**
   し、tx 全体の Transfer 合算はしない (1 bundle に同 sender 複数 UserOp で誤集計するため)。
   照合不能なら `unreconciled`。bundle 内 2 UserOp/同 sender/返金 のテストを必須。
8. **HistoryEntry schema 移行 (C4-hist)**: schemaVersion を bump し、legacy(v1) を provider/circle
   フィールド=null/unknown で **backfill する migration** を追加。新フィールドは optional 扱いで旧
   entry を UI/CSV から drop しない。v1/新規 Circle/rollback の各テスト。
9. **`lib/env.ts`（変更）**: `NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER`。Circle アドレスは override 制限 (C3)。
10. **durable・fail-closed pending store = atomic idempotency gate (C1深)**: history/KV 流用ではなく
    **専用 store**。**broadcast 前に書込成功が必須 (失敗時は fail-closed=送信中止)**。
    **冪等 key は安定値のみ: `paymentAttemptId/orderId + sender + callHash`（nonce/userOpHash には
    依存させない — quote 再生成で変わるため）**。`chainId/sender/nonce/userOpHash` は二次 index。
    **atomic create-if-absent + CAS のみの status 遷移**、**署名者/tenant-bound の認可**
    (create/update/recovery)、create-or-resume。並行タブ create・gas/userOpHash 変化での retry・
    敵対的/競合 update のテストを必須 (server/KV-backed なら認可で record poisoning / 支払いブロック
    を防ぐ)。
    **明示的ライフサイクル FSM (C1最深)**: `reserved → awaiting_signature → signed →
    submitting → confirmed/failed`、横道に `abandoned`。
    **store CAS と bundler RPC は atomic にできない (分散境界・critical)** ため、**bundler 呼び出し
    の前に `submitting` (= broadcast_intent / may-have-broadcast) を永続**し、その時点で**完全な
    署名済 UserOp + userOpHash + permit digest を保存**する。
    - `reserved/awaiting_signature/signed`(=未送信・broadcast_intent 前) は同一署名者が abandon/
      supersede 可(popup2 拒否・タブ閉じ・lease 失効)→ 安全に retry。
    - **`submitting` 到達後は fallback も新規 op 構築も禁止**。recovery は **(a) receipt 照会、または
      (b) 保存済の*同一署名 op* をそのまま rebroadcast** のみ (ERC-4337 nonce で同一 op は二重実行
      不可＝冪等)。新しい op を作らない。
    テスト: 署名後 submit 前 / **intent 永続後 RPC 前** / **RPC 後 CAS 前** / submit 応答ロスト の
    各クラッシュ recovery (二重決済も宙吊りも起きないこと)。

### データフロー（USDC-circle 決済）
EOA 接続(0xe6Cae83 委任) → provider=circle 解決 → v0.8 client → useGasQuoteCircle 表示 →
支払時: ①permit 署名[popup1] ②**durable pending record を書込 (成功必須・C1)** ③UserOp
(merchant transfer)+paymasterData+完全gas+fee 署名[popup2]→送信 → Circle が postOp で USDC gas
徴収(net) → 着金 → pending record を confirmed へ。OpenPay 徴収0。
**reconciliation は tx-log のみ (C2・balance 式は不採用)**: userOpHash→txHash 解決 → USDC
Transfer ログをパース → `customer→Circle paymaster/collector` から `collector→customer 返金`を
差引いた net を `circlePaymasterNetUsdc` とする。receipt 経路が使えない場合は `unreconciled/unknown`。
balanceOf 差分は別名の sanity metric としてのみ（audit/legal には使わない）。

## 5. テスト戦略
- `resolveUsdcGaslessProvider` 単体（circle/pimlico/fallback/flag off）。
- `useGasQuoteCircle` 単体（quote 計算）。
- **法務テストを provider 次元に拡張 (C4)**: `paymasterMode='erc20'` 維持だけでは prose の真正性を
  担保しない。provider を第一級次元として、Terms/特商法/Privacy(§3 委託先に **Circle を追加**)/UI
  help text を Circle 対応 (顧客が USDC で Circle Paymaster に gas 支払い・当社徴収0・provider 手数料)
  で ja/en assertion。UI が "Pimlico" 名のまま残らないことも検査。
- **cross-switch smoke test を release blocker に (C5)**: JPYC/USDC 両対応チェーン (Polygon 等) で
  同一 EOA の v0.7(JPYC)↔v0.8(USDC) を **receipt 付きで往復実証**してから Circle 有効化。
  delegate-address のみの検出 (accountDetection.ts) では EntryPoint/nonce/validation 差を捕捉
  できないため、send 時失敗を事前に潰す。
- **"send accepted but response lost" テスト (C1)**: submit RPC が応答ロスト時に unknown/pending に
  入り auto-fallback しないこと、recover で二重送信しないこと。
- **reconciliation テスト (C2)**: 同 block の無関係 in/out 転送があっても tx-log 経路が正しい
  Circle net を出すこと (balance 差分は汚染されても audit に使わない)。
- **audit 保持 + 検証テスト (C3)**: provider/circlePaymasterNetUsdc/paymaster が API→KV→stats→CSV→
  history UI まで保持され、**verifier が client 申告値を receipt 由来値で上書き/区別**すること。
- **pending store 耐久テスト (C1深)**: broadcast 前書込失敗で送信中止 (fail-closed)、tab close/
  別セッションからの recover で二重送信しないこと。
- **HistoryEntry 移行テスト (C4-hist)**: v1 既存 entry が drop されず null/unknown で残る、新 Circle
  entry、rollback (新→旧 schema) の挙動。
- **fee 整合テスト (C4)**: Base mainnet で **実 receipt の徴収 USDC が表示 max 以内**であること
  (receipt-backed quote test)。fee 不明 chain は Circle 無効を assert。
- Circle 送信フローは mock 単体 + spike（実機）で担保。
- e2e: USDC gasless で provider 表示/フォールバックの UI。

## 6. 段階リリース
flag OFF 既定で投入 → testnet 検証 → mainnet 1 chain (Base) ON → 段階拡大。fallback で安全。

## 7. 不明点 / リスク（codex adversarial-review 反映後）
- **[解消方針あり]** 二重決済 (C1) → fallback state machine + idempotency。
- **[解消方針あり]** reconciliation (C2) → merchant/split/fee 差引 + 専用ログ。
- **[解消方針あり]** spender 信頼境界 (C3) → ハードコード allowlist + codehash 検証。
- **[解消方針あり]** 法務 drift (C4) → provider を法務/テスト第一級次元化。
- **[release blocker]** cross-switch 未実証 (C5) → per-chain 往復 smoke test を投入前ゲート化。
- **[解消方針あり]** client 契約 (C6) → discriminated union + RQ key に provider。
- **[2巡目反映]** unknown-submit 二重決済 (C1深) → pending record 永続 + recover、応答ロストテスト。
- **[2巡目反映]** reconciliation 健全性 (C2深) → tx-log を必須経路、balance は sanity のみ。
- **[2巡目反映]** audit 永続 (C3) → API/stats/export/history まで end-to-end。
- **[2巡目反映/release blocker]** Circle fee モデル (C4) → per-chain hard config、不明 chain は block、
  Base mainnet receipt 実測。
- **残**: 2 AA SDK 併存の保守コスト、mainnet Circle 手数料 (Arb・Base 10%、他 docs 未記載)、
  2 署名 UX、Circle フローのコード量増。

## 8. 非対象
CCTP V2 統合（別軸・未提供）、% 手数料（Phase 1 は 0% 維持）、2 署名の UX 最適化（後続）。
