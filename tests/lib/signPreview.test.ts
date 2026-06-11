import { describe, it, expect } from 'vitest';
import { getAddress, type Address } from 'viem';
import { buildJpycRelaySignPreview } from '@/lib/signPreview';
import { AUTHORIZATION_VALIDITY_WINDOW_SEC } from '@/lib/jpycEip3009';

const MERCHANT: Address = getAddress(
  '0x1234567890123456789012345678901234567890',
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
