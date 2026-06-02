import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAddress } from 'viem';
import { polygon, polygonAmoy, kaia, kairos, mainnet, base } from 'viem/chains';

// forwarderConfig は module 評価時 (FORWARDER_ADDRESS_ENV) と関数呼出時 (relayGasFeeValue) の
// 両方で process.env を読む。env を確定 → resetModules → 動的 import することで、毎回 "実モジュール"
// を与えた env で評価する (mock 無し・実 viem isAddress/getAddress を実行する実コードパス)。
const FWD_KEYS = [
  'NEXT_PUBLIC_JPYC_FORWARDER_POLYGON',
  'NEXT_PUBLIC_JPYC_FORWARDER_AMOY',
  'NEXT_PUBLIC_JPYC_FORWARDER_KAIA',
  'NEXT_PUBLIC_JPYC_FORWARDER_KAIROS',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC',
] as const;

type FwdKey = (typeof FWD_KEYS)[number];

async function loadWith(env: Partial<Record<FwdKey, string>>) {
  for (const k of FWD_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import('@/lib/relay/forwarderConfig');
}

afterEach(() => {
  for (const k of FWD_KEYS) delete process.env[k];
  vi.resetModules();
});

// 実在の forwarder (checksummed) と、その lowercase。
const CHECKSUMMED = '0x0F4560a777415580F0680F8B56a79B0022C6B848';
const LOWERCASE = '0x0f4560a777415580f0680f8b56a79b0022c6b848';

describe('jpycForwarderFor', () => {
  it('checksummed address はそのまま返る (Polygon)', async () => {
    const { jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: CHECKSUMMED,
    });
    expect(jpycForwarderFor(polygon.id)).toBe(CHECKSUMMED);
  });

  it('lowercase address は EIP-55 checksum 形に正規化して返る (getAddress を実行)', async () => {
    const { jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_KAIA: LOWERCASE,
    });
    expect(jpycForwarderFor(kaia.id)).toBe(CHECKSUMMED);
  });

  it('4 chain (Polygon/Amoy/Kaia/Kairos) はそれぞれ自分の env から独立解決する', async () => {
    const POLY = '0x1111111111111111111111111111111111111111';
    const AMOY = '0x2222222222222222222222222222222222222222';
    const KAIA = '0x3333333333333333333333333333333333333333';
    const KAIROS = '0x4444444444444444444444444444444444444444';
    const { jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: POLY,
      NEXT_PUBLIC_JPYC_FORWARDER_AMOY: AMOY,
      NEXT_PUBLIC_JPYC_FORWARDER_KAIA: KAIA,
      NEXT_PUBLIC_JPYC_FORWARDER_KAIROS: KAIROS,
    });
    expect(jpycForwarderFor(polygon.id)).toBe(getAddress(POLY));
    expect(jpycForwarderFor(polygonAmoy.id)).toBe(getAddress(AMOY));
    expect(jpycForwarderFor(kaia.id)).toBe(getAddress(KAIA));
    expect(jpycForwarderFor(kairos.id)).toBe(getAddress(KAIROS));
  });

  it('対応 chain でも env 未設定なら null (= free モード)', async () => {
    const { jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: CHECKSUMMED,
    });
    expect(jpycForwarderFor(polygonAmoy.id)).toBeNull();
    expect(jpycForwarderFor(kaia.id)).toBeNull();
    expect(jpycForwarderFor(kairos.id)).toBeNull();
  });

  it('非対応 chainId は env を設定しても null (table に無い)', async () => {
    const { jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: CHECKSUMMED,
      NEXT_PUBLIC_JPYC_FORWARDER_KAIA: CHECKSUMMED,
    });
    expect(jpycForwarderFor(mainnet.id)).toBeNull(); // 1 = Ethereum L1
    expect(jpycForwarderFor(base.id)).toBeNull(); // 8453 = Base
    expect(jpycForwarderFor(0)).toBeNull();
    expect(jpycForwarderFor(-1)).toBeNull();
  });

  it('不正な address 文字列は null (実 isAddress でガード)', async () => {
    const bad = [
      '0x123', // 短すぎ
      'notanaddress', // 0x なし
      '', // 空 (raw && の短絡)
      '0xZZ4560a777415580F0680F8B56a79B0022C6B848', // 非 hex (Z)
      '0x0F4560a777415580F0680F8B56a79B0022C6B8', // 39 nibble (1 文字不足)
      '0x0F4560a777415580F0680F8B56a79B0022C6B84800', // 41 nibble (超過)
    ];
    for (const v of bad) {
      const { jpycForwarderFor } = await loadWith({
        NEXT_PUBLIC_JPYC_FORWARDER_KAIROS: v,
      });
      expect(jpycForwarderFor(kairos.id), `bad=${JSON.stringify(v)}`).toBeNull();
    }
  });
});

describe('relayGasFeeValue', () => {
  it('未設定 → 既定 2 JPYC (2e18)', async () => {
    const { relayGasFeeValue } = await loadWith({});
    expect(relayGasFeeValue()).toBe(2n * 10n ** 18n);
  });

  it('整数文字列 → その JPYC 量 (18 decimals)', async () => {
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '5',
    });
    expect(relayGasFeeValue()).toBe(5n * 10n ** 18n);
  });

  it('"0" は有効 → 0n (下限フロア無し・境界値)', async () => {
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '0',
    });
    expect(relayGasFeeValue()).toBe(0n);
  });

  it('非整数/不正値は既定 2 にフォールバック', async () => {
    const bad = ['abc', '-1', '2.5', ' 3 ', '1e3', '0x5', '', '1_000'];
    for (const v of bad) {
      const { relayGasFeeValue } = await loadWith({
        NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: v,
      });
      expect(relayGasFeeValue(), `bad=${JSON.stringify(v)}`).toBe(
        2n * 10n ** 18n,
      );
    }
  });

  it('大きな値も bigint で正確 (精度欠損/overflow 無し)', async () => {
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '1000000',
    });
    expect(relayGasFeeValue()).toBe(1_000_000n * 10n ** 18n);
  });
});
