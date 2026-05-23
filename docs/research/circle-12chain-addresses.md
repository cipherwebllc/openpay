# Circle Gateway / CCTP V2 contract addresses (audit trail)

**Created**: 2026-05-24
**Phase**: [[cross-chain-12chain-expansion]] phase 4a-1
**Purpose**: chain 拡張の前に USDC / Gateway / CCTP V2 公式 contract address を
公式 docs から確認、間違いで顧客資金消失リスクを排除する。

## OpenPay phase 4a で追加する chain

### Ethereum L1 (domain 0)

| 項目 | mainnet (chain id 1) | testnet Sepolia (chain id 11155111) | 出典 |
|---|---|---|---|
| Native USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | https://developers.circle.com/stablecoins/usdc-contract-addresses (mainnet 確認 2026-05-24)、https://developers.circle.com/stablecoins/quickstart-transfer-10-usdc-on-chain (Sepolia 確認 2026-05-24) |
| Circle Gateway Wallet | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | 全 EVM chain で deterministic 同一 (research artifact `circle-gateway-evaluation.md` §4.4 確認済) |
| Circle Gateway Minter | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | 同上 |
| CCTP V2 TokenMessenger | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | https://developers.circle.com/cctp/evm-smart-contracts (確認 2026-05-23) |
| CCTP V2 MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | 同上 |
| Pimlico ERC20 Paymaster (USDC) | **未対応 (要確認)** — Pimlico ドキュメント記載なし | 同上 | https://docs.pimlico.io/infra/paymaster/erc20-paymaster (確認 2026-05-24、対応 chain list に Ethereum mainnet なし) |
| Pimlico Sponsorship Paymaster | 提供あり (Pimlico 全 EVM chain で動作)、ただし OpenPay の policy id 設定が別途必要 | 同上 | — |

**Pimlico gasless 制約 (本 phase の重要決定)**:
- Pimlico の **USDC ERC20 Paymaster は Ethereum mainnet で未対応** (cost 経済性のため deploy されていない)
- → Ethereum USDC は **gasless mode 不可、standard mode のみ**
- 実装: `lib/tokens.ts` の `PaymasterMode` union に `'unavailable'` を追加、Ethereum USDC entry はこの mode、`lib/url.ts` で URL parse 時に `gasless + Ethereum USDC` 組合せを reject

### Block time / maxBlockHeight buffer

| chain | block time | OpenPay の `defaultBlockHeightOffset` |
|---|---|---|
| Ethereum L1 (post-Merge) | ~12s | **100 blocks** = 1200s ≈ 20 min |
| Sepolia | ~12s | 100 blocks |

`lib/crossChain/gateway.ts` の `PER_CHAIN_BLOCK_OFFSET` Map に上記 entry 追加。

## 既存対応 chain (リファレンス、変更なし)

| chain | mainnet USDC | testnet USDC |
|---|---|---|
| Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Arbitrum | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| Optimism | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` |
| Polygon | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` |

## Phase 4b-1 で追加予定 (buyer-only、本 phase では未実装)

### Avalanche C-Chain (domain 1)
- mainnet USDC: `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` (https://developers.circle.com/stablecoins/usdc-contract-addresses)
- testnet Fuji USDC: 要確認時に追記

### Unichain (domain 10)
- mainnet USDC: 要確認時に追記
- testnet Unichain Sepolia: 要確認時に追記

## Phase 4b-2 で追加予定 (Solana)

- mainnet SPL USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- devnet SPL USDC: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Circle Gateway Wallet (Solana): `GATEwdfmYNELfp5wDmmR6noSr2vHnAfBPMm2PvCzX5vu`
- Circle Gateway Minter (Solana): 要確認 (Anchor program ID)

## 確認手順 (operator runbook)

新 chain を本 file に追加する前に必ず:

1. **Circle 公式 docs 2 経路から address fetch**: `developers.circle.com/stablecoins/usdc-contract-addresses` + chain 別 quickstart の 2 箇所で一致確認
2. **Block explorer で contract code 存在確認**: 例 https://etherscan.io/address/0xA0b... で "Contract" tab が存在し、source code verified、Circle 公式と関係する deployer/proxy であること
3. **Pimlico ERC20 Paymaster 対応 chain list 確認**: https://docs.pimlico.io/infra/paymaster/erc20-paymaster の対応 chain list に当該 chain が含まれるか
4. **本 file に追加** + 該当 fact の 出典 URL + 確認日付を必ず記録
5. `npm run test:run` で既存 test regression なし確認
