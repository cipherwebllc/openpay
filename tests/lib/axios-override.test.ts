// `package.json` の `overrides: { axios: ^1.15.2 }` が axios 1.x 系の HIGH 脆弱性
// (axios <1.15.2 の SSRF / prototype pollution / auth bypass / CRLF injection 等)
// を回避するため transitive を pin している。axios 1.x は SemVer 上 minor 互換だが、
// `@coinbase/cdp-sdk` (Coinbase Smart Wallet 接続用) と `axios-retry` の実 import path
// が override 後も crash しないことを compile-once レベルで担保する。
//
// 実 wallet 接続フロー (signing / network call) の互換は §10 の testnet 手順で検証。
// 本テストは override が「パッケージの module load を壊していない」ことを保証する。
import { describe, it, expect } from 'vitest';

describe('axios override 互換性 (npm overrides: ^1.15.2)', () => {
  it('axios が override 後の version (>= 1.15.2) で resolve される', async () => {
    const pkg = await import('axios/package.json');
    const version = (pkg as { version?: string; default?: { version: string } })
      .version ??
      (pkg as { default?: { version: string } }).default?.version;
    expect(version).toBeDefined();
    const [major, minor] = version!.split('.').map(Number);
    // ^1.15.2 → 1.x.y で minor >= 15 (1.15.2 / 1.16.0 / 1.17+ 等)。
    // 2.x にダウングレードされたら override が効いていない (致命) ので fail。
    expect(major).toBe(1);
    expect(minor >= 15).toBe(true);
  });

  it('@coinbase/cdp-sdk が axios override 後も module load できる', async () => {
    // axios 1.16.0 で `import axios from 'axios'` が壊れていれば top-level で throw する。
    const mod = await import('@coinbase/cdp-sdk');
    expect(typeof mod.CdpClient).toBe('function');
    // Smart Wallet 経路で使われる主要 export が消えていないことを確認。
    expect(typeof mod.toEvmDelegatedAccount).toBe('function');
    expect(typeof mod.parseEther).toBe('function');
    expect(typeof mod.parseUnits).toBe('function');
  });

  it('CdpClient が dummy credentials で constructor 走行 (axios setup を伴う init)', async () => {
    const { CdpClient } = await import('@coinbase/cdp-sdk');
    // CdpClient の constructor は axios.create({...}) で内部 client を組む経路を踏む。
    // ここで axios.create が無い / signature 変更があると throw する。
    const client = new CdpClient({
      apiKeyId: 'test-dummy-key-id',
      apiKeySecret: 'test-dummy-key-secret',
    });
    // public sub-client が全て生えていることを確認 (CdpClient 公開 API の SemVer 担保)。
    expect(client.evm).toBeDefined();
    expect(client.solana).toBeDefined();
    expect(client.policies).toBeDefined();
    expect(client.endUser).toBeDefined();
    expect(client.webhooks).toBeDefined();
  });

  it('@base-org/account (wagmi connector が依存) が module load できる', async () => {
    // @wagmi/connectors → @base-org/account → @coinbase/cdp-sdk → axios の chain。
    // Smart Wallet 接続時に lazy load されるため通常時は触られないが、
    // override で chain が壊れていないことを保証する。
    const mod = await import('@base-org/account');
    expect(typeof mod.createBaseAccountSDK).toBe('function');
    expect(mod.CHAIN_IDS).toBeDefined();
    expect(mod.TOKENS).toBeDefined();
  });

  it('axios-retry が axios 1.16.0 と互換 (cdp-sdk の retry path)', async () => {
    // CdpClient は内部で axios-retry を使って transient error の自動リトライをする。
    // axios 1.16 で interceptor API に変更があれば axios-retry の attach 時点で throw。
    const axios = (await import('axios')).default;
    const axiosRetryMod = await import('axios-retry');
    const axiosRetry = axiosRetryMod.default;
    const instance = axios.create();
    // attach 時に interceptor を生やす。失敗すれば throw。
    expect(() => axiosRetry(instance, { retries: 1 })).not.toThrow();
    // 副作用で interceptor が登録されたことを確認 (handlers は public 型に
    // 出ないため internal type で narrowing)。
    type WithHandlers = { handlers: unknown[] };
    const reqHandlers = instance.interceptors.request as unknown as WithHandlers;
    const resHandlers = instance.interceptors.response as unknown as WithHandlers;
    expect(reqHandlers.handlers.length).toBeGreaterThan(0);
    expect(resHandlers.handlers.length).toBeGreaterThan(0);
  });
});
