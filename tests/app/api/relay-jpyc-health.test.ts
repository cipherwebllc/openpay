// B1 Layer B — GET /api/relay/jpyc/health (relayer 事前健全性プローブ) の検証。
// route は relayProvider (PROVIDER / SUPPORTED_CHAINS / MAINNET_CHAINS / selfHostIoFor) を再利用して
// 粗い { degraded, reason } を返す。ここでは relayProvider を境界モックし、route 固有のロジック
// (chain 検証・no_relayer・low_balance フロア判定・fail-open・module cache) を実走させる。
//
// route は module-level cache (Map) を持つので、各 it で `vi.resetModules()` + dynamic import して
// cache をクリーンにしてから GET を取り直す (cache hit を狙うテストだけ同一 module で 2 回叩く)。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextResponse } from 'next/server';

// relayProvider を可変 holder 経由でモック (PROVIDER / 残高 / chain 集合を it ごとに差し替える)。
const hold = vi.hoisted(() => ({
  provider: 'self-host' as 'self-host' | 'gelato' | null,
  // getBalance の戻り値 (wei)。throw させたいテストは balanceThrows=true。
  balanceWei: 100n * 10n ** 18n,
  balanceThrows: false,
  getBalanceCalls: 0,
  // SUPPORTED_CHAINS / MAINNET_CHAINS を再現 (Polygon=137 mainnet, Amoy=80002 testnet)。
  supported: new Set<number>([137, 80002]),
  mainnet: new Set<number>([137]),
}));

vi.mock('@/lib/relay/relayProvider', () => ({
  get PROVIDER() {
    return hold.provider;
  },
  // route は `chainId in SUPPORTED_CHAINS` で対応判定する → object として見せる。
  get SUPPORTED_CHAINS() {
    return Object.fromEntries([...hold.supported].map((id) => [id, {}]));
  },
  get MAINNET_CHAINS() {
    return hold.mainnet;
  },
  selfHostIoFor: (_chainId: number) => ({
    getBalance: async () => {
      hold.getBalanceCalls++;
      if (hold.balanceThrows) throw new Error('rpc boom');
      return hold.balanceWei;
    },
  }),
}));

function req(chainId?: string | number): Request {
  const qs = chainId === undefined ? '' : `?chainId=${chainId}`;
  return new Request(`http://localhost/api/relay/jpyc/health${qs}`);
}

// fresh module (空 cache) の GET を取り直す。
async function freshGet(): Promise<(req: Request) => Promise<NextResponse>> {
  vi.resetModules();
  const mod = await import('@/app/api/relay/jpyc/health/route');
  return mod.GET;
}

beforeEach(() => {
  hold.provider = 'self-host';
  hold.balanceWei = 100n * 10n ** 18n;
  hold.balanceThrows = false;
  hold.getBalanceCalls = 0;
  hold.supported = new Set<number>([137, 80002]);
  hold.mainnet = new Set<number>([137]);
  vi.unstubAllEnvs();
});

describe('GET /api/relay/jpyc/health', () => {
  it('非対応 chain → degraded:unsupported (RPC は読まない)', async () => {
    const GET = await freshGet();
    const res = await GET(req(999999));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ degraded: true, reason: 'unsupported' });
    expect(hold.getBalanceCalls).toBe(0);
  });

  it('chainId 欠落 → degraded:unsupported', async () => {
    const GET = await freshGet();
    const res = await GET(req());
    expect(await res.json()).toEqual({ degraded: true, reason: 'unsupported' });
  });

  it('chainId が数値でない → degraded:unsupported', async () => {
    const GET = await freshGet();
    const res = await GET(req('abc'));
    expect(await res.json()).toEqual({ degraded: true, reason: 'unsupported' });
    expect(hold.getBalanceCalls).toBe(0);
  });

  it('relayer 鍵なし (PROVIDER!=="self-host") → degraded:no_relayer (RPC は読まない)', async () => {
    hold.provider = null;
    const GET = await freshGet();
    const res = await GET(req(80002));
    expect(await res.json()).toEqual({ degraded: true, reason: 'no_relayer' });
    expect(hold.getBalanceCalls).toBe(0);
  });

  it('gelato provider でも degraded:no_relayer (self-host のみ relayer EOA を持つ)', async () => {
    hold.provider = 'gelato';
    const GET = await freshGet();
    const res = await GET(req(80002));
    expect(await res.json()).toEqual({ degraded: true, reason: 'no_relayer' });
  });

  it('残高がフロア未満 (mainnet 137・5 native 既定) → degraded:low_balance', async () => {
    hold.balanceWei = 1n * 10n ** 18n; // 1 POL < 5 POL フロア
    const GET = await freshGet();
    const res = await GET(req(137));
    expect(await res.json()).toEqual({ degraded: true, reason: 'low_balance' });
    expect(hold.getBalanceCalls).toBe(1);
  });

  it('残高がフロア以上 (mainnet 137) → degraded:false', async () => {
    hold.balanceWei = 10n * 10n ** 18n; // 10 POL >= 5 POL フロア
    const GET = await freshGet();
    const res = await GET(req(137));
    expect(await res.json()).toEqual({ degraded: false });
  });

  it('testnet (80002) フロアは 0.01 native: 0.5 native でも健全', async () => {
    hold.balanceWei = 5n * 10n ** 17n; // 0.5 native >= 0.01 フロア
    const GET = await freshGet();
    const res = await GET(req(80002));
    expect(await res.json()).toEqual({ degraded: false });
  });

  it('testnet (80002): 残高 0 → degraded:low_balance', async () => {
    hold.balanceWei = 0n;
    const GET = await freshGet();
    const res = await GET(req(80002));
    expect(await res.json()).toEqual({ degraded: true, reason: 'low_balance' });
  });

  it('Avalanche (43114) は per-chain フロア 0.1 AVAX: 1 AVAX で健全 (mainnet 既定 5 native は不適用)', async () => {
    // AVAX は高価かつ gas 極小のため 5 native フロアは過大 → per-chain で 0.1 AVAX に。
    // 1 AVAX は旧 5 native フロアなら low_balance だったが、per-chain 0.1 では健全。
    hold.supported = new Set<number>([43114]);
    hold.mainnet = new Set<number>([43114]);
    hold.balanceWei = 1n * 10n ** 18n; // 1 AVAX >= 0.1 AVAX フロア
    const GET = await freshGet();
    const res = await GET(req(43114));
    expect(await res.json()).toEqual({ degraded: false });
  });

  it('Avalanche (43114): 0.05 AVAX (0.1 フロア未満) → degraded:low_balance', async () => {
    hold.supported = new Set<number>([43114]);
    hold.mainnet = new Set<number>([43114]);
    hold.balanceWei = 5n * 10n ** 16n; // 0.05 AVAX < 0.1 AVAX フロア
    const GET = await freshGet();
    const res = await GET(req(43114));
    expect(await res.json()).toEqual({ degraded: true, reason: 'low_balance' });
  });

  it('RELAY_HEALTH_MIN_BALANCE_WEI override が chain 既定より優先', async () => {
    // override を高く設定すると健全残高でも low_balance に倒れる。
    vi.stubEnv('RELAY_HEALTH_MIN_BALANCE_WEI', (50n * 10n ** 18n).toString());
    hold.balanceWei = 10n * 10n ** 18n; // 10 < 50 (override) → low_balance
    const GET = await freshGet();
    const res = await GET(req(137));
    expect(await res.json()).toEqual({ degraded: true, reason: 'low_balance' });
  });

  it('RPC throw → degraded:false (fail-open)', async () => {
    hold.balanceThrows = true;
    const GET = await freshGet();
    const res = await GET(req(80002));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ degraded: false });
    expect(hold.getBalanceCalls).toBe(1);
  });

  it('cache hit: TTL 内の 2 回目は RPC を再読しない (同 chainId・同 module)', async () => {
    hold.balanceWei = 10n * 10n ** 18n;
    const GET = await freshGet();
    const res1 = await GET(req(137));
    expect(await res1.json()).toEqual({ degraded: false });
    expect(hold.getBalanceCalls).toBe(1);

    // 2 回目 (同 chainId・TTL 60s 内) は cache hit → getBalance を再度呼ばない。
    const res2 = await GET(req(137));
    expect(await res2.json()).toEqual({ degraded: false });
    expect(hold.getBalanceCalls).toBe(1);
  });
});
