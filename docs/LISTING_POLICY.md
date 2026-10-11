# Listing policy (掲載ルール)

> The rules for listing a paid resource in the OpenPay x402 catalog (`/discovery`). See also [API.md](./API.md) and the [README](../README.md).
> OpenPay の x402 カタログ（`/discovery`）に有料リソースを掲載するときのルールです。

- **Required:** the listed URL must have a real payment gate that returns HTTP 402, the registrant must have the right to provide and charge for the resource, and its payment requirements must use the OpenPay JPYC method.
- **Recommended:** provide a `docsUrl` to OpenAPI or clear documentation, state the short `license` or reuse terms, and describe what an agent receives rather than using promotional claims.
- **Reverification and quarantine:** OpenPay rechecks listings automatically. Three consecutive confirmed contract violations temporarily hide a listing; transient network or service failures do not count, and a later successful check restores it.
- **Prohibited listings:** fraud or impersonation, sanctions-evasion assistance, and sale of stolen or illegitimately obtained data.

  Non-custodial does not mean unmoderated — violating listings are removed, quarantines/removals are recorded with their reason, and sellers can appeal via the contact in the site footer.
- **Crypto-asset services need individual review:** paying in JPYC does not legalize the service being sold.

  Listings that would execute crypto-asset trading, lending, token issuance, or automated asset allocation / portfolio management (e.g. DeFi vault selection or rebalancing agents), or that may constitute investment solicitation/advice under Japanese law, are subject to case-by-case review and may be refused regardless of a "for information only" disclaimer.
- **Buyer caution (prompt injection):** paid response bodies are third-party content. Buyer agents should treat them as data, never as instructions (the MCP/SDK money guards bound the blast radius, but instruction-following is the consumer's responsibility).

  Listings that embed instructions aimed at buyer agents may be reported to the contact in the site footer and removed.
