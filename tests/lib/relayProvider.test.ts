import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Eip3009Authorization } from '@/lib/jpycEip3009';

// relayJpycAuthorization を spy に差し替え、relayFreeAuthorization が両 provider 経路
// (self-host / gelato・null) で組み立てる deps を捕捉する。guard の「既使用 → submit せず
// pending」挙動そのものは jpycRelay.test.ts (checkAuthorizationUsed → true) が担保しており、
// ここでは P1-H の配線 (deps.checkAuthorizationUsed が両経路に存在すること) を検証する。
const { relaySpy } = vi.hoisted(() => ({
  relaySpy: vi.fn((_input: unknown, _deps: unknown) =>
    Promise.resolve({ kind: 'pending' as const }),
  ),
}));

vi.mock('@/lib/relay/jpycRelay', () => ({
  relayJpycAuthorization: relaySpy,
}));

const AUTH: Eip3009Authorization = {
  from: '0x0000000000000000000000000000000000000abc' as Address,
  to: '0x0000000000000000000000000000000000000def' as Address,
  value: 1_000n,
  validAfter: 0n,
  validBefore: 9_999_999_999n,
  nonce: `0x${'00'.repeat(32)}` as Hex,
};
const SIG = `0x${'11'.repeat(65)}` as Hex;
const POLYGON = 137;

function capturedDeps(): { checkAuthorizationUsed?: unknown } {
  expect(relaySpy).toHaveBeenCalledOnce();
  return relaySpy.mock.calls[0][1] as { checkAuthorizationUsed?: unknown };
}

describe('relayFreeAuthorization: checkAuthorizationUsed の provider 配線 (P1-H)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    relaySpy.mockClear();
  });

  it('gelato/null 経路 (RELAYER_PRIVATE_KEY 無し = else 分岐) でも deps.checkAuthorizationUsed が配線される', async () => {
    vi.resetModules();
    vi.stubEnv('RELAYER_PRIVATE_KEY', ''); // falsy → PROVIDER は self-host 以外 (else 分岐)
    const mod = await import('@/lib/relay/relayProvider');
    await mod.relayFreeAuthorization(POLYGON, AUTH, SIG, [], { idemPrefix: 't:' });
    // P1-H 以前はこの経路に checkAuthorizationUsed が無く、既使用 authorization の guard が抜けて
    // revert 確実な tx にスポンサー予算を浪費し "reverted" 誤表示になっていた。
    expect(typeof capturedDeps().checkAuthorizationUsed).toBe('function');
  });

  it('self-host 経路 (RELAYER_PRIVATE_KEY あり) でも deps.checkAuthorizationUsed が配線される (回帰ガード)', async () => {
    vi.resetModules();
    vi.stubEnv('RELAYER_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
    const mod = await import('@/lib/relay/relayProvider');
    await mod.relayFreeAuthorization(POLYGON, AUTH, SIG, [], { idemPrefix: 't:' });
    expect(typeof capturedDeps().checkAuthorizationUsed).toBe('function');
  });
});
