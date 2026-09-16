import { afterEach, describe, expect, it, vi } from 'vitest';

const to = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function load(network: 'mainnet' | 'testnet', enabled: boolean) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', network);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USDC_ARC', enabled ? '1' : '0');
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_API_KEY', 'test');
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID', 'test');
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', to);
  return {
    chains: await import('@/lib/chains'),
    tokens: await import('@/lib/tokens'),
    url: await import('@/lib/url'),
    pimlico: await import('@/lib/pimlico'),
  };
}

describe.each(['mainnet', 'testnet'] as const)('Arc USDC %s', (network) => {
  it('flag OFF keeps six merchant chains and rejects all Arc URL entry points', async () => {
    const { chains, url } = await load(network, false);
    expect(chains.USDC_CHAINS).toEqual(['base', 'arbitrum', 'optimism', 'polygon', 'ethereum', 'avalanche']);
    expect(chains.isValidChainSlug('arc')).toBe(false);
    const sp = new URLSearchParams({ to, token: 'usdc', chain: 'arc', mode: 'standard', amount: '1', items: 'A:1:1' });
    expect(url.parsePayParams(sp).ok).toBe(false);
    expect(url.parseCheckoutParams(sp).ok).toBe(false);
    expect(url.parseTipParams(to, sp).ok).toBe(false);
  });

  it('flag ON lists Arc with six-decimal ERC-20, RPC, explorer and no paymaster relaxation', async () => {
    const { chains, tokens, pimlico } = await load(network, true);
    const id = network === 'mainnet' ? 5042 : 5042002;
    const explorer = network === 'mainnet' ? 'https://explorer.arc.io' : 'https://explorer.testnet.arc.io';
    expect(chains.USDC_CHAINS).toHaveLength(7);
    expect(chains.USDC_CHAINS).toContain('arc');
    expect(chains.supportedChains).toHaveLength(13);
    expect(chains.chainForSlug('arc').id).toBe(id);
    expect(chains.chainForSlug('arc').rpcUrls.default.http).toEqual([network === 'mainnet' ? 'https://rpc.mainnet.arc.io' : 'https://rpc.testnet.arc.io']);
    expect(chains.chainForSlug('arc').nativeCurrency.decimals).toBe(18);
    expect(chains.txExplorerUrl(id, '0xabc')).toBe(`${explorer}/tx/0xabc`);
    expect(chains.chainLogoPathForId(id)).toBe('/chains/arc.svg');
    expect(chains.chainSupportsCanonical7702(id)).toBe(true);
    expect(chains.buyerUsdcChainNames()).toHaveLength(11);
    expect(chains.buyerUsdcChainNames().some((name) => name.includes('Arc'))).toBe(false);
    const dep = tokens.deploymentForSlug('usdc', 'arc');
    expect(dep.address).toBe('0x3600000000000000000000000000000000000000');
    expect(dep.decimals).toBe(6);
    expect(dep.paymasterMode).toBe('unavailable');
    expect(tokens.isGaslessSupported(dep)).toBe(false);
    expect(tokens.deploymentsForSymbol('usdc')).toHaveLength(12);
    expect(pimlico.resolvePaymasterMode(dep)).toBe('unavailable');
    expect(() => pimlico.assertGaslessSupported(dep, id, 'test')).toThrow();
    expect(() => pimlico.pimlicoPaymasterContext(dep)).toThrow();
  });

  it.each([undefined, 'true', 'false'])('standard URLs force crossChain=false (input %s); gasless and tip reject', async (crossChain) => {
    const { url } = await load(network, true);
    const sp = new URLSearchParams({ to, token: 'usdc', chain: 'arc', mode: 'standard', amount: '1.000001', items: 'A:1:1.000001' });
    if (crossChain !== undefined) sp.set('crossChain', crossChain);
    const pay = url.parsePayParams(sp);
    expect(pay.ok).toBe(true);
    if (pay.ok) expect(pay.params.crossChain).toBe(false);
    // checkout には cross-chain 機能が無い (CheckoutForm は crossChain を読まない)。standard は受理のみ確認。
    expect(url.parseCheckoutParams(sp).ok).toBe(true);
    // Tip is gasless-only: Arc cannot produce any cross-chain tip params.
    expect(url.parseTipParams(to, sp).ok).toBe(false);
    sp.set('mode', 'gasless');
    expect(url.parsePayParams(sp).ok).toBe(false);
    expect(url.parseCheckoutParams(sp).ok).toBe(false);
    const common = { to, token: 'usdc' as const, chain: 'arc' as const, mode: 'standard' as const, gas: 'customer' as const, crossChain: true } as const;
    expect(url.buildPayPath(common)).toContain('crossChain=false');
    expect(url.buildCheckoutPath({ ...common, items: [{ name: 'A', qty: 1, price: '1' }] })).not.toContain('crossChain');
    expect(url.buildTipPath(common)).toContain('crossChain=false');
  });
});
