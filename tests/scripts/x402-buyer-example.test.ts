import { afterEach, describe, it, expect, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { getAddress, type Address, type Hex } from 'viem';
import {
  FORWARDER_COMMIT_VERSION,
  buildForwarderNonce,
  buildReceiveWithAuthorizationTypedData,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';

type NormalizedAccept = {
  network: string;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: {
    openpay: {
      forwarder: Address;
      merchantValue: bigint;
      feeValue: bigint;
    };
  };
};

type BuyerScript = {
  main: () => Promise<void>;
  parsePurchaseUrl: (raw: string) => URL;
  assertSameOriginResponse: (response: Response, origin: string, label: string) => void;
  assertResourceOrigin: (rawAccept: unknown, origin: string) => void;
  DEFAULT_MAX_JPYC: string;
  parseJpycCap: (raw: string, label?: string) => bigint;
  assertWithinCap: (total: bigint, cap: bigint, capLabel: string) => void;
  assertSupportedAssetAndForwarder: (accept: NormalizedAccept) => NormalizedAccept;
  clampAuthorizationTimeout: (maxTimeoutSeconds: number) => number;
  normalizePaymentRequirements: (raw: Record<string, unknown>) => NormalizedAccept;
  buildForwarderNonce: (
    params: ForwarderSettleParams,
    chainId: number,
    forwarder: Address,
    commitVersion: Hex,
  ) => Hex;
  buildTypedDataFromPaymentRequirements: (
    accept: Record<string, unknown>,
    authorization: {
      from: Address;
      validAfter: string;
      validBefore: string;
      intentSalt: Hex;
    },
  ) => {
    params: ForwarderSettleParams;
    typedData: ReturnType<typeof buildReceiveWithAuthorizationTypedData>;
  };
};

const JPYC = 10n ** 18n;
const CHAIN = 80002;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x4444444444444444444444444444444444444444');
const FROM = getAddress('0x1111111111111111111111111111111111111111');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const SALT =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hex;

async function loadBuyerScript(): Promise<BuyerScript> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/x402-buyer-example.mjs')).href
  )) as BuyerScript;
}

function params(): ForwarderSettleParams {
  return {
    from: FROM,
    merchant: MERCHANT,
    merchantValue: 5n * JPYC,
    feeReceiver: FEE_RECEIVER,
    feeValue: 2n * JPYC,
    validAfter: 0n,
    validBefore: 1_000_000_600n,
    intentSalt: SALT,
  };
}

function accept(): Record<string, unknown> {
  const p = params();
  return {
    scheme: 'exact',
    network: `eip155:${CHAIN}`,
    maxAmountRequired: (p.merchantValue + p.feeValue).toString(),
    resource: 'https://open-pay.jp/api/paid/stores',
    description: 'Directory of JPYC-accepting exchanges, dApps and bridges (curated JSON).',
    mimeType: 'application/json',
    payTo: FORWARDER,
    maxTimeoutSeconds: 600,
    asset: TOKEN,
    extra: {
      name: 'JPY Coin',
      version: '1',
      decimals: 18,
      assetTransferMethod: 'eip3009',
      openpay: {
        mode: 'forwarder-split',
        forwarder: FORWARDER,
        merchant: MERCHANT,
        merchantValue: p.merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: p.feeValue.toString(),
        commitVersion: FORWARDER_COMMIT_VERSION,
      },
    },
  };
}

describe('scripts/x402-buyer-example.mjs', () => {
  it('forwarder nonce construction mirrors lib/relay/forwarderIntent exactly', async () => {
    const buyer = await loadBuyerScript();
    const p = params();
    expect(buyer.buildForwarderNonce(p, CHAIN, FORWARDER, FORWARDER_COMMIT_VERSION)).toBe(
      buildForwarderNonce(p, CHAIN, FORWARDER),
    );
  });

  it('typed data from accepts.extra.openpay matches forwarderIntent output', async () => {
    const buyer = await loadBuyerScript();
    const p = params();
    const out = buyer.buildTypedDataFromPaymentRequirements(accept(), {
      from: p.from,
      validAfter: p.validAfter.toString(),
      validBefore: p.validBefore.toString(),
      intentSalt: p.intentSalt,
    });
    const expected = buildReceiveWithAuthorizationTypedData(
      p,
      CHAIN,
      TOKEN,
      FORWARDER,
    );
    expect(out.params).toEqual(p);
    expect(out.typedData).toEqual(expected);
  });
});

// 署名前の金銭ガード (Phase 0a)。402 の自己申告を鵜呑みにせず、上限・既知 asset/
// forwarder・有効期限の 3 点で止まることを検証する。
describe('scripts/x402-buyer-example.mjs: 署名前ガード', () => {
  // SDK guards.mjs の SUPPORTED_JPYC_FORWARDERS['eip155:80002'] と同値。
  const KNOWN_AMOY_FORWARDER = getAddress(
    '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
  );

  function guardedAccept(
    overrides: { asset?: Address; forwarder?: Address } = {},
  ): Record<string, unknown> {
    const forwarder = overrides.forwarder ?? KNOWN_AMOY_FORWARDER;
    const base = accept();
    const extra = base.extra as Record<string, unknown>;
    const openpay = extra.openpay as Record<string, unknown>;
    return {
      ...base,
      asset: overrides.asset ?? TOKEN,
      payTo: forwarder,
      extra: { ...extra, openpay: { ...openpay, forwarder } },
    };
  }

  it('総額が MAX_JPYC を超えたら署名前に中止する', async () => {
    const buyer = await loadBuyerScript();
    const normalized = buyer.assertSupportedAssetAndForwarder(
      buyer.normalizePaymentRequirements(guardedAccept()),
    );
    const total =
      normalized.extra.openpay.merchantValue + normalized.extra.openpay.feeValue;
    expect(total).toBe(7n * JPYC); // merchant 5 + fee 2

    expect(() =>
      buyer.assertWithinCap(total, buyer.parseJpycCap('5'), '5'),
    ).toThrow(/MAX_JPYC=5/);
    // 既定 5 JPYC は現行カタログを想定した保守値。上限内なら通る。
    expect(buyer.DEFAULT_MAX_JPYC).toBe('5');
    expect(() =>
      buyer.assertWithinCap(total, buyer.parseJpycCap('10'), '10'),
    ).not.toThrow();
    // 小数の上限も atomic に落として比較する
    expect(buyer.parseJpycCap('0.5')).toBe(5n * 10n ** 17n);
  });

  it('validBefore の元になる timeout は facilitator 上限 (1200s) で頭打ちにする', async () => {
    const buyer = await loadBuyerScript();
    expect(buyer.clampAuthorizationTimeout(3600)).toBe(1200);
    expect(buyer.clampAuthorizationTimeout(600)).toBe(600);
  });

  it('未知の asset は署名前に中止する (別 token の署名を引き出させない)', async () => {
    const buyer = await loadBuyerScript();
    const rogueToken = getAddress('0x5555555555555555555555555555555555555555');
    expect(() =>
      buyer.assertSupportedAssetAndForwarder(
        buyer.normalizePaymentRequirements(guardedAccept({ asset: rogueToken })),
      ),
    ).toThrow(/既知 JPYC/);
  });

  it('未知の forwarder/payTo は署名前に中止する (総額の付け替えを止める)', async () => {
    const buyer = await loadBuyerScript();
    expect(() =>
      buyer.assertSupportedAssetAndForwarder(
        buyer.normalizePaymentRequirements(guardedAccept({ forwarder: FORWARDER })),
      ),
    ).toThrow(/既知の OpenPay forwarder/);
  });
});

// 購入先の固定 (外部レビュー P2-3)。平文 HTTP・転送・別 origin の resource から来た支払条件には署名しない。
describe('scripts/x402-buyer-example.mjs: 購入先の origin の固定', () => {
  const ORIGIN = 'https://open-pay.jp';
  const RESOURCE = `${ORIGIN}/api/paid/stores`;
  const KNOWN_AMOY_FORWARDER = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';

  function challenge(resource: unknown = RESOURCE): Record<string, unknown> {
    const base = accept();
    const extra = base.extra as Record<string, unknown>;
    const openpay = extra.openpay as Record<string, unknown>;
    return {
      ...base,
      resource,
      payTo: KNOWN_AMOY_FORWARDER,
      extra: { ...extra, openpay: { ...openpay, forwarder: KNOWN_AMOY_FORWARDER } },
    };
  }

  function withUrl(response: Response, url: string, redirected = false): Response {
    Object.defineProperty(response, 'url', { value: url });
    Object.defineProperty(response, 'redirected', { value: redirected });
    return response;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('購入先は https の公開ホストだけ (http は localhost も含めて通さない)', async () => {
    const buyer = await loadBuyerScript();
    expect(buyer.parsePurchaseUrl(RESOURCE).href).toBe(RESOURCE);
    for (const raw of [
      'http://open-pay.jp/api/paid/stores',
      'http://localhost:3000/api/paid/stores',
      'https://127.0.0.1/api/paid/stores',
      'https://user:pass@open-pay.jp/api/paid/stores',
      'ftp://open-pay.jp/x',
      'not a url',
    ]) {
      expect(() => buyer.parsePurchaseUrl(raw), raw).toThrow(/https の公開ホストのみ/);
    }
  });

  it('転送 (3xx・redirected・opaqueredirect) と別 origin の応答を拒む', async () => {
    const buyer = await loadBuyerScript();
    expect(() => buyer.assertSameOriginResponse(new Response(null, { status: 402 }), ORIGIN, '402 の取得')).not.toThrow();
    expect(() =>
      buyer.assertSameOriginResponse(withUrl(new Response(null, { status: 402 }), `${ORIGIN}/api/paid/x`), ORIGIN, '402 の取得'),
    ).not.toThrow();
    expect(() =>
      buyer.assertSameOriginResponse(
        new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
        ORIGIN,
        '402 の取得',
      ),
    ).toThrow(/402 の取得の応答が転送 \(HTTP 302\)/);
    expect(() =>
      buyer.assertSameOriginResponse(withUrl(new Response(null, { status: 402 }), 'https://evil.example/x', true), ORIGIN, '402 の取得'),
    ).toThrow(/転送/);
    expect(() =>
      buyer.assertSameOriginResponse(withUrl(new Response(null, { status: 402 }), 'https://evil.example/x'), ORIGIN, '402 の取得'),
    ).toThrow(/https:\/\/open-pay\.jp 以外から届きました/);
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' });
    expect(() => buyer.assertSameOriginResponse(opaque, ORIGIN, '402 の取得')).toThrow(/転送/);
  });

  it('支払条件の resource は (あれば) 最初の URL と同じ origin でなければ拒む', async () => {
    const buyer = await loadBuyerScript();
    expect(() => buyer.assertResourceOrigin(accept(), ORIGIN)).not.toThrow();
    expect(() => buyer.assertResourceOrigin({ ...accept(), resource: undefined }, ORIGIN)).not.toThrow();
    expect(() => buyer.assertResourceOrigin({ ...accept(), resource: `${ORIGIN}/api/paid/other` }, ORIGIN)).not.toThrow();
    for (const resource of ['https://evil.example/api/paid/stores', 'http://open-pay.jp/api/paid/stores', 'https://open-pay.jp:8443/x', 'nope', 42, null]) {
      expect(() => buyer.assertResourceOrigin({ ...accept(), resource }, ORIGIN), String(resource)).toThrow(
        /別の origin です — 署名せず中止します/,
      );
    }
  });

  function stubRun(responses: Array<() => Response>) {
    vi.stubEnv('BUYER_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
    vi.stubEnv('MAX_JPYC', '7');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch');
      return next();
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('main: http の RESOURCE_URL は 1 バイトも送らずに止まる', async () => {
    const buyer = await loadBuyerScript();
    const fetchMock = stubRun([]);
    vi.stubEnv('RESOURCE_URL', 'http://open-pay.jp/api/paid/stores');
    await expect(buyer.main()).rejects.toThrow(/https の公開ホストのみ/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('main: 402 の取得が転送なら追わずに、署名せず止まる', async () => {
    const buyer = await loadBuyerScript();
    const fetchMock = stubRun([
      () => new Response(null, { status: 307, headers: { location: 'https://evil.example/api/paid/stores' } }),
    ]);
    vi.stubEnv('RESOURCE_URL', RESOURCE);
    await expect(buyer.main()).rejects.toThrow(/402 の取得の応答が転送 \(HTTP 307\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('main: resource が別の origin の支払条件には署名しない', async () => {
    const buyer = await loadBuyerScript();
    const fetchMock = stubRun([
      () => Response.json({ accepts: [challenge('https://evil.example/api/paid/stores')] }, { status: 402 }),
    ]);
    vi.stubEnv('RESOURCE_URL', RESOURCE);
    await expect(buyer.main()).rejects.toThrow(/別の origin です/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('main: 署名した支払いの再送が転送で返っても追わず、失敗で終わる', async () => {
    const buyer = await loadBuyerScript();
    const fetchMock = stubRun([
      () => Response.json({ accepts: [challenge()] }, { status: 402 }),
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    ]);
    vi.stubEnv('RESOURCE_URL', RESOURCE);
    await expect(buyer.main()).rejects.toThrow(/支払いの再送の応答が転送 \(HTTP 302\)/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(RESOURCE);
      expect(init).toMatchObject({ redirect: 'manual' });
    }
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>)['X-PAYMENT']).toBeTruthy();
  });
});

describe('E12: standalone public onboarding', () => {
  it('runs the downloaded JPYC example offline with only its documented npm packages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openpay-buyer-offline-'));
    try {
      mkdirSync(join(dir, 'node_modules'));
      // Copy the package's publishable source, so package exports (not repo-relative imports) are exercised.
      const sdk = join(dir, 'node_modules/openpay-x402-sdk');
      mkdirSync(sdk);
      for (const file of ['package.json', 'src']) cpSync(resolve('packages/x402-sdk', file), join(sdk, file), { recursive: true });
      symlinkSync(resolve('node_modules/viem'), join(dir, 'node_modules/viem'), 'dir');
      cpSync(resolve('scripts/x402-buyer-example.mjs'), join(dir, 'buyer.mjs'));
      const challenge = accept();
      const forwarder = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
      challenge.payTo = forwarder;
      const extra = challenge.extra as { openpay: { forwarder: string } };
      extra.openpay.forwarder = forwarder;
      writeFileSync(join(dir, 'challenge.json'), JSON.stringify(challenge));
      writeFileSync(join(dir, 'run.mjs'), `
        import assert from 'node:assert/strict';
        import { readFileSync } from 'node:fs';
        import { verifyTypedData } from 'viem';
        import { main, buildTypedDataFromPaymentRequirements } from './buyer.mjs';
        // An undeclared package installed in the repo must be invisible to the downloaded script.
        assert.throws(() => import.meta.resolve('next'), { code: 'ERR_MODULE_NOT_FOUND' });
        const challenge = JSON.parse(readFileSync('challenge.json', 'utf8'));
        let calls = 0;
        globalThis.fetch = async (url, init) => {
          assert.equal(url, 'https://open-pay.jp/api/paid/stores');
          // 402 の取得も支払いの再送も転送を追わない
          assert.equal(init.redirect, 'manual');
          if (++calls === 1) return Response.json({ accepts: [challenge] }, { status: 402 });
          assert.equal(calls, 2);
          const payment = JSON.parse(Buffer.from(init.headers['X-PAYMENT'], 'base64').toString());
          const { authorization, signature } = payment.payload;
          const { typedData } = buildTypedDataFromPaymentRequirements(challenge, authorization);
          assert.equal(await verifyTypedData({ ...typedData, signature, address: authorization.from }), true);
          return Response.json({ offline: true });
        };
        await main();
        assert.equal(calls, 2);
      `);
      const run = spawnSync(process.execPath, ['run.mjs'], {
        cwd: dir, encoding: 'utf8', timeout: 20_000,
        // Public fixture key only; do not inherit wallet/keystore or signer environment settings.
        env: { NODE_ENV: 'test', BUYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`, MAX_JPYC: '7', RESOURCE_URL: 'https://open-pay.jp/api/paid/stores' },
      });
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('"offline": true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('documents npm setup before downloading JPYC and explicitly opts in to the USDC smoke', () => {
    for (const file of ['docs/API.md', 'docs/agent-templates/jpyc-service-monitor.md', 'components/x402/DiscoveryExamples.tsx']) {
      const text = readFileSync(resolve(file), 'utf8');
      expect(text, file).toContain('npm install openpay-x402-sdk viem');
    }
    const template = readFileSync(resolve('docs/agent-templates/jpyc-service-monitor.md'), 'utf8');
    expect(template).toContain('SMOKE_MAINNET_OK=1 PRIVATE_KEY=0x... MAX_USDC=0.02');
  });
});
