import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import {
  assertContractDeployed,
  __resetContractDeployedCacheForTest,
} from '@/lib/crossChain/deploycheck';

const ADDR = getAddress('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
const CHAIN_ID = 137;

// getCode を任意に差し替えられる最小 PublicClient mock。
function makeClient(getCode: () => Promise<Hex | undefined>) {
  return { getCode: vi.fn(getCode) } as unknown as Parameters<
    typeof assertContractDeployed
  >[0];
}

beforeEach(() => {
  __resetContractDeployedCacheForTest();
});

describe('assertContractDeployed', () => {
  it('deploy 済 (code 非空) → 解決し、成功結果を cache する (2回目は getCode を呼ばない)', async () => {
    const getCode = vi.fn(async () => '0x60016000' as Hex);
    const client = { getCode } as unknown as Parameters<
      typeof assertContractDeployed
    >[0];

    await expect(
      assertContractDeployed(client, ADDR, CHAIN_ID),
    ).resolves.toBeUndefined();
    expect(getCode).toHaveBeenCalledTimes(1);

    // cache hit: getCode は再度呼ばれない。
    await assertContractDeployed(client, ADDR, CHAIN_ID);
    expect(getCode).toHaveBeenCalledTimes(1);
  });

  it("code が空 ('0x') → throw する", async () => {
    const client = makeClient(async () => '0x' as Hex);
    await expect(
      assertContractDeployed(client, ADDR, CHAIN_ID),
    ).rejects.toThrow(/code が無い/);
  });

  it('code が undefined → throw する', async () => {
    const client = makeClient(async () => undefined);
    await expect(
      assertContractDeployed(client, ADDR, CHAIN_ID),
    ).rejects.toThrow(/code が無い/);
  });

  it('getCode 失敗 → cache せず、次回呼び出しで retry する (成功に至れる)', async () => {
    const getCode = vi
      .fn(async (): Promise<Hex> => '0x60016000' as Hex)
      .mockRejectedValueOnce(new Error('RPC down'))
      .mockResolvedValueOnce('0x60016000' as Hex);
    const client = { getCode } as unknown as Parameters<
      typeof assertContractDeployed
    >[0];

    // 1回目: transient RPC error で throw。
    await expect(
      assertContractDeployed(client, ADDR, CHAIN_ID),
    ).rejects.toThrow('RPC down');

    // 失敗は cache されないので retry でき、今度は成功する。
    await expect(
      assertContractDeployed(client, ADDR, CHAIN_ID),
    ).resolves.toBeUndefined();
    expect(getCode).toHaveBeenCalledTimes(2);
  });

  it('同一 key の並行呼び出しは 1 本の getCode に dedupe する', async () => {
    const getCode = vi.fn(async () => '0x60016000' as Hex);
    const client = { getCode } as unknown as Parameters<
      typeof assertContractDeployed
    >[0];

    await Promise.all([
      assertContractDeployed(client, ADDR, CHAIN_ID),
      assertContractDeployed(client, ADDR, CHAIN_ID),
      assertContractDeployed(client, ADDR, CHAIN_ID),
    ]);
    expect(getCode).toHaveBeenCalledTimes(1);
  });

  it('別 chain / 別 address は独立に検証する', async () => {
    const getCode = vi.fn(async () => '0x60016000' as Hex);
    const client = { getCode } as unknown as Parameters<
      typeof assertContractDeployed
    >[0];
    const other: Address = getAddress(
      '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    );

    await assertContractDeployed(client, ADDR, CHAIN_ID);
    await assertContractDeployed(client, ADDR, 8453); // 別 chain
    await assertContractDeployed(client, other, CHAIN_ID); // 別 address
    expect(getCode).toHaveBeenCalledTimes(3);
  });
});
