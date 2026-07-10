// CSV パス購入 relay route (/api/csv-pass/relay) の gate / 検証 / auth 構成 / 応答整形 / guards 配線を
// 検証する。relay コア (relayFreeAuthorization = 別途 jpycRelay.test / relayProvider が担保) はモックし、
// route 固有のロジック (flag/feeReceiver/PROVIDER/auth/from束縛/value下限/to無視/応答) を実走させる。
// 決済ログ・billing メーターを **書かない** ことも確認する (購入は GMV ではない)。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const FEE_RECEIVER = '0x4284e651C3D8c9A439FedE00d2600032d5DB0Be7';
// 全小文字 (viem isAddress の checksum 検証を避ける・session も同値を返す)。
const WALLET = '0x000000000000000000000000000000000000abcd';
const POLYGON = 137;

// relay コア + PROVIDER をモック (デフォルト: self-host 構成・success を返す)。
// 戻り値は RelayResult 風の union (route の respond が分岐するすべての kind を返せるよう緩く型付け)。
type MockRelayResult = {
  kind: string;
  txHash?: `0x${string}`;
  httpStatus?: number;
  reason?: string;
  detail?: string;
};
// 実シグネチャ (chainId, auth, signature, rateLimitKeys, opts) と同 arity で宣言し mock.calls の
// タプル長を確保する (引数の検証で auth.to / opts.idemPrefix を取り出すため)。
const relayFreeAuthorization = vi.hoisted(() =>
  vi.fn(
    async (
      _chainId: number,
      _auth: { from: string; to: string },
      _signature: string,
      _rateLimitKeys: string[],
      _opts: { idemPrefix: string },
    ): Promise<MockRelayResult> => ({ kind: 'success', txHash: '0xfeed' }),
  ),
);
const providerHold = vi.hoisted(() => ({
  value: 'self-host' as string | null,
  // mainnet self-host preflight (決済 relay と同一・Codex P1) 用。既定 = 本番同等
  // (Polygon/Kaia=mainnet・gas ceiling 設定済・KV 構成済) で既存テストは preflight を通過する。
  mainnetChains: new Set<number>([137, 8217]),
  gasCeilWei: 1n as bigint, // 0n = 未設定 (mainnet では 503 gas_ceiling_required)
  kvConfigured: true,
}));
vi.mock('@/lib/relay/relayProvider', () => ({
  get PROVIDER() {
    return providerHold.value;
  },
  get MAINNET_CHAINS() {
    return providerHold.mainnetChains;
  },
  get RELAY_MAX_GAS_COST_WEI() {
    return providerHold.gasCeilWei;
  },
  // route は per-chain relayMaxGasCostWei(chainId) を呼ぶ。テストは chain 非依存に
  // providerHold.gasCeilWei を返す (上限の有無/値はテストが gasCeilWei で制御)。
  relayMaxGasCostWei: () => providerHold.gasCeilWei,
  relayFreeAuthorization,
}));
// route は isKvConfigured のみ参照 (csvPass 経由の kvGet 等は import されるだけで呼ばれない)。
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => providerHold.kvConfigured,
}));

// requireSession をモック (デフォルト: WALLET でサインイン済)。
const sessionHold = vi.hoisted(() => ({ signedIn: true }));
vi.mock('../../../app/api/auth/siwe/_session', () => ({
  requireSession: vi.fn(async () => {
    if (!sessionHold.signedIn) {
      const { NextResponse } = await import('next/server');
      return {
        ok: false,
        response: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }),
      };
    }
    return { ok: true, address: WALLET };
  }),
}));

// env: flag / feeReceiver をモック (各テストで上書き)。
const envHold = vi.hoisted(() => ({
  enableCsvPass: true,
  feeReceiverConfigured: true,
  feeReceiver: '0x4284e651C3D8c9A439FedE00d2600032d5DB0Be7',
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableCsvPass() {
        return envHold.enableCsvPass;
      },
      get feeReceiverConfigured() {
        return envHold.feeReceiverConfigured;
      },
      get feeReceiver() {
        return envHold.feeReceiver;
      },
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// 決済ログ / billing メーターを書かないことを確認するための spy 対象。
import { recordRelayedVolume } from '@/lib/billingMeter';
vi.mock('@/lib/billingMeter', () => ({ recordRelayedVolume: vi.fn() }));

import { POST } from '@/app/api/csv-pass/relay/route';
import { csvPassPriceWei } from '@/lib/csvPass';

function req(body: unknown): Request {
  return new Request('http://localhost/api/csv-pass/relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = (over: Record<string, unknown> = {}) => ({
  chainId: POLYGON,
  from: WALLET,
  value: csvPassPriceWei.toString(),
  validAfter: '0',
  validBefore: String(Math.floor(Date.now() / 1000) + 200),
  nonce: '0x' + 'a'.repeat(64),
  signature: '0x' + 'b'.repeat(130),
  ...over,
});

beforeEach(() => {
  relayFreeAuthorization.mockClear();
  relayFreeAuthorization.mockResolvedValue({ kind: 'success', txHash: '0xfeed' });
  vi.mocked(recordRelayedVolume).mockClear();
  providerHold.value = 'self-host';
  providerHold.mainnetChains = new Set<number>([137, 8217]);
  providerHold.gasCeilWei = 1n;
  providerHold.kvConfigured = true;
  sessionHold.signedIn = true;
  envHold.enableCsvPass = true;
  envHold.feeReceiverConfigured = true;
  envHold.feeReceiver = FEE_RECEIVER;
});

describe('POST /api/csv-pass/relay — mainnet self-host preflight (Codex P1)', () => {
  it('mainnet + gas ceiling 未設定 (0n) → 503 gas_ceiling_required・relay へ進まない', async () => {
    providerHold.gasCeilWei = 0n;
    const res = await POST(req(validBody({ chainId: 137 })));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'gas_ceiling_required' });
    expect(relayFreeAuthorization).not.toHaveBeenCalled();
  });

  it('mainnet + KV 未構成 → 503 kv_required (idempotency/予算の fail-open を塞ぐ)', async () => {
    providerHold.kvConfigured = false;
    const res = await POST(req(validBody({ chainId: 137 })));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_required' });
    expect(relayFreeAuthorization).not.toHaveBeenCalled();
  });

  // CSV パス購入は free モード専用。recover-required chain (Avalanche/Fuji) は free 禁止 (AVAX 持ち出し)
  // なので chainId パース直後に 400 unsupported_chain で拒否する (実 isRecoverRequiredChain 経由・flag 非依存)。
  it.each([
    ['Avalanche mainnet', 43114],
    ['Fuji testnet', 43113],
  ])('recover-required chain (%s=%d) → 400 unsupported_chain・relay へ進まない', async (_label, chainId) => {
    const res = await POST(req(validBody({ chainId })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'unsupported_chain' });
    expect(relayFreeAuthorization).not.toHaveBeenCalled();
  });

  it('testnet (Amoy 80002) は preflight 対象外 — gas ceiling 0n でも中継する', async () => {
    providerHold.gasCeilWei = 0n;
    providerHold.kvConfigured = false;
    const res = await POST(req(validBody({ chainId: 80002 })));
    expect(res.status).toBe(200);
    expect(relayFreeAuthorization).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/csv-pass/relay — gate 順序', () => {
  it('flag off → 404 csvpass_disabled (認証より前)', async () => {
    envHold.enableCsvPass = false;
    const res = await POST(req(validBody()));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'csvpass_disabled' });
    expect(relayFreeAuthorization).not.toHaveBeenCalled();
  });

  it('feeReceiver 未設定 → 503 csvpass_misconfigured', async () => {
    envHold.feeReceiverConfigured = false;
    const res = await POST(req(validBody()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'csvpass_misconfigured' });
  });

  it('PROVIDER null → 503 relay_not_configured (client は fallback 導線へ)', async () => {
    providerHold.value = null;
    const res = await POST(req(validBody()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_not_configured' });
  });

  it('未サインイン → 401', async () => {
    sessionHold.signedIn = false;
    const res = await POST(req(validBody()));
    expect(res.status).toBe(401);
    expect(relayFreeAuthorization).not.toHaveBeenCalled();
  });
});

describe('POST /api/csv-pass/relay — route 固有検証', () => {
  it('from ≠ session.address → 403 from_mismatch', async () => {
    const res = await POST(
      req(validBody({ from: '0x000000000000000000000000000000000000ffff' })),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'from_mismatch' });
    expect(relayFreeAuthorization).not.toHaveBeenCalled();
  });

  it('value < 100 JPYC → 400 insufficient_value', async () => {
    const res = await POST(
      req(validBody({ value: (csvPassPriceWei - 1n).toString() })),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'insufficient_value' });
  });

  it('value > パス価格の 10 倍 → 400 value_too_large', async () => {
    const res = await POST(
      req(validBody({ value: (csvPassPriceWei * 10n + 1n).toString() })),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'value_too_large' });
    expect(relayFreeAuthorization).not.toHaveBeenCalled();
  });

  it('body の `to` フィールドは無視され server が FEE_RECEIVER で auth を構成する', async () => {
    // 悪意ある to を含めても relayFreeAuthorization には to=FEE_RECEIVER の auth が渡る。
    const res = await POST(
      req(validBody({ to: '0x000000000000000000000000000000000000dEaD' })),
    );
    expect(res.status).toBe(200);
    expect(relayFreeAuthorization).toHaveBeenCalledTimes(1);
    const [, auth] = relayFreeAuthorization.mock.calls[0];
    expect(auth.to.toLowerCase()).toBe(FEE_RECEIVER.toLowerCase());
    expect(auth.from.toLowerCase()).toBe(WALLET.toLowerCase());
  });

  it('invalid payload (nonce 形式不正) → 400 invalid_payload', async () => {
    const res = await POST(req(validBody({ nonce: '0xnotanonce' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_payload' });
  });
});

describe('POST /api/csv-pass/relay — relay 結果の応答整形 + guards 配線', () => {
  it('success → 200 {ok,txHash} + csvpassrelay:idem prefix で relay を呼ぶ (idem 名前空間分離)', async () => {
    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, txHash: '0xfeed' });
    // guards (rate-limit/budget/idem) は relayFreeAuthorization 内で配線される。route は専用 idem
    // prefix を渡す (決済 relay と名前空間を分ける)。rate-limit/budget は relayGuards 内で共有キー。
    const [, , , rateLimitKeys, opts] = relayFreeAuthorization.mock.calls[0];
    expect(opts.idemPrefix).toBe('csvpassrelay:idem:');
    // post-verify 5/分は wallet-only。NAT 共有 /24 で別 wallet を巻き込まない。
    // key は checksum 表記 (getAddress(auth.from)) だが同一 wallet で決定的なので bucket は一意。
    expect(rateLimitKeys.map((k: string) => k.toLowerCase())).toEqual([WALLET]);
  });

  it('reverted → 200 {reverted,txHash} passthrough', async () => {
    relayFreeAuthorization.mockResolvedValue({ kind: 'reverted', txHash: '0xrev' });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reverted: true, txHash: '0xrev' });
  });

  it('pending → 202 {pending,txHash}', async () => {
    relayFreeAuthorization.mockResolvedValue({ kind: 'pending', txHash: '0xpend' });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: false, pending: true, txHash: '0xpend' });
  });

  it('rejected (signature_mismatch) → reject の httpStatus で透過', async () => {
    relayFreeAuthorization.mockResolvedValue({
      kind: 'rejected',
      httpStatus: 400,
      reason: 'signature_mismatch',
    });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'signature_mismatch' });
  });

  it('relay_error → 502 relay_error', async () => {
    relayFreeAuthorization.mockResolvedValue({
      kind: 'relay_error',
      detail: 'submit_failed',
    });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'relay_error' });
  });

  it('成功しても billing メーター (recordRelayedVolume) には記録しない (購入は GMV でない)', async () => {
    await POST(req(validBody()));
    expect(recordRelayedVolume).not.toHaveBeenCalled();
  });
});
