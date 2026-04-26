import { describe, it, expect } from 'vitest';
import { TOKENS, getToken, isValidTokenSymbol } from '@/lib/tokens';
import { baseSepolia, polygonAmoy } from 'viem/chains';

// vitest.config.ts で NETWORK_ENV='testnet' を設定済みなので、
// TOKENS は testnet (Polygon Amoy / Base Sepolia) 系の定義を返すはず。

describe('TOKENS table', () => {
  it('jpyc は 18 decimals', () => {
    expect(TOKENS.jpyc.decimals).toBe(18);
    expect(TOKENS.jpyc.displaySymbol).toBe('JPYC');
  });

  it('usdc は 6 decimals', () => {
    expect(TOKENS.usdc.decimals).toBe(6);
    expect(TOKENS.usdc.displaySymbol).toBe('USDC');
  });

  it('jpyc の chainId は Polygon Amoy (testnet 環境)', () => {
    expect(TOKENS.jpyc.chainId).toBe(polygonAmoy.id);
  });

  it('usdc の chainId は Base Sepolia (testnet 環境)', () => {
    expect(TOKENS.usdc.chainId).toBe(baseSepolia.id);
  });

  it('testnet で env override が効く (NEXT_PUBLIC_JPYC_TESTNET_ADDRESS)', () => {
    expect(TOKENS.jpyc.address.toLowerCase()).toBe(
      '0x0000000000000000000000000000000000000abc',
    );
  });

  it('Base Sepolia の USDC は Circle 公式アドレスがフォールバック', () => {
    expect(TOKENS.usdc.address.toLowerCase()).toBe(
      '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    );
  });
});

describe('isValidTokenSymbol', () => {
  it.each(['jpyc', 'usdc'])('"%s" → true', (s) => {
    expect(isValidTokenSymbol(s)).toBe(true);
  });

  it.each(['eth', 'JPYC', '', 'btc', 'usdt'])('"%s" → false', (s) => {
    expect(isValidTokenSymbol(s)).toBe(false);
  });
});

describe('getToken', () => {
  it('TOKENS と同じオブジェクトを返す', () => {
    expect(getToken('jpyc')).toBe(TOKENS.jpyc);
    expect(getToken('usdc')).toBe(TOKENS.usdc);
  });
});
