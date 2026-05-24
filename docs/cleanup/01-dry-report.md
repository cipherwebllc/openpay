# DRY / Duplication Audit (Task 1/8)

## Summary
Audited `lib/`, `hooks/`, `components/`, `app/` for code duplication. Found 4 high-confidence and 2 medium-confidence findings. Most duplication is concentrated in URL parsing (chain slug resolution), paymaster-mode guards across smart account adapters, balance/wrong-chain UI logic across the three "form" components (Payment/Tip/Checkout), and the chain chooser JSX pattern.

## High-confidence findings (safe to implement)

### Finding 1: `chainSlug` resolution from URL param repeated 3x
- Files: `lib/url.ts:311-323`, `lib/url.ts:526-537`, `lib/url.ts:771-782`
- What duplicates: The exact same 12-line block resolving `chainRaw` → `ChainSlug` (default if empty, `isValidChainSlug` check, identical Japanese error message listing all 6 chain slugs) lives in `parsePayParams`, `parseTipParams`, and `parseCheckoutParams`.
- Proposed extraction: Add to `lib/url.ts`:
  `function resolveChainSlugParam(chainRaw: string | null, token: TokenSymbol): { ok: true; slug: ChainSlug } | { ok: false; error: string }`
- Why safe: Pure parsing function, same inputs/outputs, all three callers immediately wrap the error string with the same outer shape — drop-in.

### Finding 2: "paymasterMode === 'unavailable'" fail-loud guard repeated 3x in smart-account adapters
- Files: `lib/smartAccount/simpleAccount.ts:50-55`, `lib/smartAccount/mav2.ts:69-74`, `lib/smartAccount/metamask.ts:76-81`
- What duplicates: Each adapter starts with the identical 6-line `if (rawMode === 'unavailable') throw new Error('<adapter name>: deployment ${symbol} on chain ${chainId} は gasless mode 非対応 (paymasterMode=unavailable)。standard mode 経路を使うこと。')` block.
- Proposed extraction: Add to `lib/pimlico.ts` (next to `resolvePaymasterMode`):
  `function assertGaslessSupported(deployment: TokenDeployment, chainId: number, callerName: string): 'sponsorship' | 'erc20'` — returns narrowed mode or throws.
- Why safe: Behavior preserved, message-format change is acceptable since the callerName is interpolated. Three adapters call it once at the top — mechanical replacement.

### Finding 3: Control-character sanitization regex `[\x00-\x1f\x7f]` repeated 4x
- Files: `lib/url.ts:436` (`sanitizeText`), `lib/url.ts:687` (item-name parse), `lib/url.ts:865` (draft item-name), `hooks/useQrSettings.ts:62` (separate `sanitizeText` impl)
- What duplicates: `value.replace(/[\x00-\x1f\x7f]/g, '').trim()` followed by length cap. `useQrSettings.ts:60-63` even reimplements the same function as `sanitizeText` with slightly different signature (`unknown` input, no `undefined` return).
- Proposed extraction: Single shared `lib/format.ts` (or new `lib/sanitize.ts`):
  `export function sanitizeUserText(value: unknown, max: number, opts?: { emptyToUndefined?: boolean }): string | undefined`
- Why safe: All four sites apply identical char-stripping + trim + length cap. The two existing variants only differ in `unknown`-vs-`string` input and empty-handling — both covered by the options bag.

### Finding 4: `useReadContract(balanceOf) + insufficientBalance + wrongChain + useAutoSwitchChain` block repeated 3x
- Files: `components/PaymentForm.tsx:155-170`, `components/TipForm.tsx:89-104`, `components/CheckoutForm.tsx:93-108`
- What duplicates: The identical 16-line block: `useReadContract({ address: deployment.address, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, chainId: deployment.chainId, query: { enabled: !!address && isConnected }})`, the `insufficientBalance` computation, `wrongChain = isConnected && chainId !== requiredChain.id`, and `useAutoSwitchChain(requiredChain.id, wrongChain)`.
- Proposed extraction: New `hooks/useErc20BalanceAndChain.ts`:
  `function useErc20BalanceAndChain(deployment: TokenDeployment, requiredChain: Chain, totalOutflow: bigint): { balance: bigint | undefined; insufficientBalance: boolean; wrongChain: boolean }`
- Why safe: All three callers use the trio identically — same hook calls, same boolean derivations, same auto-switch side effect. Pure consolidation, no behavior change.

## Medium-confidence findings (need human review)

### Finding 5: Chain-chooser button-grid JSX repeated 3x
- Files: `components/QrGenerator.tsx:386-418`, `components/TipEmbedGenerator.tsx:178-207`, `components/CheckoutLinkGenerator.tsx:197-221`
- What duplicates: A `Field`-wrapped `grid grid-cols-2 ... sm:grid-cols-N` of `<button>` cells, each calling `chainForSlug(slug)` and rendering `c.name` / `c.id` with the same `border-brand bg-brand/5 ...` active-state classnames. The body of the iterator is byte-identical; only the source list differs (USDC_CHAINS / JPYC_CHAINS / a `filter()` of USDC_CHAINS).
- Proposed extraction: `components/ChainChooser.tsx` taking `{ slugs: readonly ChainSlug[]; selected: ChainSlug; onSelect: (s: ChainSlug) => void; columns?: 'auto' | 2 }`.
- Uncertainty: TipEmbedGenerator applies an extra `filter(isGaslessSupported)`; QrGenerator dynamically switches grid columns (`sm:grid-cols-5` vs `grid-cols-2`) based on token. These differences are trivially absorbed by the `slugs` prop + optional `columns` prop, but verify i18n keys (`tokenChainHint` etc.) are not affected — those live outside the loop.

### Finding 6: `DEFAULT_USEROP_GAS_UNITS` constants + `env.gasQuoteOverheadUnits` override repeated
- Files: `hooks/useGasQuoteJpyc.ts:20,78-82`, `hooks/useGasQuoteUsdc.ts:22,61-64`
- What duplicates: Both hooks declare `DEFAULT_USEROP_GAS_UNITS` (different values: 200k vs 500k) and read the same `env.gasQuoteOverheadUnits` override with identical ternary. Only 2 occurrences (below the 3-min threshold for extraction) but the override-read could be a one-liner helper.
- Uncertainty: Borderline — only 2 callers and the constants intentionally differ. Recommend leaving alone unless a third gas-quote variant is added (e.g. a future native-gas quote for Standard mode).

## Rejected candidates (looked similar but should stay separate)

- **Smart-account adapter bodies (`simpleAccount.ts` / `mav2.ts` / `metamask.ts`)**: superficially similar but encapsulate three different SDKs (`permissionless`, `@aa-sdk/core`, `@metamask/delegation-toolkit`) with different account-construction APIs, transport requirements (mav2 needs `split()` transport), and middleware shapes. Only the `unavailable` guard (Finding 2) is mechanically dedupable — the rest is conceptually distinct per task instructions.
- **`CHAIN_BY_ID` map in `lib/crossChain/balance.ts:136-152` vs `supportedChains` in `lib/chains.ts:116`**: looks redundant, but `supportedChains` swaps between mainnet/testnet via `NETWORK_ENV` (8 entries), while `CHAIN_BY_ID` hardcodes all 14 (both nets) because `CROSS_CHAIN_TARGETS` resolution must work for either net at any time. Merging would require restructuring `chains.ts`; not worth it.
- **`fileSafe` regex in `QrGenerator.tsx:79`** (`[-\\/:*?"<>|\s\x00-\x1f\x7f]`) shares the control-char class with Finding 3 but has a different purpose (filename normalization with extra Windows-reserved chars). Different result shape — keep separate.
- **Kaia chain-id guard (`chainId === kaia.id || chainId === kairos.id`)**: only 2 occurrences (`mav2.ts:83`, `metamask.ts:62`) — below threshold.
- **`PaymentForm` / `CheckoutForm` flow-error formatting (`isGasCongestedError(...) ? ... : isIncompatibleSmartAccountError(...) ? ...`)**: only 2 near-identical occurrences (TipForm omits `merchantUnderflow`); the third would-be site (TipForm) has materially different fallback branches. Below threshold + diverging logic.
- **Test-fixture addresses `0x1111…1111` / `0x9999…9999` across 5 test files**: 49 hits but the values are inert sentinels chosen for byte-pattern clarity; centralizing them adds an indirection without solving any actual issue.

## Recommended implementation order

1. **Finding 3 (sanitize-text regex)** — smallest blast radius, all sites trivially convertible, removes a security-sensitive regex from being copy-pasted (control-char stripping must stay consistent).
2. **Finding 1 (chainSlug resolution in url.ts)** — pure refactor inside one file; isolated tests in `tests/lib/url.test.ts` will catch any regression and the i18n-free error string is constant.
3. **Finding 2 (paymaster `unavailable` guard)** — three sites with identical semantics; tightens the security-critical "no silent sponsorship fallback" invariant by funnelling it through one assertion.
4. **Finding 4 (balance+chain hook)** — touches three large components; do after the smaller refactors so review is focused. Verify each form's `chainId`-vs-`deployment.chainId` distinction is preserved (PaymentForm uses `deployment.chainId` in the query but `requiredChain.id` for switch).
5. **Finding 5 (ChainChooser component)** — defer until after #4 since both touch the form components; benefits from a small follow-up rather than mixing concerns.
