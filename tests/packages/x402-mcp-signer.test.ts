import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type Signer = {
  mode: string;
  address: Address;
  signTypedData: (typedData: typeof TYPED_DATA) => Promise<Hex>;
};

type SignerModule = {
  createSigner: (
    env: Record<string, string | undefined>,
    options?: { fetchImpl?: typeof fetch },
  ) => Signer;
};

type ToolRuntime = {
  x402Pay: (args: unknown) => Promise<unknown>;
};

type ToolsModule = {
  createToolRuntime: (options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    nowSec?: () => number;
  }) => ToolRuntime;
};

type GuardsModule = {
  safeErrorMessage: (
    error: unknown,
    config?: {
      buyerPrivateKey?: string | null;
      stewardApiKey?: string | null;
      stewardSignerSecret?: string | null;
    },
  ) => string;
};

const JPYC = 10n ** 18n;
const RESOURCE = 'https://open-pay.jp/api/paid/demo';
const STEWARD_URL = 'https://steward.test';
const STEWARD_API_KEY = 'steward_api_key_secret';
const STEWARD_SIGNER_SECRET = 'steward_signer_secret';
const BUYER_PRIVATE_KEY = `0x${'1'.repeat(64)}` as Hex;
const WRONG_PRIVATE_KEY = `0x${'2'.repeat(64)}` as Hex;
const TOKEN = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FORWARDER = getAddress('0x4444444444444444444444444444444444444444');
const MERCHANT = getAddress('0x2222222222222222222222222222222222222222');
const FEE_RECEIVER = getAddress('0x3333333333333333333333333333333333333333');
const FROM = getAddress('0x1111111111111111111111111111111111111111');
const NONCE =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hex;
const COMMIT_VERSION =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;

const stewardAccount = privateKeyToAccount(BUYER_PRIVATE_KEY);
const wrongAccount = privateKeyToAccount(WRONG_PRIVATE_KEY);

const TYPED_DATA = {
  domain: {
    name: 'JPY Coin',
    version: '1',
    chainId: 80002,
    verifyingContract: TOKEN,
  },
  types: {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'ReceiveWithAuthorization',
  message: {
    from: FROM,
    to: FORWARDER,
    value: 7n * JPYC,
    validAfter: 0n,
    validBefore: 1_000_000_600n,
    nonce: NONCE,
  },
} as const;

async function loadSigner(): Promise<SignerModule> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'packages/x402-mcp/src/signer.mjs')).href
  )) as SignerModule;
}

async function loadTools(): Promise<ToolsModule> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'packages/x402-mcp/src/tools.mjs')).href
  )) as ToolsModule;
}

async function loadGuards(): Promise<GuardsModule> {
  return (await import(
    pathToFileURL(resolve(process.cwd(), 'packages/x402-mcp/src/guards.mjs')).href
  )) as GuardsModule;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stewardEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SIGNER_MODE: 'steward',
    STEWARD_URL,
    STEWARD_TENANT: 'tenant-a',
    STEWARD_API_KEY,
    STEWARD_AGENT_ID: 'agent-1',
    STEWARD_AGENT_ADDRESS: stewardAccount.address,
    STEWARD_SIGNER_ID: 'signer-1',
    STEWARD_SIGNER_SECRET,
    ALLOWED_HOSTS: 'open-pay.jp',
    MAX_PER_CALL_JPYC: '10',
    MAX_SESSION_JPYC: '100',
    ...overrides,
  };
}

function accept() {
  const merchantValue = 5n * JPYC;
  const feeValue = 2n * JPYC;
  return {
    scheme: 'exact',
    network: 'eip155:80002',
    maxAmountRequired: (merchantValue + feeValue).toString(),
    resource: RESOURCE,
    description: 'demo',
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
        merchantValue: merchantValue.toString(),
        feeReceiver: FEE_RECEIVER,
        feeValue: feeValue.toString(),
        commitVersion: COMMIT_VERSION,
      },
    },
  };
}

function requestUrl(input: RequestInfo | URL) {
  return typeof input === 'string' ? input : input.toString();
}

function typedDataFromStewardBody(body: {
  domain: typeof TYPED_DATA.domain;
  types: typeof TYPED_DATA.types;
  primaryType: typeof TYPED_DATA.primaryType;
  value: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}) {
  return {
    domain: body.domain,
    types: body.types,
    primaryType: body.primaryType,
    message: {
      from: body.value.from,
      to: body.value.to,
      value: BigInt(body.value.value),
      validAfter: BigInt(body.value.validAfter),
      validBefore: BigInt(body.value.validBefore),
      nonce: body.value.nonce,
    },
  };
}

describe('packages/x402-mcp steward signer', () => {
  it('defaults to env-key mode and validates signer mode env', async () => {
    const { createSigner } = await loadSigner();

    const signer = createSigner({ BUYER_PRIVATE_KEY });
    expect(signer.mode).toBe('env-key');
    expect(getAddress(signer.address)).toBe(stewardAccount.address);
    expect(() =>
      createSigner({ BUYER_PRIVATE_KEY, SIGNER_MODE: 'unknown' }),
    ).toThrow(/SIGNER_MODE/);
    expect(() => createSigner({ SIGNER_MODE: 'steward' })).toThrow(/STEWARD_URL/);
  });

  it('builds the steward typed-data signing request and self-verifies the first signature', async () => {
    const { createSigner } = await loadSigner();
    const signature = await stewardAccount.signTypedData(TYPED_DATA);
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, data: { signature } }),
    );

    const signer = createSigner(stewardEnv(), { fetchImpl });
    await expect(signer.signTypedData(TYPED_DATA)).resolves.toBe(signature);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${STEWARD_URL}/vault/agent-1/sign-typed-data`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'X-Steward-Key': STEWARD_API_KEY,
      'X-Steward-Tenant': 'tenant-a',
      'x-steward-signer-id': 'signer-1',
      'x-steward-signer-secret': STEWARD_SIGNER_SECRET,
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      domain: TYPED_DATA.domain,
      types: TYPED_DATA.types,
      primaryType: TYPED_DATA.primaryType,
      value: {
        from: TYPED_DATA.message.from,
        to: TYPED_DATA.message.to,
        value: TYPED_DATA.message.value.toString(),
        validAfter: TYPED_DATA.message.validAfter.toString(),
        validBefore: TYPED_DATA.message.validBefore.toString(),
        nonce: TYPED_DATA.message.nonce,
      },
    });
  });

  it('throws when the steward response is not an ok signature envelope', async () => {
    const { createSigner } = await loadSigner();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: false, error: 'policy denied' }, 403),
    );
    const signer = createSigner(stewardEnv(), { fetchImpl });

    await expect(signer.signTypedData(TYPED_DATA)).rejects.toThrow(
      /steward sign-typed-data failed \(403\)/,
    );
  });

  it('fails closed on self-verification mismatch and does not retry the paid resource', async () => {
    const { createToolRuntime } = await loadTools();
    let resourceFetches = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === RESOURCE) {
        resourceFetches += 1;
        return jsonResponse({ accepts: [accept()] }, 402);
      }
      if (url === `${STEWARD_URL}/vault/agent-1/sign-typed-data`) {
        const body = JSON.parse(init?.body as string);
        const signature = await wrongAccount.signTypedData(
          typedDataFromStewardBody(body),
        );
        return jsonResponse({ ok: true, data: { signature } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const runtime = createToolRuntime({
      env: stewardEnv(),
      fetchImpl,
      nowSec: () => 1_000_000_000,
    });

    await expect(
      runtime.x402Pay({ url: RESOURCE, maxTotalJpyc: '7' }),
    ).rejects.toThrow(/self-verification failed/);
    expect(resourceFetches).toBe(1);
  });

  it('redacts steward API key and signer secret in safe error messages', async () => {
    const guards = await loadGuards();
    const message = guards.safeErrorMessage(
      new Error(
        `failed with ${BUYER_PRIVATE_KEY}, ${STEWARD_API_KEY}, and ${STEWARD_SIGNER_SECRET}`,
      ),
      {
        buyerPrivateKey: BUYER_PRIVATE_KEY,
        stewardApiKey: STEWARD_API_KEY,
        stewardSignerSecret: STEWARD_SIGNER_SECRET,
      },
    );

    expect(message).not.toContain(BUYER_PRIVATE_KEY);
    expect(message).not.toContain(STEWARD_API_KEY);
    expect(message).not.toContain(STEWARD_SIGNER_SECRET);
    expect(message).toContain('[redacted_private_key]');
  });

  it('並行 x402_pay を直列化し session 累計上限の超過を防ぐ (P1-G TOCTOU)', async () => {
    const { createToolRuntime } = await loadTools();
    // accept() は 5+2=7 JPYC。MAX_SESSION=10 ゆえ 2 本 (14) は上限超過。直列化が無いと両方が
    // 更新前の spent(0) を見て両方成立し 14 JPYC 払ってしまう (TOCTOU)。直列化で 1 本のみ成功。
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url !== RESOURCE) throw new Error(`unexpected fetch: ${url}`);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if ('X-PAYMENT' in headers) return jsonResponse({ ok: true }, 200);
        return jsonResponse({ accepts: [accept()] }, 402);
      },
    );
    const runtime = createToolRuntime({
      env: {
        BUYER_PRIVATE_KEY,
        ALLOWED_HOSTS: 'open-pay.jp',
        MAX_PER_CALL_JPYC: '10',
        MAX_SESSION_JPYC: '10',
      },
      fetchImpl,
      nowSec: () => 1_000_000_000,
    });

    const results = (await Promise.all([
      runtime.x402Pay({ url: RESOURCE, maxTotalJpyc: '7' }),
      runtime.x402Pay({ url: RESOURCE, maxTotalJpyc: '7' }),
    ])) as Array<Record<string, unknown>>;

    // 成功は { status:200, body, receipt } (reasons 無し)、guard 拒否は { ok:false, reasons }。
    const succeeded = results.filter((r) => r.status === 200 && !('reasons' in r));
    const rejected = results.find((r) => Array.isArray(r.reasons));
    expect(succeeded).toHaveLength(1); // 直列化が無ければ 2 本とも成功してしまう
    expect(rejected?.reasons).toContain('session_limit_exceeded');
  });
});
