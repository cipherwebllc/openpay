// probeGate: 登録 URL のゲート方式判定 (openpay / foreign / unknown)。
// foreign = 「JPYC で払える」というカタログの約束を守れないゲート (USDC/Base 等) の検出。

import { describe, expect, it } from 'vitest';
import { probeGate, probeGateDetailed } from '@/lib/x402/moderation';

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
    new Response(JSON.stringify(body), {
      status: 402,
      headers,
    });
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
      new Response('not json', { status: 402 })) as never;
    expect(await probeGate('https://x.test/paid', { fetchImpl, lookup: lookupPublic })).toBe('foreign');
  });

  it('402 + 64KiB 超 body → stream を cap で打ち切り foreign', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(64 * 1024 + 1), { status: 402 })) as never;
    expect(
      await probeGate('https://x.test/paid', {
        fetchImpl,
        lookup: lookupPublic,
      }),
    ).toBe('foreign');
  });

  it('v2: PAYMENT-REQUIRED ヘッダに openpay accepts → openpay', async () => {
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: openpayBody.accepts })).toString('base64');
    const fetchImpl = res402({ note: 'body is not v1' }, { 'payment-required': header }) as never;
    expect(await probeGate('https://x.test/paid', { fetchImpl, lookup: lookupPublic })).toBe('openpay');
  });

  it('公開 IPv6 リテラル URL: 角括弧を剥がして probe → openpay (旧実装は fail-open で unknown)', async () => {
    // 実 dns.lookup は角括弧付きで ENOTFOUND → 正規化しないと catch で 'unknown' (fail-open) となり
    // foreign ゲート拒否も openpay 判定も IPv6 ホストで無効化される。正規化後は解決して 402 を判定できる。
    const lookupBracketAware = async (h: string) => {
      if (h.startsWith('[') || h.endsWith(']')) throw new Error('ENOTFOUND');
      return [{ address: '2606:4700:4700::1111', family: 6 }];
    };
    expect(
      await probeGate('https://[2606:4700:4700::1111]/paid', {
        fetchImpl: res402(openpayBody) as never,
        lookup: lookupBracketAware,
      }),
    ).toBe('openpay');
  });

  it('402 以外 (200/500) / ネットワーク失敗 / private 解決 → unknown (fail-open)', async () => {
    const ok200 = (async () => new Response('{}', { status: 200 })) as never;
    expect(await probeGate('https://x.test/paid', { fetchImpl: ok200, lookup: lookupPublic })).toBe('unknown');
    const boom = (async () => {
      throw new Error('network');
    }) as never;
    expect(await probeGate('https://x.test/paid', { fetchImpl: boom, lookup: lookupPublic })).toBe('unknown');
    const lookupPrivate = async () => [{ address: '10.0.0.5', family: 4 }];
    expect(await probeGate('https://x.test/paid', { fetchImpl: ok200, lookup: lookupPrivate })).toBe('unknown');
  });
});

// 新規登録の照合 (lib/x402/registrationGateMatch.ts) に渡す accepts。判定と取得の順は probeGate と同じ。
describe('lib/x402/moderation probeGateDetailed', () => {
  it('v1 body が openpay → その body の accepts を返す', async () => {
    expect(
      await probeGateDetailed('https://x.test/paid', { fetchImpl: res402(openpayBody) as never, lookup: lookupPublic }),
    ).toEqual({ result: 'openpay', accepts: openpayBody.accepts });
  });

  it('v2 ヘッダが openpay → ヘッダの accepts を返し、body は読まない', async () => {
    const headerAccepts = [{ ...openpayBody.accepts[0], network: 'eip155:137' }];
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: headerAccepts })).toString('base64');
    const response = new Response(JSON.stringify(usdcBody), { status: 402, headers: { 'payment-required': header } });
    const detail = await probeGateDetailed('https://x.test/paid', {
      fetchImpl: (async () => response) as never, lookup: lookupPublic,
    });
    expect(detail).toEqual({ result: 'openpay', accepts: headerAccepts });
    expect(response.bodyUsed).toBe(false);
  });

  it('v2 ヘッダが USDC だけでも、v1 body の openpay accepts を返す (dual-rail の 402)', async () => {
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: usdcBody.accepts })).toString('base64');
    const body = { x402Version: 1, accepts: [...openpayBody.accepts, ...usdcBody.accepts] };
    expect(
      await probeGateDetailed('https://x.test/paid', {
        fetchImpl: res402(body, { 'payment-required': header }) as never, lookup: lookupPublic,
      }),
    ).toEqual({ result: 'openpay', accepts: body.accepts });
  });

  it('foreign / unknown は accepts を返さない', async () => {
    expect(
      await probeGateDetailed('https://x.test/paid', { fetchImpl: res402(usdcBody) as never, lookup: lookupPublic }),
    ).toEqual({ result: 'foreign', accepts: [] });
    const status500 = (async () => new Response('{}', { status: 500 })) as never;
    expect(
      await probeGateDetailed('https://x.test/paid', { fetchImpl: status500, lookup: lookupPublic }),
    ).toEqual({ result: 'unknown', accepts: [] });
  });
});
