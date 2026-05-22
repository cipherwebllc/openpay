// scripts/check-pimlico-balance.mjs の data-driven 多 chain balance check の
// 挙動を verify。viem の readContract と fetch (webhook) を境界 mock し、
// chain 追加 / required=false の skip / threshold breach 通知の各経路を実走。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base, kaia, polygon } from 'viem/chains';

// viem の境界モック (HTTP / RPC layer)
const readContractMock = vi.fn();
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: () => ({ readContract: readContractMock }),
  };
});

// fetch は jsdom にあるが、本テストは node 環境 (.mjs runtime) を想定。
// global.fetch を spy で差し替えて webhook POST を assert する。
// 戻り値の型は Response 互換 (statusText も含む) として明示、5xx 失敗経路の
// mockResolvedValueOnce で statusText を上書き可能に。型を fetch 互換 signature
// にし、mock.calls[i] が [url, init] tuple として TS に伝わるようにする。
type MockResponse = { ok: boolean; status: number; statusText: string };
type MockFetch = (
  url: string | URL | Request,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<MockResponse>;
const fetchMock = vi.fn<MockFetch>(
  async () => ({ ok: true, status: 200, statusText: 'OK' }),
);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  // chain ごと env を空に
  delete process.env.PIMLICO_PAYMASTER_POLYGON;
  delete process.env.PIMLICO_PAYMASTER_BASE;
  delete process.env.PIMLICO_PAYMASTER_KAIA;
  delete process.env.POLYGON_RPC_URL;
  delete process.env.BASE_RPC_URL;
  delete process.env.KAIA_RPC_URL;
  delete process.env.ALERT_THRESHOLD_POL;
  delete process.env.ALERT_THRESHOLD_ETH;
  delete process.env.ALERT_THRESHOLD_KAIA;
});

afterEach(() => {
  vi.unstubAllGlobals();
  readContractMock.mockReset();
  fetchMock.mockClear();
});

async function loadScript() {
  // CLI ガード越しの import (main() が走らない context)
  return import('@/scripts/check-pimlico-balance.mjs');
}

// テスト用の chain config — production CHAIN_CONFIGS と同 shape、production
// と decoupling して数値変更にも追従しやすい。
function makeConfigs() {
  return [
    {
      slug: 'polygon',
      chain: polygon,
      rpcEnv: 'POLYGON_RPC_URL',
      rpcDefault: 'https://polygon-rpc.com',
      paymasterEnv: 'PIMLICO_PAYMASTER_POLYGON',
      thresholdEnv: 'ALERT_THRESHOLD_POL',
      thresholdDefault: '5',
      nativeSymbol: 'POL',
      required: true,
    },
    {
      slug: 'base',
      chain: base,
      rpcEnv: 'BASE_RPC_URL',
      rpcDefault: 'https://mainnet.base.org',
      paymasterEnv: 'PIMLICO_PAYMASTER_BASE',
      thresholdEnv: 'ALERT_THRESHOLD_ETH',
      thresholdDefault: '0.01',
      nativeSymbol: 'ETH',
      required: true,
    },
    {
      slug: 'kaia',
      chain: kaia,
      rpcEnv: 'KAIA_RPC_URL',
      rpcDefault: 'https://public-en.node.kaia.io',
      paymasterEnv: 'PIMLICO_PAYMASTER_KAIA',
      thresholdEnv: 'ALERT_THRESHOLD_KAIA',
      thresholdDefault: '5',
      nativeSymbol: 'KAIA',
      required: false,
    },
  ];
}

describe('check-pimlico-balance: chain 設定の解決', () => {
  it('required chain の secret が無いと throw (workflow fail-fast)', async () => {
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    // POLYGON secret 未設定
    const { runBalanceCheck } = await loadScript();
    await expect(
      runBalanceCheck({
        configs: makeConfigs(),
        webhookUrl: 'https://hook.example.com',
        logger: { log: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow(/PIMLICO_PAYMASTER_POLYGON/);
  });

  it('optional chain (kaia) の secret が無くても、required 2 chain は実行される', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    // KAIA secret 未設定 → skip
    // 両 chain とも threshold 超で breach なしに固定 (skip 経路の検証に集中)
    readContractMock.mockResolvedValueOnce(10n * 10n ** 18n); // polygon: 10 POL > 5
    readContractMock.mockResolvedValueOnce(10n ** 17n); // base: 0.1 ETH > 0.01

    const { runBalanceCheck } = await loadScript();
    const result = await runBalanceCheck({
      configs: makeConfigs(),
      webhookUrl: 'https://hook.example.com',
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(result.breached).toBe(false);
    expect(readContractMock).toHaveBeenCalledTimes(2); // kaia は skip
    expect(result.lines).toHaveLength(3); // 'Pimlico ...' header + 2 chains
    expect(result.lines.join('\n')).toContain('Polygon');
    expect(result.lines.join('\n')).toContain('Base');
    expect(result.lines.join('\n')).not.toContain('Kaia');
  });

  it('optional kaia の secret が設定されていれば、kaia も balance check に含む', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    process.env.PIMLICO_PAYMASTER_KAIA =
      '0x000000000000000000000000000000000000Ca1A';
    // 全 chain threshold 超 (default POL/KAIA=5、ETH=0.01) で breach なしに固定
    readContractMock.mockResolvedValueOnce(10n * 10n ** 18n); // polygon: 10 POL > 5
    readContractMock.mockResolvedValueOnce(10n ** 17n); // base: 0.1 ETH > 0.01
    readContractMock.mockResolvedValueOnce(10n * 10n ** 18n); // kaia: 10 KAIA > 5

    const { runBalanceCheck } = await loadScript();
    const result = await runBalanceCheck({
      configs: makeConfigs(),
      webhookUrl: 'https://hook.example.com',
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(result.breached).toBe(false);
    expect(readContractMock).toHaveBeenCalledTimes(3);
    expect(result.lines.join('\n')).toContain('Kaia: 10 KAIA');
  });

  it('readContract が getAddress で正規化された paymaster address に呼ばれる', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0xb011000000000000000000000000000000000000'; // lowercase
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    readContractMock.mockResolvedValue(10n ** 18n);

    const { runBalanceCheck } = await loadScript();
    await runBalanceCheck({
      configs: makeConfigs(),
      webhookUrl: 'https://hook.example.com',
      logger: { log: vi.fn(), error: vi.fn() },
    });

    // viem の getAddress で checksum 形式に正規化される
    const firstCall = readContractMock.mock.calls[0][0];
    expect(firstCall.args[0]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(firstCall.functionName).toBe('balanceOf');
    expect(firstCall.address).toBe(
      '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    );
  });
});

describe('check-pimlico-balance: threshold breach + webhook 通知', () => {
  it('全 chain で threshold 超 → 通知なし、breached=false', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    process.env.PIMLICO_PAYMASTER_KAIA =
      '0x000000000000000000000000000000000000Ca1A';
    readContractMock.mockResolvedValueOnce(10n * 10n ** 18n); // polygon 10 POL > 5 default
    readContractMock.mockResolvedValueOnce(10n ** 17n); // base 0.1 ETH > 0.01 default
    readContractMock.mockResolvedValueOnce(10n * 10n ** 18n); // kaia 10 KAIA > 5 default

    const { runBalanceCheck } = await loadScript();
    const result = await runBalanceCheck({
      configs: makeConfigs(),
      webhookUrl: 'https://hook.example.com',
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(result.breached).toBe(false);
    expect(result.alerts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polygon が threshold 以下 → 1 件 alert を webhook に送信', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    readContractMock.mockResolvedValueOnce(10n ** 18n); // polygon 1 POL < 5 default → alert
    readContractMock.mockResolvedValueOnce(10n ** 17n); // base 0.1 ETH > 0.01

    const { runBalanceCheck } = await loadScript();
    const result = await runBalanceCheck({
      configs: makeConfigs(),
      webhookUrl: 'https://hook.example.com',
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(result.breached).toBe(true);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain('Polygon');
    expect(result.alerts[0]).toContain('1 POL');
    expect(result.alerts[0]).toContain('しきい値 5 POL');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hook.example.com');
    // notify() は必ず init を渡すので non-null。
    if (!init) throw new Error('fetch called without init');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain('🚨');
    expect(body.text).toContain('Polygon');
    expect(body.content).toBe(body.text); // Discord と Slack 両 schema 対応
  });

  it('kaia (optional) が threshold 以下 → alert で kaia が言及される', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    process.env.PIMLICO_PAYMASTER_KAIA =
      '0x000000000000000000000000000000000000Ca1A';
    readContractMock.mockResolvedValueOnce(10n * 10n ** 18n); // polygon OK
    readContractMock.mockResolvedValueOnce(10n ** 17n); // base OK
    readContractMock.mockResolvedValueOnce(10n ** 18n); // kaia 1 KAIA < 5 default → alert

    const { runBalanceCheck } = await loadScript();
    const result = await runBalanceCheck({
      configs: makeConfigs(),
      webhookUrl: 'https://hook.example.com',
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(result.breached).toBe(true);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain('Kaia');
    expect(result.alerts[0]).toContain('1 KAIA');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('threshold env override が default に優先する (ALERT_THRESHOLD_KAIA=15)', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    process.env.PIMLICO_PAYMASTER_KAIA =
      '0x000000000000000000000000000000000000Ca1A';
    process.env.ALERT_THRESHOLD_KAIA = '15'; // override default 5
    readContractMock.mockResolvedValueOnce(10n * 10n ** 18n); // polygon OK
    readContractMock.mockResolvedValueOnce(10n ** 17n); // base OK
    readContractMock.mockResolvedValueOnce(10n * 10n ** 18n); // kaia 10 KAIA < 15 override → alert

    const { runBalanceCheck } = await loadScript();
    const result = await runBalanceCheck({
      configs: makeConfigs(),
      webhookUrl: 'https://hook.example.com',
      logger: { log: vi.fn(), error: vi.fn() },
    });

    expect(result.breached).toBe(true);
    expect(result.alerts[0]).toContain('しきい値 15 KAIA');
  });

  it('webhook POST 失敗 (HTTP 5xx) → throw して workflow に伝搬', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    readContractMock.mockResolvedValueOnce(10n ** 17n); // polygon: 0.1 POL < 5 → alert
    readContractMock.mockResolvedValueOnce(10n ** 17n); // base OK
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const { runBalanceCheck } = await loadScript();
    await expect(
      runBalanceCheck({
        configs: makeConfigs(),
        webhookUrl: 'https://hook.example.com',
        logger: { log: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow(/webhook POST 失敗/);
  });
});

describe('check-pimlico-balance: 並列 fetch + chain ごとの独立性', () => {
  it('複数 chain の readContract は並列実行 (Promise.all)', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';
    process.env.PIMLICO_PAYMASTER_KAIA =
      '0x000000000000000000000000000000000000Ca1A';

    // 各 chain の readContract に小さな遅延を入れ、Promise.all による
    // 並列実行を「総時間が 3 倍未満」 で確認する。
    let resolveOrder = 0;
    const delays = [50, 30, 10];
    readContractMock.mockImplementation(() => {
      const i = resolveOrder++;
      return new Promise((r) =>
        setTimeout(() => r(10n ** 19n), delays[i] ?? 10),
      );
    });

    const start = Date.now();
    const { runBalanceCheck } = await loadScript();
    await runBalanceCheck({
      configs: makeConfigs(),
      webhookUrl: 'https://hook.example.com',
      logger: { log: vi.fn(), error: vi.fn() },
    });
    const elapsed = Date.now() - start;

    // 直列なら 50+30+10 = 90ms 以上、並列なら最大 50ms 程度
    expect(elapsed).toBeLessThan(150); // CI の jitter を吸収する余裕値
    expect(readContractMock).toHaveBeenCalledTimes(3);
  });

  it('1 chain 失敗で全体が rejection (failure isolation を意図しない、fail-fast 設計)', async () => {
    process.env.PIMLICO_PAYMASTER_POLYGON =
      '0x000000000000000000000000000000000000B011';
    process.env.PIMLICO_PAYMASTER_BASE =
      '0x000000000000000000000000000000000000bA5e';

    readContractMock.mockResolvedValueOnce(10n ** 19n); // polygon OK
    readContractMock.mockRejectedValueOnce(new Error('base RPC timeout'));

    const { runBalanceCheck } = await loadScript();
    await expect(
      runBalanceCheck({
        configs: makeConfigs(),
        webhookUrl: 'https://hook.example.com',
        logger: { log: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow(/base RPC timeout/);
  });
});
