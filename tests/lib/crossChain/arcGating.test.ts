import { afterEach, expect, it, vi } from 'vitest';
import type { MultiChainBalances } from '@/lib/crossChain/balance';
import type { Address } from 'viem';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
for (const network of ['testnet', 'mainnet']) {
  for (const receive of [false, true]) for (const forward of [false, true]) {
    it(`${network}: receive=${receive}, forwarding=${forward}: lookup/policy/auth separated`, async () => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', network);
      vi.stubEnv('NEXT_PUBLIC_ENABLE_USDC_ARC', String(receive));
      vi.stubEnv('NEXT_PUBLIC_ENABLE_USDC_ARC_CROSSCHAIN', String(forward));
      const config = await import('@/lib/crossChain/config');
      const { isArcCrossChainEnabled } = await import('@/lib/env');
      const { enumeratePathOptions } = await import('@/lib/crossChain/pathEnumerator');
      const { selectPath } = await import('@/lib/crossChain/router');
      const { crossChainAllowed } = await import('@/lib/url/shared');
      const { buildPayPath } = await import('@/lib/url/pay');
      const { buildTipPath } = await import('@/lib/url/tip');
      const on = receive && forward;
      expect(isArcCrossChainEnabled()).toBe(on);
      expect(config.CROSS_CHAIN_TARGETS).toHaveLength(on ? 12 : 11);
      expect(config.CROSS_CHAIN_TARGETS.filter((t) => t.role === 'merchant-only')).toHaveLength(on ? 1 : 0);
      expect(config.BUYER_SOURCE_TARGETS).toHaveLength(11);
      expect(config.MERCHANT_RECEIVE_TARGETS).toHaveLength(on ? 7 : 6);
      for (const id of [5042, 5042002]) { expect(config.domainForChainId(id)).toBe(26); expect(config.isForwardOnlyDestination(id)).toBe(true); }
      const base = config.BUYER_SOURCE_TARGETS.find((t) => t.domain === 6)!;
      const balances = { wallet: [{ target: base, status: 'ok', balance: 10000000n }], gateway: { status: 'ok', total: 10000000n, perDomain: new Map([[6, 10000000n]]) } } as MultiChainBalances;
      const args = { targetChainId: network === 'mainnet' ? 5042 : 5042002, requiredAtomic: 1000000n, balances };
      const options = enumeratePathOptions(args);
      expect(options.map((o) => o.kind)).toEqual(on ? ['cctp-v2'] : []);
      if (on) expect(options[0].disabledReason).toBe('quote-unavailable');
      expect(selectPath(args).path).toBe('onramp');
      expect(crossChainAllowed('arc')).toBe(on);
      expect(crossChainAllowed('arc', false)).toBe(false);
      const params = { chain: 'arc' as const, token: 'usdc' as const, to: '0x1111111111111111111111111111111111111111' as Address, mode: 'standard' as const, gas: 'customer' as const, crossChain: true };
      expect(buildPayPath(params).includes('crossChain=false')).toBe(!on);
      expect(buildTipPath(params).includes('crossChain=false')).toBe(true);
    });
  }
}
