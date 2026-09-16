import { describe, expect, it } from 'vitest';
import { enumeratePathOptions } from '@/lib/crossChain/pathEnumerator';
import { CROSS_CHAIN_TARGETS } from '@/lib/crossChain/config';
import type { MultiChainBalances } from '@/lib/crossChain/balance';

const address = '0x3600000000000000000000000000000000000000';
const source = CROSS_CHAIN_TARGETS[0];
function balances(walletOk: boolean): MultiChainBalances {
  return {
    wallet: [walletOk
      ? { status: 'ok', target: source, tokenAddress: address, balance: 10000000n }
      : { status: 'error', target: source, tokenAddress: address, error: 'offline' }],
    gateway: { status: 'ok', depositor: address, perDomain: new Map([[source.domain, 10000000n]]), total: 10000000n },
  };
}

describe('destination Circle domain guard', () => {
  it.each([5042, 5042002, 999999])('target %s emits neither cctp nor gateway, including gateway-only balances', (targetChainId) => {
    for (const walletOk of [true, false]) {
      expect(enumeratePathOptions({ targetChainId, requiredAtomic: 1000000n, balances: balances(walletOk) })).toEqual([]);
    }
  });
  it('registered targets retain cctp/gateway paths and same-chain direct', () => {
    const options = enumeratePathOptions({ targetChainId: CROSS_CHAIN_TARGETS[1].chainId, requiredAtomic: 1000000n, balances: balances(true) });
    expect(options.map((o) => o.kind)).toEqual(['gateway', 'cctp-v2']);
    expect(enumeratePathOptions({ targetChainId: source.chainId, requiredAtomic: 1000000n, balances: balances(true) }).map((o) => o.kind)).toEqual(['direct']);
  });
});
