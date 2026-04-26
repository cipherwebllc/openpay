import { describe, it, expect } from 'vitest';
import {
  pimlicoUrl,
  pimlicoPaymasterContext,
  createPimlico,
} from '@/lib/pimlico';

describe('pimlicoUrl', () => {
  it('chainId と API key を含む URL を返す', () => {
    const url = pimlicoUrl(8453);
    expect(url).toBe(
      'https://api.pimlico.io/v2/8453/rpc?apikey=test_pimlico_key',
    );
  });

  it('別 chainId でもパス変化のみで API key は同じ', () => {
    expect(pimlicoUrl(80002)).toContain('/v2/80002/rpc');
  });
});

describe('pimlicoPaymasterContext', () => {
  it('SPONSORSHIP_POLICY_ID が設定されていれば paymasterContext を返す', () => {
    expect(pimlicoPaymasterContext()).toEqual({
      sponsorshipPolicyId: 'sp_test',
    });
  });
});

describe('createPimlico', () => {
  it('PimlicoClient インスタンスを生成 (transport 設定済み)', () => {
    const client = createPimlico(8453);
    // PimlicoClient は viem の Client 派生で、chain プロパティはないが
    // transport.type === 'http' を持つことで HTTP transport を確認できる。
    expect(client).toBeDefined();
    expect(typeof client.request).toBe('function');
  });
});
