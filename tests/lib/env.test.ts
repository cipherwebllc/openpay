import { describe, it, expect, vi, afterEach } from 'vitest';

// 各テストで vi.resetModules() を使い、モジュール評価時の throw / 値を観測する。
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('lib/env (module-load validation)', () => {
  it('NETWORK_ENV=testnet で読込成功', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'testnet';
    const mod = await import('@/lib/env');
    expect(mod.env.networkEnv).toBe('testnet');
    expect(mod.isMainnet).toBe(false);
  });

  it('NETWORK_ENV=mainnet で isMainnet=true', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    // 必須 mainnet env を全 set (個別 throw 経路は別 test で cover)
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_test';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      'https://abc@o1.ingest.sentry.io/2';
    const mod = await import('@/lib/env');
    expect(mod.env.networkEnv).toBe('mainnet');
    expect(mod.isMainnet).toBe(true);
  });

  it('NETWORK_ENV 不正値で throw する', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'goerli';
    await expect(import('@/lib/env')).rejects.toThrow(/NETWORK_ENV/);
  });

  it('NETWORK_ENV 未設定なら testnet にフォールバック', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_NETWORK_ENV;
    const mod = await import('@/lib/env');
    expect(mod.env.networkEnv).toBe('testnet');
  });

  it('FEE_RECEIVER_ADDRESS 未設定なら 0x...dEaD にフォールバック', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS;
    const mod = await import('@/lib/env');
    expect(mod.env.feeReceiver.toLowerCase()).toBe(
      '0x000000000000000000000000000000000000dead',
    );
  });

  it('FEE_RECEIVER_ADDRESS 指定値は checksum 化されて反映される', async () => {
    vi.resetModules();
    const lower = '0xcafe000000000000000000000000000000005678';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS = lower;
    const mod = await import('@/lib/env');
    // checksum 化されるため大文字小文字が混在し得る (元と !==) が、
    // toLowerCase で同値性確認できる。
    expect(mod.env.feeReceiver.toLowerCase()).toBe(lower);
  });

  it('FEE_RECEIVER_ADDRESS が不正値 → プレースホルダにフォールバック + warn', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS = 'not-an-address';
    const mod = await import('@/lib/env');
    expect(mod.env.feeReceiver.toLowerCase()).toBe(
      '0x000000000000000000000000000000000000dead',
    );
    expect(warn).toHaveBeenCalled();
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('JPYC_MAINNET_ADDRESS env override (polygon キー) がパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_JPYC_MAINNET_ADDRESS =
      '0xabcd000000000000000000000000000000009999';
    const mod = await import('@/lib/env');
    expect(mod.env.mainnetTokenOverrides.jpyc.polygon?.toLowerCase()).toBe(
      '0xabcd000000000000000000000000000000009999',
    );
  });

  it('JPYC_KAIA_ADDRESS env override (kaia キー) がパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS =
      '0xbeef000000000000000000000000000000001111';
    const mod = await import('@/lib/env');
    expect(mod.env.mainnetTokenOverrides.jpyc.kaia?.toLowerCase()).toBe(
      '0xbeef000000000000000000000000000000001111',
    );
  });

  it('JPYC_TESTNET_ADDRESS env override (testnet polygon キー、後方互換)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_JPYC_TESTNET_ADDRESS =
      '0xcafe000000000000000000000000000000002222';
    const mod = await import('@/lib/env');
    expect(mod.env.testnetTokenOverrides.jpyc.polygon?.toLowerCase()).toBe(
      '0xcafe000000000000000000000000000000002222',
    );
    // kaia は未設定なら undefined (deployment skip 条件)
    expect(mod.env.testnetTokenOverrides.jpyc.kaia).toBeUndefined();
  });

  it('JPYC_KAIROS_ADDRESS env override (testnet kaia キー) がパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS =
      '0xdada000000000000000000000000000000003333';
    const mod = await import('@/lib/env');
    expect(mod.env.testnetTokenOverrides.jpyc.kaia?.toLowerCase()).toBe(
      '0xdada000000000000000000000000000000003333',
    );
  });

  it('JPYC_KAIA_ADDRESS 不正値 (非 0x address) は warn して undefined', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS = 'not-a-hex';
    const mod = await import('@/lib/env');
    expect(mod.env.mainnetTokenOverrides.jpyc.kaia).toBeUndefined();
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes('NEXT_PUBLIC_JPYC_KAIA_ADDRESS'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('NEXT_PUBLIC_KAIA_RPC_URL / NEXT_PUBLIC_KAIROS_RPC_URL が rpc 構造に乗る', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_KAIA_RPC_URL = 'https://kaia.rpc.example/v1';
    process.env.NEXT_PUBLIC_KAIROS_RPC_URL = 'https://kairos.rpc.example/v1';
    const mod = await import('@/lib/env');
    expect(mod.env.rpc.kaia).toBe('https://kaia.rpc.example/v1');
    expect(mod.env.rpc.kairos).toBe('https://kairos.rpc.example/v1');
  });

  it('NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI が gasCeilingGwei.kaia に乗る', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI = '75';
    const mod = await import('@/lib/env');
    expect(mod.env.gasCeilingGwei.kaia).toBe(75);
  });

  it('NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI 不正値 (非正整数) は undefined', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_GAS_CEILING_KAIA_GWEI = '-50';
    const mod = await import('@/lib/env');
    expect(mod.env.gasCeilingGwei.kaia).toBeUndefined();
    warn.mockRestore();
  });

  it('USDC mainnet の per-chain env override (5 chain) がパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_USDC_BASE_MAINNET_ADDRESS =
      '0xbabe0000000000000000000000000000000abcde';
    process.env.NEXT_PUBLIC_USDC_ARBITRUM_MAINNET_ADDRESS =
      '0xa1b1000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_OPTIMISM_MAINNET_ADDRESS =
      '0x0021000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_POLYGON_MAINNET_ADDRESS =
      '0xb01a000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_ETHEREUM_MAINNET_ADDRESS =
      '0xe7e0000000000000000000000000000000abcde0';
    const mod = await import('@/lib/env');
    expect(mod.env.mainnetTokenOverrides.usdc.base?.toLowerCase()).toBe(
      '0xbabe0000000000000000000000000000000abcde',
    );
    expect(mod.env.mainnetTokenOverrides.usdc.arbitrum?.toLowerCase()).toBe(
      '0xa1b1000000000000000000000000000000abcde0',
    );
    expect(mod.env.mainnetTokenOverrides.usdc.optimism?.toLowerCase()).toBe(
      '0x0021000000000000000000000000000000abcde0',
    );
    expect(mod.env.mainnetTokenOverrides.usdc.polygon?.toLowerCase()).toBe(
      '0xb01a000000000000000000000000000000abcde0',
    );
    expect(mod.env.mainnetTokenOverrides.usdc.ethereum?.toLowerCase()).toBe(
      '0xe7e0000000000000000000000000000000abcde0',
    );
  });

  it('USDC testnet の per-chain env override (5 chain) がパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_USDC_BASE_SEPOLIA_ADDRESS =
      '0xbabe0000000000000000000000000000000abcde';
    process.env.NEXT_PUBLIC_USDC_ARBITRUM_SEPOLIA_ADDRESS =
      '0xa1b1000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_OPTIMISM_SEPOLIA_ADDRESS =
      '0x0021000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_POLYGON_AMOY_ADDRESS =
      '0xb01a000000000000000000000000000000abcde0';
    process.env.NEXT_PUBLIC_USDC_SEPOLIA_ADDRESS =
      '0x5e90000000000000000000000000000000abcde0';
    const mod = await import('@/lib/env');
    expect(mod.env.testnetTokenOverrides.usdc.base?.toLowerCase()).toBe(
      '0xbabe0000000000000000000000000000000abcde',
    );
    expect(mod.env.testnetTokenOverrides.usdc.arbitrum?.toLowerCase()).toBe(
      '0xa1b1000000000000000000000000000000abcde0',
    );
    expect(mod.env.testnetTokenOverrides.usdc.optimism?.toLowerCase()).toBe(
      '0x0021000000000000000000000000000000abcde0',
    );
    expect(mod.env.testnetTokenOverrides.usdc.polygon?.toLowerCase()).toBe(
      '0xb01a000000000000000000000000000000abcde0',
    );
    expect(mod.env.testnetTokenOverrides.usdc.ethereum?.toLowerCase()).toBe(
      '0x5e90000000000000000000000000000000abcde0',
    );
  });

  it('NEXT_PUBLIC_ETHEREUM_RPC_URL / NEXT_PUBLIC_SEPOLIA_RPC_URL が env.rpc に乗る', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL = 'https://rpc.example/eth';
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = 'https://rpc.example/sep';
    const mod = await import('@/lib/env');
    expect(mod.env.rpc.ethereum).toBe('https://rpc.example/eth');
    expect(mod.env.rpc.sepolia).toBe('https://rpc.example/sep');
  });

  it('Arbitrum / Optimism RPC URL env が読み込まれる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL = 'https://rpc.example/arb';
    process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL = 'https://rpc.example/op';
    process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL =
      'https://rpc.example/arbs';
    process.env.NEXT_PUBLIC_OPTIMISM_SEPOLIA_RPC_URL =
      'https://rpc.example/ops';
    const mod = await import('@/lib/env');
    expect(mod.env.rpc.arbitrum).toBe('https://rpc.example/arb');
    expect(mod.env.rpc.optimism).toBe('https://rpc.example/op');
    expect(mod.env.rpc.arbitrumSepolia).toBe('https://rpc.example/arbs');
    expect(mod.env.rpc.optimismSepolia).toBe('https://rpc.example/ops');
  });

  it('parsePositiveInt: NaN / 負数 / 0 / 小数 を流すと undefined fallback + console.warn (各 env 名を含む)', async () => {
    // FEE_RECEIVER と同じ invalid 入力ガードが gas ceiling / overhead / POL_JPYC_RATE
    // にも効くことを実走行で確認。これが silent に通ると、本番で env を typo
    // した運営が「設定したつもり」で fallback 値で稼働することになる。
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 4 種の invalid pattern を 4 つの env に振り分け
    process.env.NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS = 'abc'; // NaN
    process.env.NEXT_PUBLIC_POL_JPYC_RATE = '-1'; // 負数
    process.env.NEXT_PUBLIC_GAS_CEILING_BASE_GWEI = '0'; // 非正
    process.env.NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI = '1.5'; // 非整数
    // valid の対照群: optimism は通すべき
    process.env.NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI = '7';

    const mod = await import('@/lib/env');

    // 4 件の invalid は全て fallback (undefined)
    expect(mod.env.gasQuoteOverheadUnits).toBeUndefined();
    expect(mod.env.polJpycRate).toBeUndefined();
    expect(mod.env.gasCeilingGwei.base).toBeUndefined();
    expect(mod.env.gasCeilingGwei.arbitrum).toBeUndefined();
    // valid は通る
    expect(mod.env.gasCeilingGwei.optimism).toBe(7);

    // warn は invalid 4 件分 fire し、各 var 名がメッセージに含まれる
    expect(warn).toHaveBeenCalledTimes(4);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some((m) => m.includes('NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('NEXT_PUBLIC_POL_JPYC_RATE')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('NEXT_PUBLIC_GAS_CEILING_BASE_GWEI')),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI'),
      ),
    ).toBe(true);

    warn.mockRestore();
  });

  it('parsePositiveInt: 空文字 / 未設定 → undefined (warn なし)', async () => {
    // 空文字は nonEmpty で undefined に倒れるため warn は出さない
    // (ユーザは「未設定」を意図しているので警告ノイズを増やさない)。
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_POL_JPYC_RATE = '';
    delete process.env.NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS;

    const mod = await import('@/lib/env');

    expect(mod.env.polJpycRate).toBeUndefined();
    expect(mod.env.gasQuoteOverheadUnits).toBeUndefined();
    // POL_JPYC_RATE / GAS_QUOTE_OVERHEAD_GAS 由来の warn は出ない
    const polWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes('NEXT_PUBLIC_POL_JPYC_RATE'),
    );
    const gasWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes('NEXT_PUBLIC_GAS_QUOTE_OVERHEAD_GAS'),
    );
    expect(polWarns).toHaveLength(0);
    expect(gasWarns).toHaveLength(0);

    warn.mockRestore();
  });

  it('Arbitrum / Optimism gas ceiling env が整数としてパースされる', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GAS_CEILING_ARBITRUM_GWEI = '5';
    process.env.NEXT_PUBLIC_GAS_CEILING_OPTIMISM_GWEI = '3';
    const mod = await import('@/lib/env');
    expect(mod.env.gasCeilingGwei.arbitrum).toBe(5);
    expect(mod.env.gasCeilingGwei.optimism).toBe(3);
  });

  it('PIMLICO_API_KEY 未設定なら空文字 (実際の利用時に throw)', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
    const mod = await import('@/lib/env');
    expect(mod.env.pimlicoApiKey).toBe('');
  });

  it('SPONSORSHIP_POLICY_ID 未設定なら undefined', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID;
    const mod = await import('@/lib/env');
    expect(mod.env.pimlicoSponsorshipPolicyId).toBeUndefined();
  });
});

describe('mainnet 投入時の silent failure ガード', () => {
  // 案A (collect-at-ceiling): JPYC sponsorship のガス代 reimbursement が
  // feeReceiver へ送られるため、mainnet で未設定/placeholder だと 0x...dEaD に
  // 永久消失して運営赤字になる。よって FEE_RECEIVER は mainnet 必須 (build で throw)。
  it('mainnet + FEE_RECEIVER 未設定 → throw (ガス代 reimbursement の永久消失防止)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'pol_test';
    process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://example@sentry.io/123';
    delete process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS;
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_FEE_RECEIVER_ADDRESS/,
    );
  });

  it('mainnet + FEE_RECEIVER=dEaD placeholder → throw (fallback 値での deploy 防止)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'pol_test';
    process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://example@sentry.io/123';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0x000000000000000000000000000000000000dead';
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_FEE_RECEIVER_ADDRESS/,
    );
  });

  it('mainnet + PIMLICO_API_KEY 未設定 → throw (決済 runtime error 防止)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    delete process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_PIMLICO_API_KEY/,
    );
  });

  it('mainnet + SPONSORSHIP_POLICY_ID 未設定 → throw (sponsorship 残高悪用防止)', async () => {
    // policy 無し UserOp を Pimlico に送ると、ダッシュボード側 default policy が
    // 全許可なら第三者が任意 /pay URL で運営 sponsorship 残高を消費可能。
    // クライアント側 allowlist だけでは改竄可能なので、サーバ側 policy を必須化する。
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    delete process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID;
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID/,
    );
  });

  it('mainnet + SPONSORSHIP_POLICY_ID 空文字 → throw (nonEmpty fallback で undefined 扱い)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = '';
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID/,
    );
  });

  it('mainnet + SENTRY_DSN 未設定 → throw (browser 観測ゼロ防止)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_prod_real';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_SENTRY_DSN/,
    );
  });

  it('mainnet + SENTRY_DSN 空文字 → throw (nonEmpty fallback)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_prod_real';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    process.env.NEXT_PUBLIC_SENTRY_DSN = '';
    await expect(import('@/lib/env')).rejects.toThrow(
      /NEXT_PUBLIC_SENTRY_DSN/,
    );
  });

  it('mainnet + 全必須 env 設定済 (SENTRY_DSN 含む) → 正常 import', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_prod_real';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xcafe000000000000000000000000000000000999';
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      'https://abc123@o12345.ingest.us.sentry.io/67890';
    const mod = await import('@/lib/env');
    expect(mod.isMainnet).toBe(true);
    expect(mod.env.pimlicoSponsorshipPolicyId).toBe('sp_prod_real');
    expect(mod.env.sentryDsn).toBe(
      'https://abc123@o12345.ingest.us.sentry.io/67890',
    );
  });

  it('testnet では FEE_RECEIVER / SPONSORSHIP_POLICY_ID 未設定でも throw しない (開発体験優先)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'testnet';
    delete process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS;
    delete process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
    delete process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID;
    const mod = await import('@/lib/env');
    expect(mod.env.feeReceiver.toLowerCase()).toBe(
      '0x000000000000000000000000000000000000dead',
    );
    expect(mod.env.pimlicoApiKey).toBe('');
    expect(mod.env.pimlicoSponsorshipPolicyId).toBeUndefined();
  });
});
