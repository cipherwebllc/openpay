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

// 第 8 回レビュー A-01: relay の tx が revert した後の固定読み取りは、店 (受取人) へ払う決済の route が
// recheckRevertedAuthorization: true を渡したときだけ deps に載る。既定 (未指定 = 利用料・CSV パス) は載せない
// = 従来どおり reverted を返す。
describe('relayFreeAuthorization: revert 後の再確認は opt-in (A-01)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    relaySpy.mockClear();
  });

  it.each([
    ['self-host', `0x${'11'.repeat(32)}`],
    ['gelato/null', ''],
  ])('%s: 既定 (idemPrefix だけ) では readAuthorizationUsedAtRevert を渡さない', async (_label, key) => {
    vi.resetModules();
    vi.stubEnv('RELAYER_PRIVATE_KEY', key);
    const mod = await import('@/lib/relay/relayProvider');
    await mod.relayFreeAuthorization(POLYGON, AUTH, SIG, [], { idemPrefix: 't:' });
    const deps = relaySpy.mock.calls[0][1] as { readAuthorizationUsedAtRevert?: unknown };
    expect(relaySpy).toHaveBeenCalledOnce();
    expect(deps.readAuthorizationUsedAtRevert).toBeUndefined();
  });

  it.each([
    ['self-host', `0x${'11'.repeat(32)}`],
    ['gelato/null', ''],
  ])('%s: recheckRevertedAuthorization: true なら固定読み取りを渡す', async (_label, key) => {
    vi.resetModules();
    vi.stubEnv('RELAYER_PRIVATE_KEY', key);
    const mod = await import('@/lib/relay/relayProvider');
    await mod.relayFreeAuthorization(POLYGON, AUTH, SIG, [], {
      idemPrefix: 't:',
      recheckRevertedAuthorization: true,
    });
    const deps = relaySpy.mock.calls[0][1] as { readAuthorizationUsedAtRevert?: unknown };
    expect(relaySpy).toHaveBeenCalledOnce();
    expect(deps.readAuthorizationUsedAtRevert).toBe(mod.readAuthorizationUsedAtRevert);
  });
});

// relayer の低残高の事前警告 (relay.relayer.balance_low) の閾値。旧既定の一律 0.1 native は Polygon の
// forwarder.settle の数回分しかなく、客に degraded (5 native) が見えた後に鳴っていた。
describe('relayLowBalanceAlertWei: chain 別の既定と env の上書き', () => {
  const NATIVE = 10n ** 18n;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(envValue: string) {
    vi.resetModules();
    vi.stubEnv('RELAY_LOW_BALANCE_ALERT_WEI', envValue);
    return (await import('@/lib/relay/relayProvider')).relayLowBalanceAlertWei;
  }

  it('未設定: mainnet は health の degraded フロア (Polygon/Kaia 5・Avalanche 0.1) の 2 倍、testnet は 0.1 native', async () => {
    const alertWei = await load('');
    expect(alertWei(137)).toBe(10n * NATIVE);
    expect(alertWei(8217)).toBe(10n * NATIVE);
    expect(alertWei(43114)).toBe((2n * NATIVE) / 10n);
    expect(alertWei(80002)).toBe(NATIVE / 10n);
    expect(alertWei(1001)).toBe(NATIVE / 10n);
  });

  it('env は全 chain 共通の上書き・0 で無効・不正値は chain 別既定', async () => {
    const override = await load('3000000000000000000');
    expect(override(137)).toBe(3n * NATIVE);
    expect(override(43114)).toBe(3n * NATIVE);
    expect((await load('0'))(137)).toBe(0n);
    expect((await load('1e18'))(137)).toBe(10n * NATIVE);
  });
});
