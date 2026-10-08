// 「お店の端末で送る」の対象チェーン (lib/storeDevicePayment.ts・plans/store-gas-wallet.md §20)。
// mainnet = 開示したチェーン (DISCLOSED_STORE_GAS_WALLET.chainIds) ∩ 設定済み・testnet = 対応 testnet ∩ 設定済み。
// 設定 = JPYC のチェーン (Avalanche は flag)・forwarder (a1 ON なら無効)・手数料受取口がそろうこと。
import { afterEach, describe, expect, it, vi } from 'vitest';

const hold = vi.hoisted(() => ({
  networkEnv: 'mainnet' as 'mainnet' | 'testnet',
  enableJpycAvalanche: true,
  feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560' as string | undefined,
  forwarders: new Set<number>([137, 8217, 43114, 80002, 1001, 43113]),
  disclosed: [137, 8217, 43114] as number[],
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    get isMainnet() {
      return hold.networkEnv === 'mainnet';
    },
    env: {
      ...actual.env,
      get networkEnv() {
        return hold.networkEnv;
      },
      get enableJpycAvalanche() {
        return hold.enableJpycAvalanche;
      },
      get feeReceiver() {
        return hold.feeReceiver;
      },
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) =>
    hold.forwarders.has(chainId) ? ('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4' as const) : null,
}));
vi.mock('@/lib/disclosedStoreGasWallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/disclosedStoreGasWallet')>();
  return {
    ...actual,
    DISCLOSED_STORE_GAS_WALLET: {
      ...actual.DISCLOSED_STORE_GAS_WALLET,
      get chainIds() {
        return hold.disclosed;
      },
    },
  };
});

/** チェーンの一覧 (JPYC_CHAINS 等) はモジュールの読み込み時に決まるので、設定を変えたら読み直す。 */
async function load() {
  vi.resetModules();
  return import('@/lib/storeDevicePayment');
}

afterEach(() => {
  hold.networkEnv = 'mainnet';
  hold.enableJpycAvalanche = true;
  hold.feeReceiver = '0x428483FbA62eDCef1E3a100d3799F6d71759c560';
  hold.forwarders = new Set([137, 8217, 43114, 80002, 1001, 43113]);
  hold.disclosed = [137, 8217, 43114];
});

describe('storeDeviceChainIds (新しい会計に使えるチェーン)', () => {
  it('mainnet: 開示したチェーンのうち設定がそろったものだけ (開示の順)', async () => {
    const m = await load();
    expect(m.storeDeviceChainIds()).toEqual([137, 8217, 43114]);
    hold.disclosed = [137];
    expect(m.storeDeviceChainIds()).toEqual([137]); // 開示していないチェーンは設定があっても点灯しない
  });

  it('mainnet: Avalanche の flag が OFF なら外れる (JPYC のチェーンでない)', async () => {
    hold.enableJpycAvalanche = false;
    const m = await load();
    expect(m.storeDeviceChainIds()).toEqual([137, 8217]);
    expect(m.storeDeviceChainConfig(43114)).toBeNull();
  });

  it('forwarder の無いチェーン (a1 ON を含む)・手数料受取口が無いときは外れる', async () => {
    hold.forwarders = new Set([137, 43114]);
    const m = await load();
    expect(m.storeDeviceChainIds()).toEqual([137, 43114]);
    hold.feeReceiver = undefined;
    expect(m.storeDeviceChainIds()).toEqual([]);
  });

  it('testnet: 対応する testnet (Amoy・Kairos・Fuji) ∩ 設定済み・mainnet のチェーンは使えない', async () => {
    hold.networkEnv = 'testnet';
    const m = await load();
    expect(m.storeDeviceChainIds()).toEqual([80002, 1001, 43113]);
    expect(m.isStoreDeviceChain(137)).toBe(false);
    expect(m.storeDeviceChainConfig(137)).toBeNull();
    hold.forwarders = new Set([80002]);
    expect(m.storeDeviceChainIds()).toEqual([80002]);
  });

  it('設定は JPYC・forwarder・手数料受取口をチェーンごとに返す (Ethereum・USDC のチェーンは null)', async () => {
    const m = await load();
    expect(m.storeDeviceChainConfig(8217)).toEqual({
      chainId: 8217,
      token: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
      forwarder: '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
      feeReceiver: '0x428483FbA62eDCef1E3a100d3799F6d71759c560',
    });
    expect(m.storeDeviceChainConfig(1)).toBeNull();
    expect(m.storeDeviceChainConfig(8453)).toBeNull();
  });

  it('画面のチェーン名の並び', async () => {
    const m = await load();
    expect(m.storeDeviceChainNames([137, 8217, 43114])).toBe('Polygon・Kaia・Avalanche');
    expect(m.storeDeviceChainNames([137, 8217], ', ')).toBe('Polygon, Kaia');
  });
});

describe('storeDeviceMaxGasCostWei (1 回の送信のガス代の上限)', () => {
  it('チェーンごと: Polygon 0.2 POL・Kaia 0.5 KAIA・Avalanche 0.05 AVAX (testnet も同じ)・表に無いチェーンは null', async () => {
    const m = await load();
    for (const id of [137, 80002]) expect(m.storeDeviceMaxGasCostWei(id)).toBe(2n * 10n ** 17n);
    for (const id of [8217, 1001]) expect(m.storeDeviceMaxGasCostWei(id)).toBe(5n * 10n ** 17n);
    for (const id of [43114, 43113]) expect(m.storeDeviceMaxGasCostWei(id)).toBe(5n * 10n ** 16n);
    expect(m.storeDeviceMaxGasCostWei(1)).toBeNull();
  });

  it('使えるチェーン (mainnet・testnet) にはすべて上限がある (上限の表と集合をずらさない)', async () => {
    const m = await load();
    for (const id of m.storeDeviceChainIds()) expect(m.storeDeviceMaxGasCostWei(id)).not.toBeNull();
    hold.networkEnv = 'testnet';
    const t = await load();
    for (const id of t.storeDeviceChainIds()) expect(t.storeDeviceMaxGasCostWei(id)).not.toBeNull();
  });
});
