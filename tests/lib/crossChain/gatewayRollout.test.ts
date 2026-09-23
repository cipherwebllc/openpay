import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { enumeratePathOptions } from '@/lib/crossChain/pathEnumerator';
import { selectPath } from '@/lib/crossChain/router';
import { executeGatewayTransfer } from '@/lib/crossChain/execute';
import type { MultiChainBalances } from '@/lib/crossChain/balance';

const account = '0x1111111111111111111111111111111111111111' as const;
const target = { chainId: 84532, domain: 6, isTestnet: true, role: 'merchant-and-buyer' } as const;
const balances: MultiChainBalances = {
  wallet: [{ status: 'ok', target, tokenAddress: account, balance: 5_000_000n }],
  gatewayReadyDomains: new Set([6]),
  gateway: { status: 'ok', depositor: account, perDomain: new Map([[6, 5_000_000n]]), total: 5_000_000n },
};
afterEach(() => vi.restoreAllMocks());

describe('Gateway rollout is default OFF', () => {
  it('keeps parsed Gateway funds out of the chooser and auto-router, while retaining wallet routes', () => {
    const args = { balances, targetChainId: 80002, requiredAtomic: 1_000_000n };
    expect(enumeratePathOptions(args).map((o) => o.kind)).toEqual(['cctp-v2']);
    expect(selectPath(args).path).toBe('cctp-v2');
    expect(selectPath({ ...args, targetChainId: target.chainId }).path).toBe('direct');
  });

  it('also gates the Gateway-only fallback when wallet balances are unavailable', () => {
    const args = { targetChainId: 80002, requiredAtomic: 1_000_000n, balances: {
      ...balances, wallet: [{ status: 'error' as const, target, tokenAddress: account, error: 'offline' }],
    } };
    expect(enumeratePathOptions(args)).toEqual([]);
    expect(selectPath(args).path).toBe('onramp');
  });

  it.each([undefined, {}])('rejects fresh execution with resume=%j before any wallet or RPC call', async (resume) => {
    const wallet = { getChainId: vi.fn(), signTypedData: vi.fn(), sendTransaction: vi.fn() };
    const client = { getCode: vi.fn(), getBlockNumber: vi.fn() };
    const switchChainAsync = vi.fn();
    await expect(executeGatewayTransfer({
      walletClient: wallet as never, sourcePublicClient: client as never, destPublicClient: client as never,
      switchChainAsync, account, recipient: account, sourceChainId: 84532, destChainId: 80002,
      sourceDomain: 6, destDomain: 7, sourceToken: account, destToken: account, valueAtomic: 1_000_000n,
      resume,
    })).rejects.toThrow('Gateway cross-chain is disabled');
    expect(switchChainAsync).not.toHaveBeenCalled();
    expect(wallet.getChainId).not.toHaveBeenCalled();
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(client.getCode).not.toHaveBeenCalled();
  });

  it('requires explicit opt-in to offer Gateway paths', () => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(true);
    const args = { balances, targetChainId: 80002, requiredAtomic: 1_000_000n };
    expect(enumeratePathOptions(args).map((o) => o.kind)).toEqual(['gateway', 'cctp-v2']);
    expect(selectPath(args).path).toBe('gateway');
  });

  it.each([
    [false, false, false], [false, true, false], [true, false, false], [true, true, false],
    [false, false, true], [false, true, true], [true, false, true], [true, true, true],
  ])('requires opt-in AND readiness (enabled=%s, ready=%s, wallet unavailable=%s)', (enabled, ready, walletUnavailable) => {
    vi.spyOn(env, 'enableGatewayCrossChain', 'get').mockReturnValue(enabled);
    const args = { targetChainId: 80002, requiredAtomic: 1_000_000n, balances: {
      ...balances,
      gatewayReadyDomains: new Set(ready ? [target.domain] : []),
      wallet: walletUnavailable
        ? [{ status: 'error' as const, target, tokenAddress: account, error: 'offline' }]
        : balances.wallet,
    } };
    expect(enumeratePathOptions(args).some((option) => option.kind === 'gateway')).toBe(enabled && ready);
    expect(selectPath(args).path).toBe(enabled && ready ? 'gateway' : walletUnavailable ? 'onramp' : 'cctp-v2');
  });
});
