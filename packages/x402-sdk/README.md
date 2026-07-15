# openpay-x402-sdk

Node.js 20+ SDK for discovering, quoting, and buying OpenPay x402 resources priced
in JPYC. It ships as plain ESM and has no build step.

## Quick start

```bash
npm install openpay-x402-sdk
```

```js
import { createOpenPayClient } from 'openpay-x402-sdk';

const client = createOpenPayClient({
  privateKey: process.env.BUYER_PRIVATE_KEY,
  maxPerCallJpyc: '10',
  maxSessionJpyc: '100',
  allowedHosts: 'open-pay.jp',
});

const catalog = await client.discover({ query: 'demo' });
const quote = await client.quote('https://open-pay.jp/api/paid/demo');
if (quote.ok) {
  const result = await client.pay(quote.url, { maxTotalJpyc: '2' });
  console.log(result.body, client.session);
}
```

`discover()` and `findShops({ q?, limit? })` return the server response unchanged
inside `{ ok, status, body }`. `quote()` fetches and validates a 402 challenge but
does not need a signer and never pays. `pay()` requires a signer and serializes
concurrent calls so every call sees the latest session total.

## Money guards

| Option | Default | Guard |
|---|---:|---|
| `maxPerCallJpyc` | `10` | Upper bound for the caller-provided `maxTotalJpyc`. |
| `maxSessionJpyc` | `100` | Cumulative cap for successful payments made by this client instance. |
| `allowedHosts` | `open-pay.jp` | Comma-separated bare host allowlist. |
| `catalogTrust` | `true` | Also allows catalog URLs after the live challenge matches the catalog challenge. |
| `discoveryUrl` | `https://open-pay.jp/api/discovery` | Catalog and OpenPay origin used by the client. |

Query string variants of a query-free listed URL are trusted after the same
money-field verification. Exact query-bearing catalog entries remain exact-only.

`pay(url, { maxTotalJpyc })` always requires `maxTotalJpyc`. It is the maximum
total—including the resource price and x402 fee—that this individual call is
authorized to pay. It does not disable or raise `maxPerCallJpyc` or
`maxSessionJpyc`; all three limits must allow the payment.

The client also rejects non-JPYC metadata, unsupported networks or schemes,
non-OpenPay forwarder splits, amount inconsistencies, resource URL mismatches,
and catalog bait-and-switches before requesting a signature.

## Signers

Choose exactly one of `privateKey`, `steward`, or `signer`. Supplying more than
one is a startup error. A custom signer has an EVM `address` and an async
`signTypedData(typedData)` method.

Steward keeps signing outside the SDK process:

```js
const client = createOpenPayClient({
  steward: {
    url: process.env.STEWARD_URL,
    tenant: process.env.STEWARD_TENANT,
    apiKey: process.env.STEWARD_API_KEY,
    agentId: process.env.STEWARD_AGENT_ID,
    agentAddress: process.env.STEWARD_AGENT_ADDRESS,
    signerId: process.env.STEWARD_SIGNER_ID,
    signerSecret: process.env.STEWARD_SIGNER_SECRET,
  },
});
```

The first Steward signature is verified locally against `agentAddress`. Steward
API keys, signer secrets, and local private keys are redacted from SDK-generated
errors and are not exposed as client properties.

## Security

Payments can be irreversible. Use a dedicated low-balance wallet, keep private
keys and Steward credentials in a secret manager, and never put them in source
code or logs. Set `maxTotalJpyc` from the amount authorized for the current
operation, not from the wallet balance. Keep conservative per-call and session
limits even when Steward applies an additional signing policy.

`client.session` returns a new frozen snapshot on every read:

```js
// { spentAtomic: 2000000000000000000n, spentJpyc: '2' }
console.log(client.session);
```

Advanced consumers may import the named payment, guard, signer, catalog, and
executor helpers from the package root.
