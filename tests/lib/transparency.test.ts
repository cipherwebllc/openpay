// /transparency の content SOT を mainnet 構成で検証する。
// 料率とコントラクトは別表を持たず、lib/legal.ts / lib/tokens.ts の実値との一致を fence する。

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as TransparencyModule from '@/lib/transparency';
import type * as TokensModule from '@/lib/tokens';
import type * as ChainsModule from '@/lib/chains';
import type * as LegalModule from '@/lib/legal';

const ORIGINAL_ENV = { ...process.env };
const LOCALES = ['ja', 'en'] as const;

let transparency: typeof TransparencyModule;
let tokens: typeof TokensModule;
let chains: typeof ChainsModule;
let legal: typeof LegalModule;

function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { __array: value.length ? shape(value[0]) : 'empty', len: value.length };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = shape((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}

function percentFromBps(bps: number): string {
  return `${bps / 100}%`;
}

beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv(
    'NEXT_PUBLIC_FEE_RECEIVER_ADDRESS',
    '0xdead000000000000000000000000000000001234',
  );
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_API_KEY', 'test_pimlico_key');
  vi.stubEnv('NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID', 'sp_test');

  transparency = await import('@/lib/transparency');
  tokens = await import('@/lib/tokens');
  chains = await import('@/lib/chains');
  legal = await import('@/lib/legal');
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('transparencyContentFor: locale と ja/en parity', () => {
  it("'ja' / 'en' は対応 SOT、未知 locale は ja を返す", () => {
    expect(transparency.transparencyContentFor('ja')).toBe(
      transparency.TRANSPARENCY.ja,
    );
    expect(transparency.transparencyContentFor('en')).toBe(
      transparency.TRANSPARENCY.en,
    );
    expect(transparency.transparencyContentFor('fr')).toBe(
      transparency.TRANSPARENCY.ja,
    );
  });

  it('ja/en のトップレベルキーと構造が一致し、8 節を持つ', () => {
    expect(Object.keys(transparency.TRANSPARENCY.ja).sort()).toEqual(
      Object.keys(transparency.TRANSPARENCY.en).sort(),
    );
    expect(shape(transparency.TRANSPARENCY.ja)).toEqual(
      shape(transparency.TRANSPARENCY.en),
    );
    for (const locale of LOCALES) {
      const content = transparency.TRANSPARENCY[locale];
      const titles = [
        content.custodyTitle,
        content.contractsTitle,
        content.verificationTitle,
        content.feesTitle,
        content.refundsTitle,
        content.uncertaintyTitle,
        content.listingsTitle,
        content.metricsTitle,
      ];
      expect(titles).toHaveLength(8);
      titles.forEach((title, index) =>
        expect(title.startsWith(`${index + 1}.`)).toBe(true),
      );
    }
  });
});

describe('transparencyMetadata: indexable metadata', () => {
  it.each(LOCALES)('%s: content SOT の title/description と index/follow', (locale) => {
    const content = transparency.TRANSPARENCY[locale];
    expect(transparency.transparencyMetadata(locale)).toEqual({
      title: `${content.metaTitle} · OpenPay`,
      description: content.metaDescription,
      robots: { index: true, follow: true },
    });
  });

  it('未知 locale は ja metadata に一致', () => {
    expect(transparency.transparencyMetadata('fr')).toEqual(
      transparency.transparencyMetadata('ja'),
    );
  });
});

describe('手数料の SOT fence', () => {
  it.each(LOCALES)('%s: DISCLOSED_* の全数値が対応する描画文に含まれる', (locale) => {
    const fees = transparency.TRANSPARENCY[locale].fees;
    expect(fees[0]).toContain(
      percentFromBps(legal.DISCLOSED_RECOVER_FEE.percentFromJulyBps),
    );
    expect(fees[0]).toContain(
      `${legal.DISCLOSED_RECOVER_FEE.floorJpyc} JPYC`,
    );
    expect(fees[1]).toContain(
      percentFromBps(legal.DISCLOSED_MOBILE_ORDER_FEE.storefrontBps),
    );
    expect(fees[1]).toContain(
      percentFromBps(legal.DISCLOSED_MOBILE_ORDER_FEE.preorderBps),
    );
    expect(fees[2]).toContain(
      percentFromBps(legal.DISCLOSED_X402_FEE.bps),
    );
    expect(fees[2]).toContain(
      `${legal.DISCLOSED_X402_FEE.floorJpyc} JPYC`,
    );
  });
});

describe('mainnet コントラクト表の SOT fence', () => {
  it('TOKEN_DEPLOYMENTS の mainnet 全アドレスを表示し testnet は含めない', () => {
    const mainnetDeployments = tokens.TOKEN_DEPLOYMENTS.filter((deployment) => {
      const chain = chains.supportedChains.find(
        (item) => item.id === deployment.chainId,
      );
      return chain !== undefined && chain.testnet !== true;
    });
    expect(mainnetDeployments.length).toBeGreaterThan(0);

    for (const locale of LOCALES) {
      const rows = transparency.TRANSPARENCY[locale].contracts;
      expect(rows).toHaveLength(mainnetDeployments.length);
      for (const deployment of mainnetDeployments) {
        const chain = chains.supportedChains.find(
          (item) => item.id === deployment.chainId,
        );
        expect(rows).toContainEqual({
          token: deployment.displaySymbol,
          chain: chain?.name,
          address: deployment.address,
        });
      }
    }
  });
});
