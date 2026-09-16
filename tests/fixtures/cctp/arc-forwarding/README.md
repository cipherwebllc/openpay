# Captured Arc fixtures

Captured by the supervisor with live access on 2026-09-17 JST (JSON timestamps
are 2026-09-16 UTC). No capture or funded transaction was performed by this
implementation session. Raw JSON files are preserved unchanged.

- `fees-6-to-26-mainnet.json`: GET
  `https://iris-api.circle.com/v2/burn/USDC/fees/6/26?forward=true`.
- `fees-6-to-26-sandbox.json`: same path at `https://iris-api-sandbox.circle.com`.
  Fast-transfer expected maxFee for 1,000,000 atomic: **98,272 / 20,632**.
  Formula: high + ceil(amount × round(minimumFee × 1000) / 10,000,000).
- Arc testnet RPC: `https://rpc.testnet.arc.io`, chain 5042002.
  Forwarding receipts:

| Block | Transaction |
|---|---|
| 62433535 | `0xd81354981ec4189ca5febcc9107fbbcfee9607d30ec0649497c9e675976c69e5` |
| 62430668 | `0x18fb01e1b7bc3c4a769c174c7b16f0f4b24aab679f35f90b7768ae3d361e3cef` |
| 62427408 | `0x49f73657c5736d46e6378fe20a8d1fb9484abf87492a1a482dfb139032f60b41` |

These forwarding receipts use an **extended hook** (544 bytes beginning
`cctp-forward`), not the fixed 32-byte hook emitted by OpenPay. Tests decode the
unmodified receipts to pin ABI/indexing/body offsets; explicit synthetic fixed-hook
receipts exercise OpenPay verification and multi-message rejection. Do not label
those synthetic cases as captures or treat these receipts as OpenPay E2E evidence.

`iris-messages-forwarding-domain0.json` corresponds to block 62433535. Its
`forwardTxHash` and `destinationMintTxHash` agree, but tests treat them as candidates.
`arc-testnet-destination-receipts.json` and `iris-messages-domain0-nonce.json`
provide self-mint contrast, including block 62440418 / transaction
`0xd05d294566efc678a01abd9235b410d74794b95b5823cfc7816b58b44871ca89`.
The supervisor's capture head for the contrast scan was 62440619.
