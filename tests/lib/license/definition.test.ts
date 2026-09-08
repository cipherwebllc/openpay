import { describe, expect, it } from 'vitest';
import { createLicenseDefinition, computeLicenseDefinitionHash, licenseTermsHash, parseLicenseDefinition } from '@/lib/license/definition';
const ID = 'h_000102030405060708090a0b0c0d0e0f';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const terms = { supply: 10000, transferable: false, termsUrl: 'https://seller.example/terms', termsVersion: '2026-09-08' };
describe('canonical license tuple', () => {
  it('matches the fixed ABI golden vector and PR A tokenId', () => {
    const d = createLicenseDefinition(ID, terms, 80002, CONTRACT);
    expect(d.tokenId).toBe('0xf1d52e03274f94c6c02c6ef09db2a0408a4962266d56721d5d6cf0bccdbecbb7');
    expect(d.termsHash).toBe('0x26a15572b035a67aad9130e5f461f3ff14e8147b385d8d0421582ee1cf45c6b5');
    expect(d.definitionHash).toBe('0xb95791117ca595c9a3d6c029de67262c5727896c94a68b2f57602080dcf12654');
    expect(parseLicenseDefinition(d)).toEqual(d);
    expect(computeLicenseDefinitionHash({ ...d })).toBe(d.definitionHash);
  });
  it('binds the URL/version boundary, deployment, content and supply', () => {
    expect(licenseTermsHash('https://a.example/ab', 'c')).not.toBe(licenseTermsHash('https://a.example/a', 'bc'));
    const d = createLicenseDefinition(ID, terms, 80002, CONTRACT);
    for (const change of [{ supply: 9999 }, { transferable: true }, { contentRef: 'x402:hosted:h_' + 'b'.repeat(32) + ':content:1' }, { deploymentId: 'new' }, { termsVersion: '2' }, { rail: 'usdc' }, { tokenChainId: 8453 }]) expect(parseLicenseDefinition({ ...d, ...change })).toBeNull();
    // 読込は current env ではなく保存 tuple が権威。rotation は旧 snapshot を改変しない。
    const rotated = createLicenseDefinition(ID, terms, 137, CONTRACT); expect(parseLicenseDefinition(rotated)).toEqual(rotated);
  });
});
