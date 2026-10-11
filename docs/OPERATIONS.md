# Operations notes

> Operator-side notes that used to live in the README. The full runbook is [DEPLOY_CHECKLIST.md](./DEPLOY_CHECKLIST.md). Back to the [README](../README.md).
> 運営向けのメモです。詳しい手順は [DEPLOY_CHECKLIST.md](./DEPLOY_CHECKLIST.md) にあります。

## Pimlico balance alerts

A GitHub Actions cron (`scripts/check-pimlico-balance.mjs`, every 6h) reads `balanceOf(paymaster)` on EntryPoint 0.7 and 0.8 for the configured Polygon, Base, and optional Kaia addresses. Existing 0.7 thresholds remain unchanged (defaults: 5 POL, 0.01 ETH, 5 KAIA).

The additional 0.8 reads are informational unless `ALERT_THRESHOLD_POL_V08`, `ALERT_THRESHOLD_ETH_V08`, or `ALERT_THRESHOLD_KAIA_V08` is set for that chain. Missing 0.8 thresholds and informational read failures produce warnings without sending alerts or failing the cron.

Optional `PIMLICO_PAYMASTER_*_V08` secrets override the 0.8 address; otherwise the existing address is read. See [DEPLOY_CHECKLIST §11.2](./DEPLOY_CHECKLIST.md) for setup.

## Useful scripts

```bash
npm run typecheck
npm run lint
npm run test:run
npm run build
npm run e2e:local                      # Playwright with stub env
npm run load-test -- --url <base-url>  # zero-dep load test (p50/p90/p99, RPS, error rate)
```
