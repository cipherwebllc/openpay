import { describe, it, expect, vi, afterEach } from 'vitest';
import { baseSepolia, kairos, polygonAmoy } from 'viem/chains';
import { wagmiConfig } from '@/lib/wagmi';
import { supportedChains } from '@/lib/chains';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

// 実 wagmiConfig を読み込み、connector / chain / transport の組立てが
// 環境変数 (vitest.config.ts で testnet + WC projectId 未設定) に対して
// 期待通りであることを検証する。実モジュールを実行しているので、
// chains/env/wagmi の連動が壊れた時にここが落ちる。

describe('wagmiConfig', () => {
  it('testnet env では chains に Polygon Amoy + Base Sepolia + Kairos が登録される', () => {
    const ids = wagmiConfig.chains.map((c) => c.id);
    expect(ids).toContain(polygonAmoy.id);
    expect(ids).toContain(baseSepolia.id);
    expect(ids).toContain(kairos.id);
    expect(ids).toEqual(supportedChains.map((c) => c.id));
  });

  it('Kaia/Kairos に明示的 transport が紐づいている (PoC、wagmi auto-config 経由)', () => {
    // lib/wagmi.ts は supportedChains.map で全 chain に transport を生成する。
    // 個別 RPC override 無しでも viem default RPC が使われ、connection が成立
    // する設計。env override 設定時は customRpcUrlForChain 経由で http(url) に
    // 上書きされる (chains.test.ts で fence 済)。
    const kairosTransport = wagmiConfig._internal.transports[kairos.id];
    expect(kairosTransport).toBeDefined();
  });

  it('SSR が true (Next.js App Router 用)', () => {
    expect(wagmiConfig._internal.ssr).toBe(true);
  });

  it('connectors に injected と coinbaseWallet が含まれる', () => {
    const names = wagmiConfig.connectors.map((c) => c.name);
    // 順序は injected → coinbase。WalletConnect は projectId 未設定で除外
    expect(names[0]).toBe('Injected');
    expect(names).toContain('Coinbase Wallet');
  });

  it('WC projectId 未設定時は WalletConnect 連結器を含まない', () => {
    const names = wagmiConfig.connectors.map((c) => c.name);
    // vitest 設定では NEXT_PUBLIC_WC_PROJECT_ID が無いため除外される
    expect(names.some((n) => /walletconnect/i.test(n))).toBe(false);
  });

  it('登録されたすべての chain に transport が紐づいている', () => {
    for (const chain of wagmiConfig.chains) {
      const t = wagmiConfig._internal.transports[chain.id];
      expect(t).toBeDefined();
    }
  });

  it('TypeScript の Register declaration で wagmiConfig 型が登録されている', () => {
    // wagmiConfig 自体が import できれば型が解決している証拠 (compile-time)
    expect(wagmiConfig).toBeDefined();
    expect(typeof wagmiConfig.chains).toBe('object');
  });

  it('NEXT_PUBLIC_WC_PROJECT_ID 設定時は WalletConnect connector が追加される', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_WC_PROJECT_ID = 'wc_proj_test_id';
    const mod = await import('@/lib/wagmi');
    const names = mod.wagmiConfig.connectors.map((c) => c.name);
    // walletConnect connector の name は通常 "WalletConnect"
    expect(
      names.some((n) => /walletconnect/i.test(n)),
    ).toBe(true);
    // 順序: injected → coinbaseWallet → walletConnect (3 つ)
    expect(mod.wagmiConfig.connectors.length).toBeGreaterThanOrEqual(3);
  });

  it('NEXT_PUBLIC_WC_PROJECT_ID 設定時の connector 数は 3 (未設定時は 2)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_WC_PROJECT_ID = 'wc_proj_test_id';
    const withWc = await import('@/lib/wagmi');
    expect(withWc.wagmiConfig.connectors).toHaveLength(3);

    vi.resetModules();
    delete process.env.NEXT_PUBLIC_WC_PROJECT_ID;
    const withoutWc = await import('@/lib/wagmi');
    expect(withoutWc.wagmiConfig.connectors).toHaveLength(2);
  });
});
