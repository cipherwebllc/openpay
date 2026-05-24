# Tip widget ↔ Payment page parity 実装プラン

(Kaia chain 選択 + USDC cross-chain 支払い対応)

Status: Draft / 2026-05-24 / Author: planner agent (Claude Opus 4.7) — verified by main session

---

## 1. Context

### 1.1 背景

Payment page (`/pay`, QrGenerator + PaymentForm) は直近 1 週間で 2 つの大きな機能拡張を入れた:

1. **Kaia chain (chainId 8217) を JPYC 受信 chain として追加**。QrGenerator の chain chooser で Polygon と Kaia から選べる (`components/QrGenerator.tsx:394`)。
2. **USDC cross-chain 支払いを buyer に開放** (Phase 4 系列、`0fdbecc` + `1f579ad`)。merchant 受信 5 chain (Base/Arb/OP/Polygon/Ethereum) + buyer-only 2 chain (Avalanche/Unichain) = 計 7 chain から支払可能 (Circle Gateway / CCTP V2 経由)。

Tip widget (`/tip/[address]`, TipEmbedGenerator + TipForm) は両機能に未対応:

- **Kaia**: `lib/url.ts:537` の `resolveChainSlugParam` は kaia を **既に accept**、`hasDeployment('jpyc','kaia')` も true、`isGaslessSupported(JPYC@Kaia)` も true で URL parser レベルでは Kaia が通る。**ただし** `TipEmbedGenerator` の chain chooser UI は `settings.token === 'usdc'` の時にしか表示されない (`components/TipEmbedGenerator.tsx:178`) → creator が JPYC tip URL を作るとき、UI から Kaia を選ぶ手段が無い。
  - Pimlico Kaia sponsorship policy は既に `DEPLOY_CHECKLIST.md §9.3` で「All Chains ON」が設定済 (= Tip でも追加コストなく動く想定)。
  - つまり **必要なのは TipEmbedGenerator の UI のみ** (chain chooser を JPYC 時にも出す)。
- **Cross-chain USDC**: 全く未対応。`TipForm` は `CrossChainHint` を mount していない (grep 確認済)。`TipEmbedGenerator` にも `crossChain` toggle が無く、`TipParams` 型 (`lib/url.ts:408-423`) に `crossChain` field も無い。

### 1.2 ゴール (parity)

| # | 機能 | 現状 (Tip) | Payment page (参考) | 本プランの達成状態 |
|---|---|---|---|---|
| G1 | JPYC × Kaia chain 選択 | URL parser は OK、UI 不在 | `QrGenerator.tsx:394` で Polygon / Kaia から選択可 | TipEmbedGenerator UI でも Polygon / Kaia から選択可 |
| G2 | USDC cross-chain 支払 | 完全未対応 | PaymentForm が `CrossChainHint` を mount、QrGenerator に crossChain toggle 有 | TipForm が `CrossChainHint` を mount、TipEmbedGenerator に crossChain toggle 追加 |

### 1.3 Out of scope (明示)

- **Solana support** (Phase 4b-2 SHELVED)
- **JPYC cross-chain (Polygon ↔ Kaia)**: Circle Gateway / CCTP V2 は USDC 専用。JPYC 自体は cross-chain 不可
- **USDT → USDC swap aggregator** (JP 暗号資産サービス仲介業 No-Go)
- **Tip standard mode の追加** (Tip は gasless 固定の preset セマンティクスを維持)
- **Tip での split 受取人** (Tip は creator 1 人への送金が基本)
- **Vercel CLI deploy** (git push のみで auto deploy)

### 1.4 非要件 (絶対保証)

- 既存 Tip embed iframe snippet (creator が既に発行・貼付済 URL) は **breaking change 無し** で動作継続 (URL params 完全後方互換)
- localStorage schema (`openpay:tip-settings:v2`) の version 番号は据え置き (互換 sanitize で吸収)
- 共通 hook (`useCrossChainPayment`) / component (`CrossChainHint`, `CrossChainSourceChooser`) はそのまま再利用、Tip 専用変種は作らない

---

## 2. 制約・依存・既存パターン

### 2.1 再利用する共通実装 (file:line)

| 共通 asset | 場所 | Tip での再利用方法 |
|---|---|---|
| `CrossChainHint` component | `components/CrossChainHint.tsx:48` | TipForm から PaymentForm と同じ props 形で mount (`PaymentForm.tsx:484-494`) |
| `CrossChainSourceChooser` | `components/CrossChainSourceChooser.tsx:41` | CrossChainHint 内部で間接利用 (Tip 側で touch 不要) |
| `useCrossChainPayment` hook | `hooks/useCrossChainPayment.ts:65` | CrossChainHint 内部で間接利用 |
| `enumeratePathOptions` | `lib/crossChain/pathEnumerator.ts:94` | hook 経由で透過利用 |
| `JPYC_CHAINS`, `isJpycChainSlug` | `lib/chains.ts:169,171` | TipEmbedGenerator の chain chooser で直接 map |
| `USDC_CHAINS` | `lib/chains.ts:143` | 既存利用継続 |
| `normalizeChainForToken` | `hooks/useQrSettings.ts:100` | `useTipSettings.ts:7` で既に import 済 → そのまま利用 |
| `resolveChainSlugParam` (URL parser) | `lib/url.ts:262` | `parseTipParams` から既に呼ばれている → **Kaia accept 済、追加変更不要** |
| `useErc20BalanceAndChain` | `hooks/useErc20BalanceAndChain.ts` | TipForm が既に使用 (`TipForm.tsx:89`)、変更不要 |
| `PayMode`, `GasMode`, `TokenSymbol` SoT | `lib/fee.ts`, `lib/tokens.ts` | 既存 import を維持 |

### 2.2 Tip 固有制約

1. **embed iframe 環境** (`TipEmbedGenerator.tsx:103-113`): creator サイトに `<iframe width="380" height="640">` で埋め込まれる。
   - 既存 e2e `tip.spec.ts:50-69` (380×640 overflow smoke) を拡張して cross-chain ON 時もチェック。
   - iframe 内 wagmi `useSwitchChain` は標準経路 → PaymentForm と同等の挙動が期待できる。

2. **gas=customer 固定 (gasless 専用)** (`components/TipForm.tsx:70-79`):
   - Tip は creator 受取が `preset - fee`、fan 支払が `preset + gas` の preset セマンティクス。
   - cross-chain でも Tip は gasless を維持。CrossChain path の destination 着金は普通の USDC transfer、merchant 受取は dest chain の deployment で `useBatchPayment` をそのまま呼ぶ既存経路を維持。

3. **単一 chain receiver** (`TipParams.to` は `Address`、chain は 1 つ):
   - Cross-chain で dest が選択された場合、creator の同一 0x address に dest chain 上の USDC が届く。EOA 前提で各 EVM chain 同一秘密鍵から派生のため、creator は dest chain (Base/Arb/OP/Polygon/Ethereum 5 chain のどれか) で USDC を受信できる前提 (PaymentForm と同じ仮定)。

4. **Pimlico Kaia sponsorship 余裕**: 既に「All Chains ON」設定済。Tip 流量増加は `pimlico-balance-alert` で Polygon + Kaia 合算監視。

5. **localStorage schema 互換** (`hooks/useTipSettings.ts:24`):
   - 現 key: `openpay:tip-settings:v2` (`TipSettings` 型は 10 field)。
   - 新 field `crossChain: boolean` を追加。version bump 不要 (`v2` のまま、sanitize で boolean チェック)。

6. **Tip URL の crossChain 出力規則**:
   - `buildTipPath` は `crossChain === false` のみ URL に出力 = creator が opt-out した時だけ URL に `crossChain=false`。Default URL は不変 → **既存 embed snippet は 1 文字も変わらない**。

### 2.3 既知の Caveats

| Caveat | 影響 | 対処 |
|---|---|---|
| iframe 内で wallet (Coinbase Wallet) の switchChain が fail | cross-chain Gateway/CCTP path が動かない可能性 | エラーは既存の `CrossChainHint` errorPrefix で UI 表示 |
| Pimlico bundler が Kaia (8217) で degraded する incident 履歴 | Tip でも sponsorship 失敗 → 既存 `errorGasCongested` ハンドラで吸収 | 既存 path で十分 |
| `useCrossChainPayment` の `useSwitchChain` が Kaia 非対応 wallet で fail | merchant 着金 chain が Kaia の場合は cross-chain 経路は意味がない (USDC Kaia なし) | N/A (USDC Kaia deployment 自体が存在しない、`lib/tokens.ts` 'unavailable' で結界) |

---

## 3. アーキテクチャ詳細

### 3.1 機能 1: JPYC × Kaia chain 選択 (Tip)

データフロー (creator が embed snippet を作成 → fan が tip 送信):

```
Creator UI (TipEmbedGenerator)
  ├─ token = jpyc を選択 (既存)
  ├─ [新規] chain chooser を JPYC 時にも表示
  │   └─ JPYC_CHAINS (= ['polygon', 'kaia']) を grid で render
  ├─ selectChain(slug) → setSettings → localStorage 永続化
  └─ buildTipUrl(origin, {to, token:'jpyc', chain:'kaia', ...})
       └─ chain !== DEFAULT_CHAIN_FOR_SYMBOL.jpyc (= 'polygon') なら
          URL に ?chain=kaia を出力 (lib/url.ts:473)

Fan UI (TipForm via /tip/0x.../?token=jpyc&chain=kaia)
  ├─ parseTipParams が chain=kaia を accept
  │   (resolveChainSlugParam が isJpycChainSlug('kaia')=true、
  │    hasDeployment('jpyc','kaia')=true、
  │    isGaslessSupported(JPYC@Kaia)=sponsorship=true で通る)
  ├─ TipForm が受け取った params.chain = 'kaia' で:
  │   ├─ deploymentForSlug('jpyc','kaia') → JPYC v3 address + chainId 8217
  │   ├─ chainForSlug('kaia') → viem `kaia` chain object
  │   ├─ useBatchPayment(deployment) (= 既存 hook、変更なし)
  │   ├─ useSmartAccount(deployment, true) (mav2 ガード経由、kaia は SimpleAccount only)
  │   └─ Pimlico sponsorship policy chainId 8217 で gasless 動作
  └─ requiredChain.name = "Kaia" を header 等に既存表示 (TipForm.tsx:247)
```

**コード変更ポイント**: TipEmbedGenerator の chain chooser を JPYC token 時にも render するだけ。Tip 側は parser/form ともに既に Kaia 対応済。

### 3.2 機能 2: USDC cross-chain 支払 (Tip)

データフロー (creator が cross-chain ON で embed → fan が他 chain USDC で tip):

```
Creator UI (TipEmbedGenerator)
  ├─ token = usdc を選択 (既存)
  ├─ chain = Base 等を選択 (既存)
  ├─ [新規] crossChain toggle (default ON、token=usdc 時のみ表示)
  └─ buildTipUrl(origin, {to, token:'usdc', chain:'base', crossChain:false?})
       └─ crossChain === false のみ URL に ?crossChain=false

Fan UI (TipForm via /tip/0x.../?token=usdc&chain=base[&crossChain=false])
  ├─ [新規] parseTipParams が crossChain field を解釈
  │   (crossChainRaw==='false' → false、それ以外 true)
  ├─ TipForm が受け取った params.crossChain で:
  │   ├─ direct 経路: 既存の useBatchPayment で USDC@base 送金 (変更なし)
  │   └─ [新規] CrossChainHint を mount (PaymentForm.tsx:484 と同じ props 形)
  │       ├─ token='usdc', enabled=params.crossChain !== false
  │       ├─ targetChainId=deployment.chainId, recipient=params.to
  │       ├─ requiredAtomic=totalCustomerOutflow, displayDecimals=6
  │       ├─ tokenAddress=deployment.address
  │       └─ 内部で useCrossChainPayment → balances fetch → pathOptions enumerate
  ├─ fan は 2 動線のどちらかを選ぶ:
  │   ├─ direct = 既存 「{amount} を送る」ボタン (variant: gasless, fee+gas 上乗せ)
  │   └─ cross-chain = CrossChainSourceChooser の「選択したチェーンで支払う」
  │       (Gateway = ~5s / CCTP V2 = ~30s、source chain で USDC burn → dest で mint)
  └─ 完了後 SuccessPanel が CrossChainHint 内部で表示 (既存)
```

**Tip ↔ Payment の差異 (cross-chain 文脈)**:

- Tip は amount が preset (デフォルト) or 自由入力。amount = 0 のときは hint 非表示 (CrossChainHint 自身が `requiredAtomic <= 0n` で早期 return)。
- Tip は **standard mode 無し**。`PaymentForm.tsx:155` の `useStandardPayment` 系の hook は呼ばない。
- CrossChainHint からの success → 既存の Tip success 処理 (`TipForm.tsx:132-198`、webhook + logger) には流さず、CrossChainHint 内部 SuccessPanel に閉じる (= PaymentForm と同じ動作)。**意思決定ポイント Q1 参照**。

### 3.3 共通の Cross-chain 経路 (再掲)

`CrossChainHint` 内部:

1. `useCrossChainPayment({targetChainId, requiredAtomic, recipient, enabled})` が:
   - wagmi `useAccount` で connected account 取得
   - `readAllCrossChainBalances(account)` で 7 chain wallet USDC + Gateway pre-deposit を fetch
   - `enumeratePathOptions` で direct / gateway / cctp-v2 の全 viable options を返却
2. `CrossChainSourceChooser` で fan が source chain を選択
3. `executeOption(option)` で Gateway burn intent sign or CCTP V2 burn → attestation poll → dest mint
4. SuccessPanel で完了表示

**何も Tip 専用に手を加えない** (props 渡しのみ)。

---

## 4. 新規ファイル & 変更ファイル一覧

### 4.1 変更ファイル

| ファイル | 目的 | 概算 LOC |
|---|---|---|
| `components/TipEmbedGenerator.tsx` | chain chooser を JPYC 時にも render、`crossChain` toggle を USDC 時に追加、settings.crossChain を URL params に反映 | +60 / -10 (=+70 行) |
| `components/TipForm.tsx` | `CrossChainHint` を USDC 時に mount (PaymentForm と同じ props pattern) | +20 |
| `hooks/useTipSettings.ts` | `TipSettings.crossChain: boolean` 追加、`DEFAULT_SETTINGS.crossChain = true`、sanitize で boolean 判定 | +6 |
| `lib/url.ts` | `TipParams.crossChain?: boolean` 追加、`buildTipPath` で false 出力、`parseTipParams` で false accept | +20 |
| `messages/ja.json` | TipEmbedGenerator に `chainLabelJpyc` / `crossChainHeading` / `crossChainToggleLabel` / `crossChainToggleDescription` 追加 | +6 |
| `messages/en.json` | 同上 (英訳) | +6 |
| `tests/components/TipEmbedGenerator.test.tsx` | JPYC + Kaia / USDC + crossChain toggle テスト | +50 |
| `tests/components/TipForm.test.tsx` | CrossChainHint mount / Kaia chain switch テスト | +60 |
| `tests/hooks/useTipSettings.test.tsx` | crossChain default + sanitize + Kaia 永続化 | +30 |
| `tests/lib/url.test.ts` | TipParams crossChain roundtrip + Kaia roundtrip | +40 |
| `e2e/tip.spec.ts` | Kaia smoke + iframe overflow regression | +30 |
| `docs/DEPLOY_CHECKLIST.md` | §9.7 Tip parity SOP | +20 |
| `README.md` | Tip widget セクションに Kaia + cross-chain 記述 | +10 |

### 4.2 新規ファイル

**なし** — 共通 hook / component を全て再利用、Tip 専用の新規ファイル無し。

### 4.3 触らないファイル (重要)

- `components/CrossChainHint.tsx`, `components/CrossChainSourceChooser.tsx`
- `hooks/useCrossChainPayment.ts`
- `lib/crossChain/*` (pathEnumerator, router, balance, execute, gateway, cctp, config, types)
- `lib/chains.ts` (既存定義をそのまま import)
- `lib/tokens.ts` (TOKEN_DEPLOYMENTS は既に網羅)
- `lib/pimlico.ts` (Kaia sponsorship 経路既存)
- `lib/paymentLog.ts` (Tip 用拡張は本プラン範囲外)

---

## 5. データ migration

### 5.1 既存 embed snippet (creator 既発行 URL)

- 旧 URL 例: `https://openpay.example.com/tip/0xABC?token=usdc` (chain 省略 = base)
- 本プラン投入後も **URL は 1 文字も変わらない**:
  - parseTipParams は chain 未指定で base にフォールバック (既存挙動、`lib/url.ts:267`)
  - crossChain 未指定なら true 扱い (cross-chain 経路が ON、但し hint 自体は balance / amount 条件で skip 可能)
  - 旧 snippet は **見た目・挙動とも変化なし** (cross-chain hint は default ON でも balance 充足 + connect なしなら出ない)

### 5.2 localStorage schema (creator dashboard)

```ts
crossChain: typeof loaded.crossChain === 'boolean'
  ? loaded.crossChain
  : DEFAULT_SETTINGS.crossChain,  // = true
```

- 旧 schema (crossChain なし) から新 schema への migrate は sanitize 1 回で完了
- schema version bump 不要
- `useQrSettings.ts:158` と同型のロジックを真似する

### 5.3 Tip URL の crossChain=false 出力規則

- creator が cross-chain toggle を OFF にしない限り、URL に `crossChain` は **出ない**
- false 時のみ `crossChain=false` を URL に明示
- これにより:
  - 旧 creator が新 dashboard で再生成しても、cross-chain ON のままなら URL は不変
  - cross-chain OFF を選んだときだけ URL が変わる

---

## 6. テスト方針

### 6.1 新規 unit / integration test

| テストファイル | 追加テスト数 | 内容 |
|---|---|---|
| `tests/lib/url.test.ts` | +4 | (a) parseTipParams で `crossChain=false` を accept、(b) 未指定なら true、(c) buildTipPath の default URL 不変、(d) jpyc + kaia roundtrip |
| `tests/hooks/useTipSettings.test.tsx` | +3 | (a) crossChain default true、(b) 文字列 'true' は default に倒す、(c) jpyc + 'kaia' 永続化 |
| `tests/components/TipEmbedGenerator.test.tsx` | +5 | (a) JPYC 時に chain chooser 表示、(b) Kaia click → URL `chain=kaia`、(c) USDC 時 crossChain toggle 表示、(d) toggle off → URL `crossChain=false`、(e) JPYC 時 crossChain toggle 非表示 |
| `tests/components/TipForm.test.tsx` | +4 | (a) USDC params で CrossChainHint mount、(b) JPYC で非 mount、(c) `crossChain: false` で hint props.enabled=false、(d) Kaia chain で header "Kaia" 表示 |

### 6.2 既存テスト影響評価

- 既存 ~2318 テスト中、影響箇所:
  - `tests/components/TipEmbedGenerator.test.tsx` (既存 11 test): URL 生成 assertion → 影響なし
  - `tests/components/TipForm.test.tsx` (既存 ~35 test): CrossChainHint を mock 必須 (PaymentForm.test.tsx と同じ pattern)
  - `tests/hooks/useTipSettings.test.tsx`: 既存 default 比較 test を partial match に書き換え
  - `tests/lib/url.test.ts`: 引き続き pass

### 6.3 e2e test

- `e2e/tip.spec.ts` に +2 test:
  1. **Kaia smoke**: `/ja/tip/0x.../?token=jpyc&chain=kaia` で header に `Kaia` text 表示
  2. **iframe overflow regression**: 380×640 + USDC params + wallet 未接続 → hint 非 mount = overflow check pass

### 6.4 Coverage 影響

- `lib/url.ts` の buildTipPath / parseTipParams に新 branch → 上記 unit test で網羅
- `hooks/useTipSettings.ts` の boolean sanitize → 1 branch
- `components/TipForm.tsx`, `TipEmbedGenerator.tsx` は新規 UI 行 → 新規 test でカバー

---

## 7. 検証手順 (Verification)

### 7.1 自動

```bash
npm run typecheck
npm run lint
npm test
npm run test:coverage
NEXT_PUBLIC_NETWORK_ENV=testnet NEXT_PUBLIC_PIMLICO_API_KEY=dummy \
  NEXT_PUBLIC_FEE_RECEIVER_ADDRESS=0x000000000000000000000000000000000000dEaD \
  npm run build
npm run e2e
```

### 7.2 手動 (dev 環境)

**機能 1 (Kaia)**:
1. `npm run dev` で起動、`/ja` を開く → TipEmbedGenerator tab
2. token=JPYC を選択
3. **[新規] chain chooser が表示される (Polygon / Kaia)**
4. Kaia を click → 生成された Tip URL に `&chain=kaia` が含まれる
5. URL を新タブで開く → TipForm の header に `Kaia · JPYC` が表示される
6. wallet 接続 → Kaia network に switch 要請 → switchChain で Kaia へ
7. preset 選択 → Pimlico sponsorship 経由で gasless 送信成功

**機能 2 (cross-chain)**:
1. token=USDC + chain=Base を選択
2. **[新規] crossChain toggle が表示される (default ON)**
3. URL を新タブで開く → TipForm に CrossChainHint が mount
4. fan wallet を別 chain (例: Avalanche) で接続 → CrossChainSourceChooser が Avalanche option 表示
5. 「選択したチェーンで支払う」click → Gateway/CCTP V2 経路で Base への mint
6. SuccessPanel が表示される

**OFF route**:
1. crossChain toggle を OFF にして URL 再生成 → `?crossChain=false` が URL に出る
2. URL を開いた fan で CrossChainHint が出ない

### 7.3 deploy 前 (staging)

- `DEPLOY_CHECKLIST.md` 新 §9.7 (Tip parity SOP) を全 box 埋め
- Sentry に新規 `tip.cross-chain.*` event が出ていないことを 1h 監視

---

## 8. リスク & 不明点

### 8.1 リスク

| リスク | 影響度 | 緩和策 |
|---|---|---|
| iframe 内で wallet (Coinbase Wallet) の switchChain が fail | Mid | CrossChainHint 既存の error 表示で吸収 |
| Pimlico Kaia sponsorship 残高枯渇 | Low-Mid | 既存の `pimlico-balance-alert` で Sentry alert |
| 既存 embed snippet の挙動変化 | High → Low | URL 完全後方互換 + CrossChainHint は requiredAtomic > 0 + connected wallet が条件のため、preset 未選択 / 未接続 fan には何も出ない |
| TipForm に hint mount で iframe 内縦スクロール発生 | Low | e2e で smoke、接続済 layout は将来要素配置調整可能 |
| 共通 hook の queryKey 衝突 | Low | account + targetChainId を含む、cache 共有が望ましい挙動 |

### 8.2 Sentry observability

新規 event は発生しない (CrossChainHint 内部の既存 `cross-chain.execute.success` / `cross-chain.execute.failed` / `cross-chain.balance-query.failed` が Tip からも発火するだけ)。

---

## 9. 実装ステップ (順序)

リスク順 (小 → 大) で並べ、各 step ごとに test pass を確認:

### Step 1 — URL parser / type 拡張 (低リスク、純データ層)
- `lib/url.ts`: `TipParams.crossChain?: boolean`、buildTipPath で false 出力、parseTipParams で false accept
- `tests/lib/url.test.ts` で +4 test 追加

### Step 2 — Settings hook 拡張
- `hooks/useTipSettings.ts`: TipSettings.crossChain: boolean + DEFAULT + sanitize
- `tests/hooks/useTipSettings.test.tsx` で +3 test

### Step 3 — TipEmbedGenerator UI (Kaia)
- chain chooser の condition を「usdc なら USDC_CHAINS、jpyc なら JPYC_CHAINS で render」(=QrGenerator と同型)
- gasless 非対応フィルタは USDC 時のみ適用
- i18n: `chainLabelJpyc` 追加
- `tests/components/TipEmbedGenerator.test.tsx` で 2 test

### Step 4 — TipEmbedGenerator UI (cross-chain toggle)
- USDC 時に checkbox 追加 (QrGenerator のパターン再現)
- buildTipUrl で `crossChain: settings.token === 'usdc' ? settings.crossChain : undefined`
- i18n: `crossChainHeading` / `crossChainToggleLabel` / `crossChainToggleDescription`
- `tests/components/TipEmbedGenerator.test.tsx` で 3 test

### Step 5 — TipForm に CrossChainHint mount
- import + USDC 時の mount (PaymentForm.tsx:484-494 を 1:1 移植)
- `tests/components/TipForm.test.tsx` で CrossChainHint mock + 4 test

### Step 6 — e2e
- `e2e/tip.spec.ts` で +2 test

### Step 7 — Docs
- DEPLOY_CHECKLIST.md §9.7 追加
- README.md Tip widget セクションに 1 段落追記

### Step 8 — Lint / build / coverage / push
- 全自動チェック → Vercel auto-deploy → 手動検証

**PR 分割案**: Step 1+2 / Step 3 / Step 4+5 / Step 6+7 の 4 PR、または 1 PR 一括 (合計 +360 LOC でレビュー可能)。

---

## 10. 期待 diff サイズ

| カテゴリ | LOC |
|---|---|
| lib (url.ts) | +20 |
| hooks (useTipSettings.ts) | +6 |
| components (TipEmbedGenerator + TipForm) | +90 |
| messages (ja + en) | +12 |
| tests (unit + integration) | +180 |
| e2e | +30 |
| docs | +30 |
| **合計** | **~370 LOC (net + 約 -10 = +360)** |

参考: Payment cross-chain 投入時の `1f579ad` が +500 LOC 級、本 Tip parity は共通 hook 完全再利用のため約 70% に圧縮。

---

## 11. ユーザー承認済の意思決定 (resolved questions)

### Q1. Cross-chain success 時の webhook 発火 ✅ 決定: A (発火しない)

PaymentForm と一貫: cross-chain mint 完了で webhook は POST しない。creator は paymentLog stats endpoint で追跡。CrossChainHint は共通 component を保つ。

### Q2. Tip dashboard の存在 ✅ 解決済 (実装段階に進入可)

TipEmbedGenerator は `app/[locale]/page.tsx:97` の creator dashboard tab で mount されている (grep 確認済)。UI 変更は user に届く。

### Q3. Kaia chain での creator wallet 想定

Tip widget の `params.to` (creator address) は EOA 想定。Kaia chain で USDC を直接受信する creator は実在しない (USDC Kaia なし)。本プランでは JPYC × Kaia + USDC cross-chain (multi → Base/Arb/OP/Polygon/Ethereum dest) に範囲を限定。

- creator が「Kaia で JPYC tip だけ受けたい」というユースケースは現実にあるか? それとも社内 demo only か?
- もし demo only なら chain chooser に注意書きを追加するか
- **推奨**: 注意書き不要 (PaymentForm 側でも Kaia 注意書きはない、`messages/ja.json:235-237` の `errorMav2KaiaPolygon` で UI fallback 済)

### Q4. cross-chain crossChain toggle の default ✅ 決定: default true

Payment と一貫、creator が embed した瞬間から cross-chain 受信が ON。fan は dest chain に USDC がなくても他 chain から支払可、tip 獲得確率上がる。

### Q5. Tip embed iframe での CrossChainHint UX 検証

iframe 380×640 内で CrossChainHint + Source Chooser + button が見切れず収まるか、wallet 接続 + balance あり状態の screenshot を取得するか?
- **推奨**: e2e で wallet 未接続 = hint なし の invariant のみ smoke、接続済 layout は手動でスクリーンショット確認、見切れあれば別 PR でレイアウト微調整

### Q6. 完了基準 ✅ 決定: 案 A

自動テスト全 pass + 手動検証 8 ケース (Section 7.2) すべて PASS で完了。1 PR で送り出し、実需要 confirm は別途 KPI でトラック。

---

## 12. 参考: file:line refs まとめ

- TipForm 構造: `components/TipForm.tsx:1-476`
- TipEmbedGenerator 構造: `components/TipEmbedGenerator.tsx:1-439`
- TipEmbedGenerator mount 元: `app/[locale]/page.tsx:97`
- TipSettings hook: `hooks/useTipSettings.ts:1-86`
- TipParams + parser: `lib/url.ts:405-583`
- Tip page route: `app/[locale]/tip/[address]/page.tsx`
- PaymentForm cross-chain wiring: `components/PaymentForm.tsx:484-494`
- QrGenerator chain chooser: `components/QrGenerator.tsx:386-418, 770-794`
- QrSettings hook (crossChain pattern): `hooks/useQrSettings.ts:35-56, 156-162`
- JPYC_CHAINS / isJpycChainSlug: `lib/chains.ts:165-176`
- USDC_CHAINS / buyerUsdcChainNames: `lib/chains.ts:136-161`
- chainNameForId / nativeSymbolForChainId: `lib/chains.ts:228-236`
- CrossChainHint signature: `components/CrossChainHint.tsx:31-46`
- useCrossChainPayment: `hooks/useCrossChainPayment.ts:65-314`
- pathEnumerator: `lib/crossChain/pathEnumerator.ts:94-196`
- TipForm tests: `tests/components/TipForm.test.tsx:1-740`
- TipEmbedGenerator tests: `tests/components/TipEmbedGenerator.test.tsx:1-218`
- parseTipParams tests: `tests/lib/url.test.ts:573-975`
- Tip e2e: `e2e/tip.spec.ts:1-83`
- Pimlico Kaia SOP: `docs/DEPLOY_CHECKLIST.md §9.3`

---

End of plan.
