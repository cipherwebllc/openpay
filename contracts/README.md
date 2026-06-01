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

# 2. 依存 (OpenZeppelin v5 + forge-std) を contracts/lib/ に install
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std --no-git

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

> mainnet 投入は **外部セキュリティ監査 + Phase B (ガス上限 reject / KV nonce / idempotency /
> ambiguous-send 回復)** が前提。Amoy (testnet) は監査不要でフロー検証可。
