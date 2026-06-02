# contracts/ — JPYC ガス回収 forwarder (Foundry)

JPYC ガスレス決済 (OpenPay) の **ガス相当額回収用 forwarder** コントラクト。設計・背景は
`docs/plans/jpyc-relay-gas-recovery.md` と memory:jpyc-eip3009 / memory:gasless-legal-jp。

- `src/Eip3009Forwarder.sol` — 顧客 1 署名 (EIP-3009 `receiveWithAuthorization`) で JPYC を受領し、
  店舗 + feeReceiver にアトミック分割。relayer が POL 立替 → gas 相当額を JPYC 即時回収。

レイアウト: `contracts/src/` (本体) ・ `contracts/test/` ・ `contracts/lib/` (forge deps・gitignore)。
src と lib を同階層に分けている (lib を src 内に置くと依存まで src 扱いで壊れるため)。

> Next.js アプリと同居するため Foundry の全 dir を `contracts/` 配下に隔離している
> (`foundry.toml` 参照)。リポジトリの `lib/` は TypeScript で、Foundry deps は `contracts/lib/`。

## セットアップ

```bash
# 1. Foundry (forge/cast/anvil)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2. 依存を contracts/lib/ に install (監査再現性のためタグ pin)
#    OZ v5.6.1 (SafeERC20/ReentrancyGuard は deploy 契約に含む = 監査対象) / forge-std v1.10.0 (test 専用)
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1 foundry-rs/forge-std@v1.10.0 --no-git

# 3. ビルド & テスト
forge build
forge test -vvv
```

## Amoy への deploy (検証用・監査不要)

```bash
forge create contracts/src/Eip3009Forwarder.sol:Eip3009Forwarder \
  --rpc-url "$NEXT_PUBLIC_POLYGON_AMOY_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --constructor-args 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 "$FEE_RECEIVER_ADDRESS"
```

> mainnet 投入は **外部セキュリティ監査** が前提。Phase B 堅牢化 (B1–B5: idempotency /
> ambiguous-send pre-sign / 日次予算 / gas ceiling) は実装済 + Codex review 全 finding CLOSED +
> Amoy 実環境検証済。監査スコープ・不変条件・脅威モデルは `docs/audit/jpyc-eip3009-audit-scope.md`。
> Amoy (testnet) は監査不要でフロー検証可。

## 実環境検証ハーネス (Amoy)

relay サーバ + forwarder を **実 chain (Amoy)** で検証するスクリプト群 (`scripts/`)。いずれも
`.env.local` を読み、署名前に golden vector で nonce/encode が契約と一致することを fence する。
機密は出力しない (秘密鍵は address のみ導出)。

**前提**: `.env.local` に `RELAYER_PRIVATE_KEY` (POL 保有・self-host relayer) /
`NEXT_PUBLIC_JPYC_FORWARDER_AMOY` / `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` /
`NEXT_PUBLIC_POLYGON_AMOY_RPC_URL`。並行/idempotency テストは追加で `AMOY_TEST_BUYER_KEY`
(JPYC 保有の署名元・使い捨て testnet 鍵) と、KV 検証時は `KV_REST_API_URL` / `KV_REST_API_TOKEN`。
relay endpoint を動かすため別ターミナルで dev server (`npm run dev`) を起動しておく。

```bash
# 1. 前提チェック (読み取り専用): relayer POL / forwarder・JPYC 存在 / KV 到達性 / buyer JPYC 残高
node scripts/amoy-relay-readiness.mjs [buyerAddress]

# 2. 並行 submit (B3 nonce 衝突吸収): 単一 buyer が N 個の DISTINCT authorization を同時 POST →
#    単一 relayer EOA の nonce 競合を誘発。on-chain で照合 (txHash distinct / settle 件数 /
#    nonce 連続=hole なし / feeReceiver・buyer 差分)。
RELAY_URL=http://localhost:3000/api/relay/jpyc N=6 node scripts/amoy-concurrent-settle.mjs

# 3. idempotency (B2): 同一 authorization を 2 回同時 POST → 1 件 success / 1 件 pending
#    (submit 前に弾く=revert/二重 broadcast なし)。on-chain settle 1 回のみ + KV idem key claim を確認。
#    確定後の再 POST が authState 既使用で pending になることも確認。要 KV (未設定だと fail-open で B2 無効)。
RELAY_URL=http://localhost:3000/api/relay/jpyc node scripts/amoy-idempotency.mjs
```

> 注: 重いテスト (60s 級の receipt 待ちが並行) とアプリ動作確認を同じ dev server で同時にやると
> 単一プロセスが飽和する。テストは別ポート (`PORT=3001 npm run dev`) 推奨。
> buyer の使い捨て鍵 / KV は **testnet 専用**にし、mainnet の鍵・KV とは必ず分ける。

実測結果 (2026-06-02): 並行 submit = nonce 衝突を安全吸収 (settle は連続 nonce・未 broadcast 分は
保守的 pending)・idempotency = duplicate を submit 前に弾く・いずれも二重支払いゼロ。詳細は
`docs/audit/jpyc-eip3009-audit-scope.md` §7。

## Deployed addresses

| chain | Eip3009Forwarder | feeReceiver | 備考 |
|---|---|---|---|
| Polygon Amoy (80002) | `0x752B7AaD0089286EB7b553d84D05233d80c9FCB4` | `0x428483FbA62eDCef1E3a100d3799F6d71759c560` | 検証用 (2026-06-02 deploy・未監査) |
| Polygon (137) | — | — | mainnet は監査 + Phase B 後 |

設定: `NEXT_PUBLIC_JPYC_FORWARDER_AMOY` に上記アドレスを入れると Amoy が recover モードになる。
feeReceiver は `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` と一致必須 (一致しないと署名検証が通らない)。
