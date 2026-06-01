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
- **B2 idempotency**: 検証通過後 submit 前に `SET relay:idem:{chainId}:{from}:{nonce} NX EX 900`。
  既存 (重複 POST = network retry / double-click) なら **再 broadcast せず pending を返す**
  (既存 txHash があれば併せて返す)。recover (forwarderRecover) + free (jpycRelay) 両 core に。
- **B6 nonce allocator**: relayer EOA の **tx-nonce を KV で原子採番** (`INCR relay:nonce:{chainId}`、
  起動/ギャップ時に on-chain `getTransactionCount(pending)` で seed/再同期)。serverless 並行の
  nonce 衝突を回避。**B3 の前提** (pre-sign には確定 nonce が要る)。
- **B3 ambiguous-send → pending**: 上記 nonce で **pre-sign (txHash 事前確定)** → idempotency 記録
  → `sendRawTransaction`。**送信応答喪失/エラーは throw せず pending** を返す (tx が live かもしれず、
  relay_error=fallback=二重送金になるため)。pre-sign 前の失敗 (残高/見積/署名) のみ relay_error。
  reconcile は receipt poll + `Settled` ログ。
- **B4 global gas budget / circuit breaker**: `INCR relay:budget:{chainId}:{YYYYMMDD}` (TTL 2d)。
  日次上限超で reject (Sybil が fresh EOA を量産して POL を枯渇させる griefing を上限で止める)。
- **B5 gas-price ceiling (赤字防止)**: `estimateGas × effectiveGasPrice` を回収 fee 相当に換算し、
  **fee + margin を超える高騰時は reject** (赤字 relay をしない)。worst-case を超える混雑は弾く。

## 相互依存 (実装順の肝)

```
B1(KV基盤) → B2(idempotency) ┐
            → B6(nonce 採番) → B3(pre-sign + 応答喪失=pending)
B4/B5 は独立 (B1 の上)。
```
- **B3 は B6 必須**: auto-nonce (sendTransaction) では txHash が事前に確定せず「応答喪失でも hash 既知」
  が成立しない。pre-sign には固定 nonce が要る。
- 二重支払いは **多層防御**: client の `relaySettledNoRetry` + B2 idempotency + B3 pending + on-chain
  `_authorizationStates` (EIP-3009 nonce 再実行不可)。

## エッジ / リスク (要設計判断)

- **KV 障害時の degrade**: 既存 rate-limit は fail-open (KV 無し=通す)。idempotency/nonce は安全側
  なら **fail-closed (KV 不可なら relay 停止)** が無難 (fail-open だと nonce 衝突/二重 submit の穴)。
  ただし fail-closed は KV flaky 時に relay 停止。→ **mainnet は fail-closed 推奨**、要・運用判断。
- **nonce hole**: 採番後に pre-sign/send が失敗すると nonce に穴 (以降の tx が pending で詰まる)。
  → 失敗時の nonce 返却 or 一定時間後に on-chain count で再同期する recovery が必要。
- **reconcile**: pending (応答喪失) を後で確定させる仕組み (receipt 再 poll / Settled ログ走査)。
  最小は「pending のまま顧客に Explorer 確認を促す」(現状の pending UI)。自動 reconcile は後続。

## テスト

各 KV 機能の DI unit (fake kv) + core 統合 (idempotency 重複→pending、nonce 採番、gas-ceiling reject、
budget 超過 reject) + **Amoy 実 chain で並行 submit (nonce 衝突しないか)**。

## 段階

B1 → B2 → B6 → B3 → (B4, B5) → Amoy 並行テスト → 外部監査 → mainnet 有効化。
mainnet forwarder は別途 deploy (DeployForwarder + Polygon RPC/key)。

## 却下 / 非対象 (今は)

- 完全な自動 reconcile デーモン (pending を継続監視して確定) → 最小は手動/Explorer。後続。
- マルチ relayer (複数 EOA で並列 + nonce 分散) → 単一 relayer + KV nonce で十分 (アルファ規模)。
