// x402 facilitator /settle の **mainnet 限定 hardening** を検証する。
// gas-cost ceiling 必須 + KV 必須は MAINNET_CHAINS でのみ発火し (testnet=Amoy では skip されるため
// facilitator.test.ts では到達不能)、NETWORK_ENV=mainnet + Polygon(137) の body で settleViaForwarder
// 到達前の枝を撃つ。署名検証や on-chain は枝の手前なので不要 (ダミー署名で良い)。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { getAddress } from 'viem';

const JPY = 10n ** 18n;
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE_RECEIVER = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const MERCHANT = getAddress('0x1234567890123456789012345678901234567890');
const CUSTOMER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const JPYC_POLY = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// hardening 枝は createPublicClient を使う前に return するが、誤って実 RPC を叩かないよう最小 stub。
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({}) };
});

// Polygon(137) 宛の構造的に正当な settle ボディ (署名はダミー: 枝はその手前)。
function body137(): Record<string, unknown> {
  return {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:137',
      payload: {
        signature: `0x${'11'.repeat(65)}`,
        authorization: {
          from: CUSTOMER,
          validAfter: '0',
          validBefore: '99999999999',
          intentSalt: `0x${'22'.repeat(32)}`,
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: 'eip155:137',
      maxAmountRequired: (1010n * JPY).toString(),
      resource: 'https://api.example.jp/paid/x',
      description: 't',
      mimeType: '',
      payTo: FORWARDER,
      maxTimeoutSeconds: 600,
      asset: JPYC_POLY,
      extra: {
        openpay: {
          merchant: MERCHANT,
          merchantValue: (1000n * JPY).toString(),
          feeReceiver: FEE_RECEIVER,
          feeValue: (10n * JPY).toString(),
        },
      },
    },
  };
}

function settleReq(): Request {
  return new Request('http://x/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body137()),
  });
}

async function loadSettle(opts: {
  gasCeilingWei: string;
  kv: boolean;
}): Promise<(req: Request) => Promise<Response>> {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_X402_FACILITATOR', '1');
  // mainnet は env.ts が以下を必須にする (未設定だと import 時に throw)。
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_API_KEY', 'dummy');
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID', 'sp_dummy');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://dummy@o0.ingest.sentry.io/0');
  // self-host relayer (PROVIDER=self-host) + Polygon forwarder。
  vi.stubEnv('RELAYER_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
  vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', FORWARDER);
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  // gas ceiling (空 = 0 = gas_ceiling_required) は module-load const なので import 前に stub。
  vi.stubEnv('RELAY_MAX_GAS_COST_WEI', opts.gasCeilingWei);
  // KV (未設定 = isKvConfigured false = kv_required)。
  vi.stubEnv('KV_REST_API_URL', opts.kv ? 'https://kv.example' : '');
  vi.stubEnv('KV_REST_API_TOKEN', opts.kv ? 'tok' : '');
  vi.resetModules();
  const mod = await import('@/app/api/facilitator/settle/route');
  return mod.POST as (req: Request) => Promise<Response>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('x402 facilitator /settle mainnet hardening', () => {
  it('gas-cost ceiling 未設定 → 503 gas_ceiling_required (赤字 submit を防ぐ)', async () => {
    const settle = await loadSettle({ gasCeilingWei: '', kv: true });
    const res = await settle(settleReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'gas_ceiling_required',
    });
  });

  it('gas ceiling あり + KV 未設定 → 503 kv_required (冪等 fail-open での二重 submit を防ぐ)', async () => {
    // gas ceiling を非ゼロにして gas チェックを通し、KV チェックで弾かれることを確認。
    const settle = await loadSettle({ gasCeilingWei: (10n ** 18n).toString(), kv: false });
    const res = await settle(settleReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      errorReason: 'kv_required',
    });
  });
});
