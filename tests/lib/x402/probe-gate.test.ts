// probeGate: 登録 URL のゲート方式判定 (openpay / foreign / unknown)。
// foreign = 「JPYC で払える」というカタログの約束を守れないゲート (USDC/Base 等) の検出。

import { describe, expect, it } from 'vitest';
import { probeGate } from '@/lib/x402/moderation';

const lookupPublic = async () => [{ address: '93.184.216.34', family: 4 }];

const openpayBody = {
  x402Version: 1,
  accepts: [{ scheme: 'exact', extra: { openpay: { mode: 'forwarder-split' } } }],
  error: 'payment_required',
};
const usdcBody = {
  x402Version: 1,
  accepts: [{ scheme: 'exact', network: 'base', asset: '0x8335...', extra: { name: 'USD Coin' } }],
};

function res402(body: unknown, headers: Record<string, string> = {}) {
  return async () =>
    ({
      status: 402,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    }) as unknown as Response;
}

describe('lib/x402/moderation probeGate', () => {
  it('402 + extra.openpay.forwarder-split → openpay (掲載可)', async () => {
    expect(
      await probeGate('https://x.test/paid', { fetchImpl: res402(openpayBody) as never, lookup: lookupPublic }),
    ).toBe('openpay');
  });

  it('402 + USDC/Base accepts (extra.openpay なし) → foreign (掲載拒否)', async () => {
    expect(
      await probeGate('https://x.test/paid', { fetchImpl: res402(usdcBody) as never, lookup: lookupPublic }),
    ).toBe('foreign');
  });

  it('402 + JSON でない body → foreign (解釈不能なゲートは約束できない)', async () => {
    const fetchImpl = (async () =>
      ({
        status: 402,
        headers: { get: () => null },
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response) as never;
    expect(await probeGate('https://x.test/paid', { fetchImpl, lookup: lookupPublic })).toBe('foreign');
  });

  it('v2: PAYMENT-REQUIRED ヘッダに openpay accepts → openpay', async () => {
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: openpayBody.accepts })).toString('base64');
    const fetchImpl = res402({ note: 'body is not v1' }, { 'payment-required': header }) as never;
    expect(await probeGate('https://x.test/paid', { fetchImpl, lookup: lookupPublic })).toBe('openpay');
  });

  it('402 以外 (200/500) / ネットワーク失敗 / private 解決 → unknown (fail-open)', async () => {
    const ok200 = (async () => ({ status: 200, headers: { get: () => null }, json: async () => ({}) }) as unknown as Response) as never;
    expect(await probeGate('https://x.test/paid', { fetchImpl: ok200, lookup: lookupPublic })).toBe('unknown');
    const boom = (async () => {
      throw new Error('network');
    }) as never;
    expect(await probeGate('https://x.test/paid', { fetchImpl: boom, lookup: lookupPublic })).toBe('unknown');
    const lookupPrivate = async () => [{ address: '10.0.0.5', family: 4 }];
    expect(await probeGate('https://x.test/paid', { fetchImpl: ok200, lookup: lookupPrivate })).toBe('unknown');
  });
});
