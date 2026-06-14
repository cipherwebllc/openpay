import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAddress } from 'viem';
import {
  polygon,
  polygonAmoy,
  kaia,
  kairos,
  avalanche,
  mainnet,
  base,
} from 'viem/chains';

// forwarderConfig は module 評価時 (FORWARDER_ADDRESS_ENV) と関数呼出時 (relayGasFeeValue) の
// 両方で process.env を読む。env を確定 → resetModules → 動的 import することで、毎回 "実モジュール"
// を与えた env で評価する (mock 無し・実 viem isAddress/getAddress を実行する実コードパス)。
const FWD_KEYS = [
  'NEXT_PUBLIC_JPYC_FORWARDER_POLYGON',
  'NEXT_PUBLIC_JPYC_FORWARDER_AMOY',
  'NEXT_PUBLIC_JPYC_FORWARDER_KAIA',
  'NEXT_PUBLIC_JPYC_FORWARDER_KAIROS',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC',
  // per-chain floor 上書き env (PER_CHAIN_FLOOR_ENV)。relayGasFeeValue(chainId) が module 評価時に
  // リテラル参照するため、決定論のため毎回リセットする。
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_POLYGON',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_KAIA',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AMOY',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_KAIROS',
  'NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_FUJI',
  // a1 利用料フラグ。forwarderConfig は jpycForwarderFor の解決でこれを (env 経由で) 読むため、
  // forwarder env と同じく毎回リセットして決定論にする。
  'NEXT_PUBLIC_ENABLE_USAGE_FEE',
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

  it('a1 未設定 (=0/unset) なら設定済 forwarder をそのまま返す', async () => {
    const { jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: CHECKSUMMED,
    });
    expect(jpycForwarderFor(polygon.id)).toBe(CHECKSUMMED);
  });

  it('a1 (enableUsageFee) が ON なら forwarder env が設定済でも null (recover 自動無効化)', async () => {
    // a1 と recover は排他: a1 優先で *実効* forwarder を全 chain null に倒す → client は free
    // payload を組み、server も recoverMode=false で handleFree (ゲート/メーター付き) に倒れる。
    const { jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: CHECKSUMMED,
      NEXT_PUBLIC_JPYC_FORWARDER_AMOY: CHECKSUMMED,
      NEXT_PUBLIC_JPYC_FORWARDER_KAIA: CHECKSUMMED,
      NEXT_PUBLIC_JPYC_FORWARDER_KAIROS: CHECKSUMMED,
      NEXT_PUBLIC_ENABLE_USAGE_FEE: '1',
    });
    expect(jpycForwarderFor(polygon.id)).toBeNull();
    expect(jpycForwarderFor(polygonAmoy.id)).toBeNull();
    expect(jpycForwarderFor(kaia.id)).toBeNull();
    expect(jpycForwarderFor(kairos.id)).toBeNull();
  });
});

describe('configuredJpycForwarderFor (生の env 値・診断専用)', () => {
  it('a1 が ON でも設定済 forwarder アドレスをそのまま返す (起動時診断で構成ミスを検出するため)', async () => {
    const { configuredJpycForwarderFor, jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_POLYGON: CHECKSUMMED,
      NEXT_PUBLIC_ENABLE_USAGE_FEE: '1',
    });
    // 生の lookup は a1 に依存せず設定値を返す。
    expect(configuredJpycForwarderFor(polygon.id)).toBe(CHECKSUMMED);
    // 一方 a1-aware な jpycForwarderFor は同じ chain で null (実効 = free)。
    expect(jpycForwarderFor(polygon.id)).toBeNull();
  });

  it('a1 OFF では configuredJpycForwarderFor と jpycForwarderFor は一致する', async () => {
    const { configuredJpycForwarderFor, jpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_JPYC_FORWARDER_KAIA: CHECKSUMMED,
    });
    expect(configuredJpycForwarderFor(kaia.id)).toBe(CHECKSUMMED);
    expect(jpycForwarderFor(kaia.id)).toBe(CHECKSUMMED);
  });

  it('未設定 chain は a1 状態にかかわらず null', async () => {
    const { configuredJpycForwarderFor } = await loadWith({
      NEXT_PUBLIC_ENABLE_USAGE_FEE: '1',
    });
    expect(configuredJpycForwarderFor(polygon.id)).toBeNull();
  });
});

describe('relayGasFeeValue (per-chain floor)', () => {
  it('未設定 → 既定 2 JPYC (2e18)', async () => {
    const { relayGasFeeValue } = await loadWith({});
    expect(relayGasFeeValue(polygon.id)).toBe(2n * 10n ** 18n);
  });

  it('グローバル env の整数文字列 → その JPYC 量 (18 decimals)・全 chain 共通', async () => {
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '5',
    });
    // per-chain env 未設定なのでグローバル env が全 chain に適用される (後方互換)。
    expect(relayGasFeeValue(polygon.id)).toBe(5n * 10n ** 18n);
    expect(relayGasFeeValue(kaia.id)).toBe(5n * 10n ** 18n);
    expect(relayGasFeeValue(avalanche.id)).toBe(5n * 10n ** 18n);
  });

  it('CDX-2: グローバル "0" は誤設定として既定 2 JPYC に倒す (forwarder ZeroValue revert 回避・フロアは 1 wei 以上)', async () => {
    // Eip3009Forwarder.settle は feeValue==0 で ZeroValue revert する。0 を素通りさせると recover が
    // guaranteed-revert tx を broadcast して relayer gas を捨てる → フロアは 0 にならないことを保証する。
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '0',
    });
    expect(relayGasFeeValue(polygon.id)).toBe(2n * 10n ** 18n);
  });

  it('非整数/不正なグローバル値は既定 2 にフォールバック', async () => {
    const bad = ['abc', '-1', '2.5', ' 3 ', '1e3', '0x5', '', '1_000'];
    for (const v of bad) {
      const { relayGasFeeValue } = await loadWith({
        NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: v,
      });
      expect(relayGasFeeValue(polygon.id), `bad=${JSON.stringify(v)}`).toBe(
        2n * 10n ** 18n,
      );
    }
  });

  it('大きな値も bigint で正確 (精度欠損/overflow 無し)', async () => {
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '1000000',
    });
    expect(relayGasFeeValue(polygon.id)).toBe(1_000_000n * 10n ** 18n);
  });

  // --- per-chain 上書き (Avalanche 汎用化の核) ---

  it('per-chain env が当該 chain にのみ適用される (他 chain は不変)', async () => {
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE: '10',
    });
    expect(relayGasFeeValue(avalanche.id)).toBe(10n * 10n ** 18n);
    // Polygon/Kaia は per-chain 未設定 → 既定 2 のまま (チェーン独立)。
    expect(relayGasFeeValue(polygon.id)).toBe(2n * 10n ** 18n);
    expect(relayGasFeeValue(kaia.id)).toBe(2n * 10n ** 18n);
  });

  it('per-chain env はグローバル env より優先 (解決順 1 > 3)', async () => {
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '2',
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE: '15',
    });
    expect(relayGasFeeValue(avalanche.id)).toBe(15n * 10n ** 18n); // per-chain 勝ち
    expect(relayGasFeeValue(polygon.id)).toBe(2n * 10n ** 18n); // グローバルへ
  });

  it('per-chain "0"/不正値は採用せずグローバル env (→ 2) へフォールバック', async () => {
    for (const bad of ['0', 'abc', '2.5', '']) {
      const { relayGasFeeValue } = await loadWith({
        NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE: bad,
        NEXT_PUBLIC_RELAY_GAS_FEE_JPYC: '3',
      });
      expect(relayGasFeeValue(avalanche.id), `bad=${JSON.stringify(bad)}`).toBe(
        3n * 10n ** 18n,
      );
    }
  });

  it('per-chain "0" + グローバル未設定 → 既定 2 JPYC (どの段でも 0 を採用しない)', async () => {
    const { relayGasFeeValue } = await loadWith({
      NEXT_PUBLIC_RELAY_GAS_FEE_JPYC_AVALANCHE: '0',
    });
    expect(relayGasFeeValue(avalanche.id)).toBe(2n * 10n ** 18n);
  });
});
