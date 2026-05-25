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

## Phase 4b-1 で追加 (buyer-only、2026-05-24 投入準備完了)

### Avalanche C-Chain (domain 1)

| 項目 | mainnet (chain id 43114) | testnet Fuji (chain id 43113) | 出典 |
|---|---|---|---|
| Native USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | `0x5425890298aed601595a70AB815c96711a31Bc65` | https://developers.circle.com/stablecoins/usdc-contract-addresses (確認 2026-05-24) |
| Gateway Wallet / Minter | 既存 4 chain と同 deterministic address (`GATEWAY_WALLET_MAINNET/TESTNET` constants 再利用) | 同上 | Circle docs blog "Gateway available on Arbitrum, Avalanche, Base, Ethereum, OP, Polygon PoS, Unichain" (確認 2026-05-24) |
| Pimlico ERC20 Paymaster (USDC) | **未対応** — phase 4b-1 は buyer-only chain で gasless 非対応で構わない設計 (buyer 側 source として balance を見るのみ、direct mint は EVM 自前 gas) | 同上 | https://docs.pimlico.io/infra/paymaster/erc20-paymaster |

### Unichain (domain 10)

| 項目 | mainnet (chain id 130) | testnet Unichain Sepolia (chain id 1301) | 出典 |
|---|---|---|---|
| Native USDC | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` | `0x31d0220469e10c4E71834a79b1f276d740d3768F` | https://developers.circle.com/stablecoins/usdc-contract-addresses + https://www.circle.com/blog/now-available-usdc-on-unichain + https://docs.unichain.org/docs/technical-information/contract-addresses (確認 2026-05-24) |
| Gateway Wallet / Minter | 既存 4 chain と同 deterministic address | 同上 | 同上 (Gateway quickstart unified-balance に Unichain mainnet + Unichain Sepolia 明示記載) |
| Pimlico ERC20 Paymaster (USDC) | **未対応** | 同上 | https://docs.pimlico.io/infra/paymaster/erc20-paymaster |

### Block time / maxBlockHeight buffer (phase 4b-1)

| chain | block time | OpenPay の `defaultBlockHeightOffset` |
|---|---|---|
| Avalanche C-Chain | ~2s | **600 blocks** = 1200s ≈ 20 min |
| Unichain | ~1s | **1200 blocks** = 1200s ≈ 20 min |
| Avalanche Fuji | ~2s | 600 blocks |
| Unichain Sepolia | ~1s | 1200 blocks |

### CCTP V2 contract addresses

Avalanche / Unichain で **CCTP V2 Fast Transfer 公式 deploy** は確認済 (Circle blog)、
ただし phase 4b-1 では Gateway path のみ使用する想定 (CCTP V2 source として
Avalanche/Unichain を採用する場合は実 contract address を別 commit で追加検証する)。
phase 4b-1 の implementation は Gateway path に限定し、CCTP V2 経路は既存 4 chain
(Base/Arb/OP/Polygon) で完結する設計。

## Phase 4b-3 で追加 (buyer-only、2026-05-25 投入準備完了)

Circle Gateway 公式 12 chain のうち phase 4b-1 までで未対応だった 4 chain を
buyer-only として追加。merchant 受信 chain (USDC_CHAINS) は引き続き 5 のまま、
buyer が「自分の chain の USDC」で支払える source の範囲を広げる目的。

### Sonic (domain 13)

- mainnet USDC: `0x29219dd400f2Bf60E5a23d13be72b486d4038894`
- testnet (Sonic Blaze, chainId 57054) USDC: `0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51`
- Gateway domain: **13**
- chainId: mainnet=146 / testnet (Blaze)=57054
- Pimlico ERC20 Paymaster: **非対応** (merchant 受信 chain には出さない、gasless 不要)

### World Chain (domain 14)

- mainnet USDC: `0x79A02482A880bCe3F13E09da970dC34dB4cD24D1`
- testnet (Sepolia, chainId 4801) USDC: `0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88`
- Gateway domain: **14**
- chainId: mainnet=480 / testnet=4801
- Pimlico ERC20 Paymaster: **非対応**

### Sei (domain 16)

- mainnet USDC: `0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392`
- testnet (chainId 1328) USDC: `0x4fCF1784B31630811181f670Aea7A7bEF803eaED`
- Gateway domain: **16**
- chainId: mainnet=1329 / testnet=1328
- Pimlico ERC20 Paymaster: **非対応**

### HyperEVM (domain 19)

- mainnet USDC: `0xb88339CB7199b77E23DB6E890353E22632Ba630f`
- testnet (chainId 998) USDC: `0x2B3370eE501B4a559b57D449569354196457D8Ab`
- Gateway domain: **19**
- chainId: mainnet=999 / testnet=998
- Pimlico ERC20 Paymaster: **非対応**
- 注: HyperEVM testnet (998) は viem/chains に未収録のため lib/chains.ts で
  defineChain inline 定義 (rpcUrls.default.http=['https://rpc.hyperliquid-testnet.xyz/evm'])

### 出典 (2026-05-25 確認)

- USDC contract addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
- Gateway domain ID 一覧: https://developers.circle.com/stablecoins/gateway-tech-ref
- chainId: viem/chains v2 (worldchain=480/4801, sonic=146/57054, sei=1329/1328, hyperEvm=999)

### TODO (phase 4b-3 follow-up)

- 4 chain 公式 brand SVG logo を public/chains/ に追加
  (現状 chainLogoPathForId は SLUGS_WITH_LOGOS gate で undefined を返し、
  CrossChainSourceChooser は logo 無し = chain 名のみで描画する fallback で動作)

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
