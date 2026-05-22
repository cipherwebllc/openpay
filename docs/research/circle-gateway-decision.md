# Circle Gateway 採用判断書 (decision document)

**作成日**: 2026-05-22
**Phase**: Tier B research 完了 → Tier C / 本線投入の Go/No-Go 判断
**前提資料**: [`circle-gateway-evaluation.md`](./circle-gateway-evaluation.md) (findings)

---

## 1. 判断結果

### 1.1 本線 (customer → merchant 直接 USDC 転送) への統合

**No-Go (確定)**

理由:
- Gateway architecture は **pre-deposit → unified balance → instant mint** が前提。customer は買い物の瞬間にしか USDC 持っていないため pre-deposit overhead が UX を破綻させる
- merchant 側を Gateway custody 化すると OpenPay の非カストディアル価値 (memory: `project_fee_model.md` — 直接着金) を毀損
- Deposit finality が L2 で 13-19 分。一回限り即時決済の店舗 UX と本質的に不適合
- 需要シグナル不在 (memory: `feedback_demand_first.md`) — 顧客 / 店主からの要望ゼロ

→ **OpenPay 本線は現状の CCTP / Gateway 非依存の直接転送を継続**。

### 1.2 実験トラック (AI agent / x402 / chain abstraction) への統合

**Conditional Go**

「実験 PoC branch を 1 つ作る」価値あり。ただし以下 §2 の前提条件を満たすこと。

---

## 2. 実験トラック PoC の Go 条件

### 2.1 Hard prerequisites (これがダメなら停止)

実装着手前に **すべて Yes** が必須。

- [ ] **既存 x402 plan (`/.claude/plans/iridescent-munching-tower.md`) が先に動いている**: Coinbase facilitator + USDC 経路で x402 alpha が本番に lit している状態を前提とし、Gateway はその上に payment source plugin として後付け
- [ ] **HashPort wallet (Alchemy MAv2 + EIP-7702) で burnIntent EOA sign が通る** ことを testnet 実機検証で確認: これが No なら主要 target wallet (memory: `project_hashport_target.md`) で動かないので意味なし
- [ ] **Circle SDK の Proprietary license で商用利用に支障無い** ことを Circle に直接確認: 商用 OK でなければ自前 viem 実装に切り替える判断が必要

### 2.2 Soft preferences (満たさなくても進めるが望ましい)

- Coinbase 公式 facilitator が Gateway 対応の roadmap を public commitment している (= 自前 facilitator が永続実装にならない見通し)
- testnet attestation API が日本 IP から問題なくアクセスできる
- npm package `@circle-fin/unified-balance-kit` が引き続き活性メンテ (現在 3 日前更新で OK)

---

## 3. 実験トラック PoC Scope (Go の場合)

### 3.1 In Scope

- 新規 namespace `lib/gateway/` 配下に隔離した PoC コード
- testnet only でスタート (Polygon Amoy + Base Sepolia の 2 chain)
- 1 つの demo route (例: `app/[locale]/experimental/gateway-demo/page.tsx`)
- `EXPERIMENTAL_GATEWAY_ENABLED=true` env でのみマウント
- burnIntent EIP-712 sign の動作確認 (HashPort wallet 想定)
- attestation 取得 + destination chain mint まで 1 往復
- README に「実験」section + production 利用想定外の disclaimer

### 3.2 Out of Scope (Tier C PoC 範囲では作らない)

- mainnet 投入
- 既存 `/pay`, `/tip`, `/checkout`, `/scan` への統合
- merchant 側の Gateway custody 化
- JPYC との連携 (Gateway は USDC のみ)
- 自前 x402 facilitator (これは別 phase。x402 alpha 完了後に検討)
- production-grade error handling / retry / observability
- multi-chain matrix (まず 2 chain で動かす)

### 3.3 隔離 (本線非影響) の技術的保証

- `lib/gateway/` を新規ディレクトリとして作成、既存 module から import されない
- `app/[locale]/pay`, `tip`, `checkout`, `scan` から `lib/gateway/*` への import 禁止 (lint rule か code review で gate)
- env flag `EXPERIMENTAL_GATEWAY_ENABLED` が default false、production では明示有効化が必要
- README + `docs/research/` の場所明示で「実験」ステータスを永続化

---

## 4. 実装順序の戦略的位置付け

```
[完了] 戦略合意 (本書 §1)
   ↓
[完了] Tier B research (circle-gateway-evaluation.md)
   ↓
[現在] 判断 = §1 の通り
   ↓
[次] x402 alpha 実装 (既存 plan: iridescent-munching-tower.md)
       ↓ 完了後
[条件付き] Tier C: Gateway PoC build plan 起草 → user 承認 → 実装
       ↓ §2 の 3 gate を通過すれば
[将来] 本線統合の再評価 (この時点で必要なら再 plan)
```

**x402 alpha を先に動かす理由**:
1. Gateway を payment source plugin として乗せる土台が x402 (= source 抽象化が x402 layer に存在)
2. Coinbase facilitator + 通常 USDC で x402 自体の learning を先に取得
3. Gateway を後付けする時点で「動いている x402 に対する delta」として scope が明確化
4. Gateway alone (= x402 なし) では OpenPay の existing UX に bolt-on する自然な場所がない

---

## 5. Tier C PoC の見積もり (将来見積もり、約束ではない)

§2 条件クリア後、Tier C PoC build plan を起草する場合の見込み:

| 項目 | 工数概算 |
|---|---|
| `lib/gateway/` namespace 設計 + EIP-712 sign 実装 | 4-6h |
| attestation API client (viem ベース、ethers v5 SDK 回避) | 3-4h |
| demo page `/experimental/gateway-demo` UI | 3-4h |
| HashPort 実機検証 + testnet 1 往復 | 4-6h |
| 隔離テスト + lint rule (本線 import 禁止) | 2-3h |
| README "実験" section + disclaimer | 1-2h |
| **合計** | **17-25h (= 3-4 days)** |

memory: Kaia PoC (`project_kaia_evaluation.md`) と同等の規模感。

---

## 6. 残存リスク (Decision 後も継続監視)

| リスク | Trigger | 緩和策 |
|---|---|---|
| Circle が attestation API を地域制限 | 日本 IP block 実施 | PoC 初期で実機検証、ダメなら abort |
| `@circle-fin/unified-balance-kit` の Proprietary license が商用 NG | Circle に license 照会で判明 | viem 直接実装に切替 (実装 cost 増だが回避可能) |
| Coinbase facilitator の Gateway 対応が永遠に来ない | x402#447 が closed without merge | 自前 facilitator が永続化、production 投入 No-Go 維持 |
| HashPort + EIP-7702 で burnIntent sign が通らない | testnet 検証で reject | PoC 範囲では別 wallet (普通の EOA) で代替、HashPort 統合は保留 |
| early access 終了後の fee 大幅値上げ | 2026-06-30 以降の Circle 発表 | 価格再評価、AI agent 用途で割合的に問題なければ継続 |
| Gateway prematurely deprecated by Circle | Circle blog で discontinuation 発表 | testnet 隔離なら被害なし、本線非投入を維持 |

---

## 7. Action Items (immediate)

### 即時 (本書合意後)

1. ✅ `docs/research/circle-gateway-evaluation.md` 作成
2. ✅ `docs/research/circle-gateway-decision.md` 作成 (本書)
3. ⏳ x402 alpha plan (`/.claude/plans/iridescent-munching-tower.md`) に「Gateway は payment source plugin として future scope」と 1 段落追記 (= 順序の固定)

### 中期 (x402 alpha 完了後、user が Gateway PoC に進む決定をした場合)

4. ⏳ §2 の 3 つの hard prerequisite を実際に検証
5. ⏳ Tier C PoC build plan を `/.claude/plans/` 配下に起草
6. ⏳ user 承認 → worktree or feature branch で実装

### 長期 (PoC 完了後、本線投入を再評価する場合)

7. ⏳ §2.1 hard prerequisites + §3.3 隔離が機能している実績 + demand signal (= ユーザ要望) の 3 点が揃った時点で再評価

---

## 8. 関連メモリ参照

- `feedback_demand_first.md` — speculative 機能は需要シグナルが出るまで作らない
- `feedback_passive_interop.md` — 標準準拠で受動的に interop
- `project_fee_model.md` — 直接着金は店主に届く、Gateway は本線で破る
- `project_hashport_target.md` — HashPort は MAv2 + 7702、Gateway sign 互換性検証必須
- `project_strategic_direction.md` — 送金機能 phase 1 以外は demand-gated
- `project_kaia_evaluation.md` — 同様の評価先例、demand 待ち pattern

---

## 9. Summary (1 sentence each)

- **本線統合**: No-Go (確定)
- **実験トラック PoC**: Conditional Go, ただし x402 alpha が先 + 3 つの hard prerequisite が gate
- **次の action**: 本書合意 → x402 alpha plan に future scope 段落追記 → x402 alpha 実装に進む
