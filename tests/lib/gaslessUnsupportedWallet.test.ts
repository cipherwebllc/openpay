// lib/gaslessUnsupportedWallet.ts の実物 (tests/setup.ts の既定のスタブを外して読む)。
// JPYC のガスレス (EIP-3009・ecrecover だけ) で払えない contract の口座だけを true にする。code の無い EOA (未 deploy の
// スマートアカウントを含む) と 7702 で委任した EOA (HashPort の Alchemy MAv2・MetaMask・委任先が未知でも) は false。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { chainForSlug } from '@/lib/chains';
import { logger } from '@/lib/logger';

async function loadActual() {
  return vi.importActual<typeof import('@/lib/gaslessUnsupportedWallet')>('@/lib/gaslessUnsupportedWallet');
}

const WALLET = getAddress('0x8f16000000000000000000000000000000000001');
// ERC-1967 の最小の proxy (61 byte・ERC-4337 のスマートアカウントの形)。マイナウォレットの口座も 61 byte の proxy。
const PROXY_61 =
  '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3' as Hex;
const delegation = (impl: string) => `0xef0100${impl.slice(2).toLowerCase()}` as Hex;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readGaslessUnsupportedWallet (code の表)', () => {
  it('61 byte の proxy は 61 byte', () => {
    expect((PROXY_61.length - 2) / 2).toBe(61);
  });

  it.each<[string, Hex | undefined, boolean]>([
    ['code なし (undefined・pristine な EOA / 未 deploy のスマートアカウント)', undefined, false],
    ["code なし ('0x')", '0x', false],
    ['7702 で Alchemy MAv2 に委任 (HashPort)', delegation('0x69007702764179f14F51cdce752f4f775d74E139'), false],
    ['7702 で MetaMask の DeleGator に委任', delegation('0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'), false],
    ['7702 で未知の先に委任', delegation('0x1234567890123456789012345678901234567890'), false],
    ['7702 の委任 (大文字の hex)', `0xEF0100${'AB'.repeat(20)}` as Hex, false],
    ['61 byte の proxy (ERC-4337 のスマートアカウント・マイナウォレット)', PROXY_61, true],
    ['7702 の形に 1 byte 足りない code', `0xef0100${'ab'.repeat(19)}` as Hex, true],
  ])('%s → %s', async (_, code, expected) => {
    const { readGaslessUnsupportedWallet } = await loadActual();
    const reader = vi.fn(async () => code);
    await expect(readGaslessUnsupportedWallet(137, WALLET, 'pay', reader)).resolves.toBe(expected);
    expect(reader).toHaveBeenCalledWith(137, WALLET);
  });

  it('読めなければ reject する (fail-open は hook の側)', async () => {
    const { readGaslessUnsupportedWallet } = await loadActual();
    const reader = vi.fn(async (): Promise<Hex | undefined> => {
      throw new Error('rpc down');
    });
    await expect(readGaslessUnsupportedWallet(137, WALLET, 'pay', reader)).rejects.toThrow('rpc down');
  });
});

describe('readGaslessUnsupportedWallet (開発時の確認用の log・本番の既定の level では出ない)', () => {
  it('見分けたときだけ logger.info に経路とチェーンを出す (アドレスは出さない)', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const { readGaslessUnsupportedWallet } = await loadActual();
    await readGaslessUnsupportedWallet(137, WALLET, 'store-device', async () => PROXY_61);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('payment.gasless_unsupported_wallet', { path: 'store-device', chainId: 137 });
    expect(JSON.stringify(info.mock.calls)).not.toContain(WALLET.slice(2).toLowerCase());
    expect(JSON.stringify(info.mock.calls)).not.toContain(WALLET.slice(2));

    info.mockClear();
    await readGaslessUnsupportedWallet(137, WALLET, 'pay', async () => '0x');
    await readGaslessUnsupportedWallet(137, WALLET, 'pay', async () => delegation('0x69007702764179f14F51cdce752f4f775d74E139'));
    expect(info).not.toHaveBeenCalled();
  });
});

describe('readGaslessUnsupportedWallet (既定の reader)', () => {
  it('支払うチェーンの RPC に、そのアドレスの eth_getCode を 1 回送る', async () => {
    const bodies: { method: string; params: unknown[] }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
        bodies.push(body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: PROXY_61 }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { readGaslessUnsupportedWallet } = await loadActual();
    await expect(readGaslessUnsupportedWallet(chainForSlug('polygon').id, WALLET, 'checkout')).resolves.toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].method).toBe('eth_getCode');
    expect((bodies[0].params[0] as Address).toLowerCase()).toBe(WALLET.toLowerCase());
  });

  it('対応していないチェーンは reject する (読まない)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { readGaslessUnsupportedWallet } = await loadActual();
    await expect(readGaslessUnsupportedWallet(999_999, WALLET, 'pay')).rejects.toThrow(/no chain object/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
