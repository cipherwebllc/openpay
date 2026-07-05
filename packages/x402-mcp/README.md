# openpay-x402-mcp

Local MCP buyer for OpenPay x402 JPYC resources. It runs on your machine, signs with either a local buyer key or a remote Steward signer, and applies local spend guards before any payment is sent.

## Install

```bash
npx openpay-x402-mcp
```

During local development from this repository:

```bash
cd packages/x402-mcp
npm i
node src/index.mjs
```

## Claude Desktop

```json
{
  "mcpServers": {
    "openpay-x402": {
      "command": "npx",
      "args": ["openpay-x402-mcp"],
      "env": {
        "SIGNER_MODE": "env-key",
        "BUYER_PRIVATE_KEY": "0x...",
        "MAX_PER_CALL_JPYC": "10",
        "MAX_SESSION_JPYC": "100",
        "ALLOWED_HOSTS": "open-pay.jp"
      }
    }
  }
}
```

## Claude Code

```json
{
  "mcpServers": {
    "openpay-x402": {
      "command": "npx",
      "args": ["openpay-x402-mcp"],
      "env": {
        "SIGNER_MODE": "env-key",
        "BUYER_PRIVATE_KEY": "0x...",
        "MAX_PER_CALL_JPYC": "10",
        "MAX_SESSION_JPYC": "100",
        "ALLOWED_HOSTS": "open-pay.jp"
      }
    }
  }
}
```

## Tools

| Tool | Pays? | Purpose |
|---|---:|---|
| `discovery_search` | No | Search `DISCOVERY_URL` and show resource, category, price, fee, and total. |
| `x402_quote` | No | Fetch a 402 challenge and report whether local guards would allow payment. |
| `x402_pay` | Yes | Sign and retry with `X-PAYMENT` only after all guards pass. Requires `maxTotalJpyc`. |

## Environment

| Variable | Default | Notes |
|---|---|---|
| `SIGNER_MODE` | `env-key` | `env-key` signs in-process with `BUYER_PRIVATE_KEY`. `steward` delegates typed-data signing to Steward. |
| `BUYER_PRIVATE_KEY` | unset | Required only for `x402_pay` when `SIGNER_MODE=env-key`. Use a dedicated low-balance wallet, never a primary wallet. |
| `STEWARD_URL` | unset | Required when `SIGNER_MODE=steward`, for example `http://localhost:3900`. |
| `STEWARD_TENANT` | unset | Required when `SIGNER_MODE=steward`; tenant context sent as `X-Steward-Tenant`. |
| `STEWARD_API_KEY` | unset | Required when `SIGNER_MODE=steward`; tenant API key sent as `X-Steward-Key`. Treated as a secret. |
| `STEWARD_AGENT_ID` | unset | Required when `SIGNER_MODE=steward`; used in `/vault/{STEWARD_AGENT_ID}/sign-typed-data`. |
| `STEWARD_AGENT_ADDRESS` | unset | Required when `SIGNER_MODE=steward`; expected EVM signer address used for local first-signature verification. |
| `STEWARD_SIGNER_ID` | unset | Required when `SIGNER_MODE=steward`; scoped signer id with typed-data signing permission. |
| `STEWARD_SIGNER_SECRET` | unset | Required when `SIGNER_MODE=steward`; scoped signer secret. Treated as a secret. |
| `MAX_PER_CALL_JPYC` | `10` | Upper bound for the tool call's required `maxTotalJpyc`. |
| `MAX_SESSION_JPYC` | `100` | Process-lifetime cumulative cap for successful `x402_pay` calls. Restarting the process resets it. |
| `ALLOWED_HOSTS` | `open-pay.jp` | Comma-separated bare host allowlist. `x402_quote` still works outside the list but returns `host_not_allowed`. |
| `DISCOVERY_URL` | `https://open-pay.jp/api/discovery` | Catalog used by `discovery_search`. |

## Signer Modes

`env-key` is the default zero-config mode. It is convenient for local testing and should use a dedicated low-balance wallet.

`steward` is recommended for production-like agent use because the buyer key stays outside the MCP process. In this mode `x402_pay` sends typed data to:

```text
POST {STEWARD_URL}/vault/{STEWARD_AGENT_ID}/sign-typed-data
```

with `X-Steward-Key`, `X-Steward-Tenant`, `x-steward-signer-id`, and `x-steward-signer-secret` headers. The request body is `{ domain, types, primaryType, value }`, where `value` is the EIP-712 message.

After the first Steward signature in a process session, the MCP verifies it locally against `STEWARD_AGENT_ADDRESS`. A mismatch fails closed before any paid resource retry is sent.

## Steward Setup

### One-command bootstrap (recommended)

`scripts/steward-bootstrap.mjs` provisions the entire steward backend in one command:
it creates the tenant, opens self-join, logs the owner in via SIWE, promotes them to
owner, creates the buyer agent, applies the JPYC typed-data policy, enrolls the
owner's TOTP (MFA), establishes an MFA session, issues the signer credential, and
prints the completed MCP env block. Takes about a minute (it must wait out Steward's
session-revocation boundaries and one TOTP window).

```bash
OWNER_PRIVATE_KEY=0x... \
STEWARD_PLATFORM_KEY=<one of the server STEWARD_PLATFORM_KEYS> \
node scripts/steward-bootstrap.mjs
```

The owner key is used only to sign the SIWE login in-process — it is never sent or
stored. Start Steward with `SIWE_ALLOWED_DOMAINS` including your `STEWARD_URL` host so
the SIWE nonce is accepted.

Steward gates signer issuance behind an MFA-verified session. The script does not
bypass this: it enrolls a TOTP factor on the owner's behalf and **hands the TOTP
secret to you** at the end — add it to your authenticator app and keep it with the
other secrets; you will need it for any future admin operation. The signer secret and
tenant API key are printed exactly once.

### Manual setup



Run Steward yourself and provide its normal local startup secrets, including `STEWARD_MASTER_PASSWORD`, `STEWARD_AUDIT_HMAC_KEY`, `STEWARD_PLATFORM_KEYS`, and `STEWARD_PLATFORM_KEY_SCOPES`. Then create a tenant, create an agent vault, and issue the scoped signer from the Steward dashboard; signer issuance requires an administrator session.

Recommended typed-data policy shape for this MCP:

- `verifyingContractAllowlist`: JPYC token contracts you allow.
- `to address_in`: OpenPay forwarder addresses you allow.
- `value uint_max`: the largest per-signature amount you allow Steward to sign.

Known upstream constraint: current Steward `develop` may reject typed-data policy registration through the API because of a validation bug. Until the upstream fix is available, local Steward deployments may need `STEWARD_ALLOW_UNSAFE_TYPED_DATA_SIGNING=true` and `STEWARD_ALLOW_VAULT_UNSAFE_TYPED_DATA_SIGNING=true`. Even then, this MCP still applies per-call, per-session, host allowlist, resource, JPYC, and forwarder-split guards before requesting a signature.

## Money Safety

`x402_pay` refuses to sign unless the endpoint host is allowed, the x402 `accepts[0]` entry is an OpenPay `forwarder-split` JPYC challenge, the resource URL matches the requested URL, the caller's `maxTotalJpyc` is high enough but not above `MAX_PER_CALL_JPYC`, and the process cumulative spend remains within `MAX_SESSION_JPYC`.

The server never logs or returns your private key, Steward API key, or Steward signer secret. It also does not return the payment authorization signature; the signature is only placed in the `X-PAYMENT` header required by the x402 retry.

Payments are blockchain transactions and can be irreversible. Use a dedicated wallet with only the amount you intend to spend.
