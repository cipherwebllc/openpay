import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  buildJpycRelaySignPreview,
  buildJpycRecoverSignPreview,
} from '@/lib/signPreview';
import { AUTHORIZATION_VALIDITY_WINDOW_SEC } from '@/lib/jpycEip3009';

// recover プレビューは forwarder の有無 (jpycForwarderFor) と feeValue (recoverFeeValue) を
// 引くので、両者を mock して chain/env に依存しない決定論テストにする。
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/relay/forwarderConfig')
  >('@/lib/relay/forwarderConfig');
  return { ...actual, jpycForwarderFor: vi.fn(() => null) };
});
// L2: recoverFeeValue mock の戻り値を distinctive な 7e18 (≠ floor 2e18) にする。以前は
// 2e18 (= floor と同値) を返していたため、buildJpycRecoverSignPreview が recoverFeeValue へ
// 委譲しているのか floor をハードコードしているのか区別できず tautology だった。fee=7 にすると
// totalAtomic / feeHuman が「recoverFeeValue 由来」であることを実証できる。
const DISTINCT_FEE = 7n * 10n ** 18n; // 7 JPYC
vi.mock('@/lib/relay/recoverFee', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/recoverFee')>(
    '@/lib/relay/recoverFee',
  );
  return { ...actual, recoverFeeValue: vi.fn(() => 7n * 10n ** 18n) };
});

import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { recoverFeeValue } from '@/lib/relay/recoverFee';

const MERCHANT: Address = getAddress(
  '0x1234567890123456789012345678901234567890',
);
const FORWARDER: Address = getAddress(
  '0x0f4560A777415580f0680f8b56a79B0022c6b848',
);

describe('buildJpycRelaySignPreview', () => {
  it('amountAtomic は署名する value の .toString() と完全一致 (乖離ゼロのフェンス)', () => {
    // 本質: 照合表に出す生の数字は hook が署名する value と同一ソースでなければならない。
    const value = 300n * 10n ** 18n; // 300 JPYC (18 decimals)
    const p = buildJpycRelaySignPreview({
      value,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
    });
    expect(p.amountAtomic).toBe(value.toString());
    expect(p.amountAtomic).toBe('300000000000000000000');
  });

  it('amountHuman は decimals で整形される (18 桁)', () => {
    const p = buildJpycRelaySignPreview({
      value: 1500n * 10n ** 18n,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
    });
    expect(p.amountHuman).toBe('1500');
    expect(p.symbol).toBe('JPYC');
  });

  it('FX 換算 (USDC 6 桁) でも decimals に従って整形 + atomic 一致', () => {
    const value = 6_400_000n; // 6.4 USDC (6 decimals)
    const p = buildJpycRelaySignPreview({
      value,
      merchant: MERCHANT,
      decimals: 6,
      displaySymbol: 'USDC',
    });
    expect(p.amountHuman).toBe('6.4');
    expect(p.amountAtomic).toBe('6400000');
    expect(p.decimals).toBe(6);
  });

  it('expiresInMin は AUTHORIZATION_VALIDITY_WINDOW_SEC / 60 と一致 (定数直参照フェンス)', () => {
    const p = buildJpycRelaySignPreview({
      value: 1n,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
    });
    expect(p.expiresInMin).toBe(AUTHORIZATION_VALIDITY_WINDOW_SEC / 60);
    // 計画 §1 の「5 分失効」が定数側で変わったらここが落ちて気付ける。
    expect(p.expiresInMin).toBe(5);
  });

  it('to は merchant をそのまま透過 (mutate に渡す値と同一)', () => {
    const p = buildJpycRelaySignPreview({
      value: 1n,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
    });
    expect(p.to).toBe(MERCHANT);
  });

  it('storeName は任意 (未指定なら undefined)', () => {
    const withName = buildJpycRelaySignPreview({
      value: 1n,
      merchant: MERCHANT,
      storeName: 'OO商店',
      decimals: 18,
      displaySymbol: 'JPYC',
    });
    expect(withName.storeName).toBe('OO商店');
    const without = buildJpycRelaySignPreview({
      value: 1n,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
    });
    expect(without.storeName).toBeUndefined();
  });
});

describe('buildJpycRecoverSignPreview', () => {
  beforeEach(() => {
    vi.mocked(jpycForwarderFor).mockReturnValue(FORWARDER);
    // distinctive fee (7 JPYC ≠ floor 2 JPYC) で「fee は recoverFeeValue 由来」を実証する。
    vi.mocked(recoverFeeValue).mockReturnValue(DISTINCT_FEE);
  });

  it('customer モード: signedTotal = value + fee (ウォレットは表示額より大きい数を出す)', () => {
    // 1000 JPYC 決済・fee 7 JPYC → ウォレットは 1007 JPYC を出す。これが本質。
    const value = 1000n * 10n ** 18n;
    const p = buildJpycRecoverSignPreview({
      value,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 137,
      gasMode: 'customer',
    });
    expect(p).not.toBeNull();
    expect(p!.amountHuman).toBe('1000');
    // 委譲フェンス: floor をハードコードしていたら "2"。recoverFeeValue を呼べば "7"。
    expect(p!.feeHuman).toBe('7');
    expect(p!.totalHuman).toBe('1007');
    // 照合表の生の数字 = (value + fee).toString()。
    expect(p!.totalAtomic).toBe((1007n * 10n ** 18n).toString());
    // recoverFeeValue が (value, gasMode, chainId) で実際に呼ばれたことを確認 (delegation の直接証明)。
    expect(recoverFeeValue).toHaveBeenCalledWith(value, 'customer', 137);
    expect(p!.gasMode).toBe('customer');
    expect(p!.symbol).toBe('JPYC');
  });

  it('merchant モード: signedTotal = value (ウォレット表示 = 表示価格・手数料は受取から内枠吸収)', () => {
    const value = 1000n * 10n ** 18n;
    const p = buildJpycRecoverSignPreview({
      value,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 137,
      gasMode: 'merchant',
    });
    expect(p).not.toBeNull();
    // merchantValue = value - fee, signedTotal = merchantValue + fee = value。
    expect(p!.amountHuman).toBe('1000');
    expect(p!.feeHuman).toBe('7');
    expect(p!.totalHuman).toBe('1000');
    expect(p!.totalAtomic).toBe(value.toString());
    expect(recoverFeeValue).toHaveBeenCalledWith(value, 'merchant', 137);
    expect(p!.gasMode).toBe('merchant');
  });

  it('fee がフロアを超える (bps>0 大口) 場合も customer/merchant の式が一致する', () => {
    // 10000 JPYC 決済・fee 100 JPYC (1%) を mock。
    vi.mocked(recoverFeeValue).mockReturnValue(100n * 10n ** 18n);
    const value = 10000n * 10n ** 18n;
    const cust = buildJpycRecoverSignPreview({
      value,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 137,
      gasMode: 'customer',
    });
    expect(cust!.totalHuman).toBe('10100'); // value + fee
    const merch = buildJpycRecoverSignPreview({
      value,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 137,
      gasMode: 'merchant',
    });
    expect(merch!.totalHuman).toBe('10000'); // (value - fee) + fee
    expect(merch!.feeHuman).toBe('100');
  });

  it('forwarder = to (署名の宛先) で merchant は受取店舗として別保持', () => {
    const p = buildJpycRecoverSignPreview({
      value: 1000n * 10n ** 18n,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 137,
      gasMode: 'customer',
    });
    expect(p!.forwarder).toBe(FORWARDER);
    expect(p!.merchant).toBe(MERCHANT);
  });

  it('forwarder 未設定 (free モード chain) では null を返す (form は free 経路へ倒れる)', () => {
    vi.mocked(jpycForwarderFor).mockReturnValue(null);
    const p = buildJpycRecoverSignPreview({
      value: 1000n * 10n ** 18n,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 80002,
      gasMode: 'customer',
    });
    expect(p).toBeNull();
  });

  it('expiresInMin は AUTHORIZATION_VALIDITY_WINDOW_SEC / 60 と一致 (free と同一定数)', () => {
    const p = buildJpycRecoverSignPreview({
      value: 1000n * 10n ** 18n,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 137,
      gasMode: 'customer',
    });
    expect(p!.expiresInMin).toBe(AUTHORIZATION_VALIDITY_WINDOW_SEC / 60);
    expect(p!.expiresInMin).toBe(5);
  });

  it('FX 換算 (USDC 6 桁) でも decimals に従って整形 + atomic 一致 (customer)', () => {
    // fee を 6 桁の 0.02 USDC 相当に mock。value 100 USDC → total 100.02 USDC。
    vi.mocked(recoverFeeValue).mockReturnValue(20000n); // 0.02 USDC (6 decimals)
    const value = 100_000_000n; // 100 USDC
    const p = buildJpycRecoverSignPreview({
      value,
      merchant: MERCHANT,
      decimals: 6,
      displaySymbol: 'USDC',
      chainId: 137,
      gasMode: 'customer',
    });
    expect(p!.amountHuman).toBe('100');
    expect(p!.feeHuman).toBe('0.02');
    expect(p!.totalHuman).toBe('100.02');
    expect(p!.totalAtomic).toBe('100020000');
    expect(p!.decimals).toBe(6);
  });

  it('storeName は任意 (未指定なら undefined)', () => {
    const without = buildJpycRecoverSignPreview({
      value: 1000n * 10n ** 18n,
      merchant: MERCHANT,
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 137,
      gasMode: 'customer',
    });
    expect(without!.storeName).toBeUndefined();
    const withName = buildJpycRecoverSignPreview({
      value: 1000n * 10n ** 18n,
      merchant: MERCHANT,
      storeName: 'OO商店',
      decimals: 18,
      displaySymbol: 'JPYC',
      chainId: 137,
      gasMode: 'customer',
    });
    expect(withName!.storeName).toBe('OO商店');
  });
});
