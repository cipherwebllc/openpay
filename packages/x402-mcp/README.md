# openpay-x402-mcp

Local MCP buyer for OpenPay x402 JPYC resources. It runs on your machine, signs with your local buyer key, and applies local spend guards before any payment is sent.

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
| `BUYER_PRIVATE_KEY` | unset | Required only for `x402_pay`. Use a dedicated low-balance wallet, never a primary wallet. |
| `MAX_PER_CALL_JPYC` | `10` | Upper bound for the tool call's required `maxTotalJpyc`. |
| `MAX_SESSION_JPYC` | `100` | Process-lifetime cumulative cap for successful `x402_pay` calls. Restarting the process resets it. |
| `ALLOWED_HOSTS` | `open-pay.jp` | Comma-separated bare host allowlist. `x402_quote` still works outside the list but returns `host_not_allowed`. |
| `DISCOVERY_URL` | `https://open-pay.jp/api/discovery` | Catalog used by `discovery_search`. |

## Money Safety

`x402_pay` refuses to sign unless the endpoint host is allowed, the x402 `accepts[0]` entry is an OpenPay `forwarder-split` JPYC challenge, the resource URL matches the requested URL, the caller's `maxTotalJpyc` is high enough but not above `MAX_PER_CALL_JPYC`, and the process cumulative spend remains within `MAX_SESSION_JPYC`.

The server never logs or returns your private key. It also does not return the payment authorization signature; the signature is only placed in the `X-PAYMENT` header required by the x402 retry.

Payments are blockchain transactions and can be irreversible. Use a dedicated wallet with only the amount you intend to spend.
