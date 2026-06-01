# Phase B hardening — JPYC self-host relayer (mainnet 投入の前提)

## Context

recover/free の self-host relayer は Amoy で動作確認済 (forwarder `0x752B…`)。mainnet で
**実マネー**を安全に relay するための堅牢化が Phase B。Codex plan-review (approve-with-changes)
の必須項目。全て flag-gated で、Phase B 完了 + 外部監査まで mainnet は env で無効。
背景: memory:jpyc-eip3009 / gasless-legal-jp。

## 目標

serverless 並行実行 + 濫用 + ガス高騰 + RPC 応答喪失 の下で:
1. **二重支払いゼロ** (broadcast 後の不確定で standard へ fallback しない)
2. relayer の **POL を濫用 (Sybil) / 高騰から守る**
3. **赤字 relay をしない** (回収 fee を超えるガスでは relay しない)

## KV 前提 (Upstash Redis REST・lib/kv.ts)

現状 list ops のみ公開。`call(['CMD', ...])` で任意 Redis コマンドが叩けるので **B1 で
INCR / GET / SET(NX, EX) / EXPIRE を追加**。KV 障害時の degrade 方針を各機能で定義 (後述)。

## 増分 (依存順)

- **B1 KV primitives**: `kvIncr` / `kvGet` / `kvSet(value,{nx,ttlSec})` / `kvExpire` を lib/kv.ts に
  追加 (薄い Redis wrapper) + DI/unit test。**低リスク・他の前提**。
- **B2 idempotency**: 検証通過後 submit 前に `SET relay:idem:{chainId}:{from}:{nonce} NX EX 1800`。
  既存 (重複 POST = network retry / double-click) なら **再 broadcast せず pending を返す**。
  nonce は EIP-3009 nonce (recover=commitment nonce / free=ランダム nonce・どちらも authorization 単位で
  一意・on-chain `_authorizationStates` と同一空間)。**fail-safe**: SET NX の応答が不確定 (KV REST の
  応答喪失) なら「既存=重複」とみなし pending を返す (二重 submit より安全側)。recover + free 両 core に。
- **B6 → 改訂: nonce 管理 (KV allocator は不採用)**: Codex 指摘 — KV `INCR` 自体に ambiguous-response
  問題 (Redis 成功 + HTTP 応答喪失 → 採番値不明 → 再試行で二重採番=nonce hole) があり、解こうとした
  バグを allocator が再生産する。→ **KV allocator は使わず、submit ごとに `getTransactionCount(pending)`
  で nonce を取り、衝突は透過リトライで吸収する** (アルファ低volume では衝突は稀)。
- **B3 ambiguous-send → pending (+ nonce 衝突リトライ)**: `getTransactionCount(pending)` で nonce 取得 →
  **pre-sign (txHash 事前確定)** → `sendRawTransaction`。送信エラーを分類する:
  - `nonce too low` / `replacement underpriced` (= 別 tx がその nonce を取った・自分の txHash は未 broadcast)
    → **fresh nonce で 1〜2 回リトライ** (再 sign・再 send)。
  - `already known` / 応答に txHash (= mempool に在る=broadcast 済) → その txHash を返し poll。
  - timeout / 接続断 / 不明 (= broadcast したか不確定) → **pending** (relay_error にしない=fallback で
    二重送金を防ぐ)。リトライしない (二重 send を避ける)。
  - pre-broadcast の明確な失敗 (残高不足・署名前) のみ relay_error。
  reconcile は receipt poll + `Settled` ログ走査 (最小は pending UI で Explorer 確認を促す)。
- **B4 global gas budget / circuit breaker**: `INCR relay:budget:{chainId}:{YYYYMMDD}` (TTL 2d)。
  日次上限超で reject (Sybil が fresh EOA を量産して POL を枯渇させる griefing を上限で止める)。
- **B5 gas-price ceiling (赤字防止)**: `estimateGas × effectiveGasPrice` を回収 fee 相当に換算し、
  **fee + margin を超える高騰時は reject** (赤字 relay をしない)。worst-case を超える混雑は弾く。

## 相互依存 (実装順の肝・改訂後)

```
B1(KV基盤) → B2(idempotency, fail-safe)
B3(getTransactionCount + pre-sign + 衝突リトライ + 応答喪失=pending)   ← KV allocator 不要
B4/B5 は独立 (B1 の上)。
```
- **KV allocator (旧 B6) は不採用**: KV `INCR` の ambiguous-response (Codex 指摘) が nonce hole を
  生むため。代わりに B3 が `getTransactionCount(pending)` + 衝突時リトライで nonce を扱う。
- 二重支払いは **多層防御**: client の `relaySettledNoRetry` + B2 idempotency(fail-safe) + B3 pending +
  on-chain `_authorizationStates` (EIP-3009 nonce 再実行不可)。← KV に依存しない最終防壁 (on-chain) が
  あるので、KV degrade 時も二重「決済」(資金) は起きない (二重 submit のガス浪費があり得るのみ)。

## エッジ / リスク (要設計判断)

- **KV 障害時の degrade**: idempotency は **fail-safe** (KV 不確定→重複扱い→pending・二重 submit しない)。
  最終防壁が on-chain `_authorizationStates` なので、KV fail-open でも資金の二重支払いは起きない
  (同一 authorization は1回しか execute されない)。→ **idempotency は fail-open でも安全**、gas budget
  (B4) は fail-open=上限無効化なので mainnet は fail-closed 寄り。要・運用判断。
- **nonce 衝突 (KV allocator 廃止後)**: 並行 submit が同一 pending nonce を取る → 片方 `nonce too low`/
  `replacement underpriced` → fresh nonce でリトライ (自 txHash は未 broadcast なので二重送金にならない)。
  低 volume では稀。高 volume では単一 worker / queue を後続検討。
- **reconcile**: pending (応答喪失) を後で確定させる仕組み (receipt 再 poll / Settled ログ走査)。
  最小は「pending のまま顧客に Explorer 確認を促す」(現状の pending UI)。自動 reconcile は後続。
- **B4 INCR の ambiguity**: budget カウンタも応答喪失で二重カウントしうるが、上限は近似で良く
  二重カウント=早めに止まる (fail-safe 方向) ので許容。

## テスト

各 KV 機能の DI unit (fake kv) + core 統合 (idempotency 重複→pending、nonce 採番、gas-ceiling reject、
budget 超過 reject) + **Amoy 実 chain で並行 submit (nonce 衝突しないか)**。

## 段階 (改訂)

B1(済) → B2(idempotency・済) → B3(getTransactionCount + pre-sign + 衝突リトライ + 応答喪失=pending・済) →
B4 budget(済) → B5 gas-ceiling(済) → Amoy 並行テスト (同時 submit で nonce 衝突を吸収できるか・次) →
外部監査 → mainnet 有効化。KV allocator (旧 B6) は廃止。
mainnet forwarder は別途 deploy (DeployForwarder + Polygon RPC/key)。

実装済 (commit): B1=ce5d7d0 / B2=deffdc8 / B3=14627aa / B4+B5=本コミット。
env: RELAY_DAILY_TX_CAP (B4・既定500・fail-open) / RELAY_MAX_GAS_COST_WEI (B5・既定0=無効)。
残: Amoy 並行 submit 実 chain 検証 (nonce 衝突吸収) → 外部監査 → mainnet。

## 却下 / 非対象 (今は)

- 完全な自動 reconcile デーモン (pending を継続監視して確定) → 最小は手動/Explorer。後続。
- マルチ relayer (複数 EOA で並列 + nonce 分散) → 単一 relayer + KV nonce で十分 (アルファ規模)。
