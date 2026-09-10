import { describe, expect, it } from 'vitest';
import { createLicenseDefinition, computeLicenseDefinitionHash, licenseTermsHash, parseLicenseDefinition, parseLicenseCreationTerms, parseLicenseTerms } from '@/lib/license/definition';
import { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';
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

describe('creation-only standard terms', () => {
  it('resolves the preset to the exact Japanese URL/version and defaults transferability', () => {
    expect(parseLicenseCreationTerms({ supply: 2, termsPreset: 'standard-v1' })).toEqual({
      supply: 2, transferable: false,
      termsUrl: 'https://open-pay.jp/ja/license-terms/standard-v1', termsVersion: 'standard-v1',
    });
  });
  it('ignores client terms when the standard preset is selected', () => {
    expect(parseLicenseCreationTerms({ ...terms, termsPreset: 'standard-v1', termsUrl: 'http://forged.example', termsVersion: '' })).toEqual({
      ...terms, termsUrl: LICENSE_STANDARD_TERMS.url, termsVersion: LICENSE_STANDARD_TERMS.version,
    });
  });
  it.each(['', 'custom', 'standard-v2', null, false, 1, {}, []])('rejects invalid preset %j even with valid custom terms', (termsPreset) => {
    expect(parseLicenseCreationTerms({ ...terms, termsPreset })).toBeNull();
  });
  it('still validates supply and transferability with a preset', () => {
    for (const patch of [{ supply: 0 }, { supply: 10001 }, { supply: 1.5 }, { transferable: 'false' }]) {
      expect(parseLicenseCreationTerms({ supply: 2, termsPreset: 'standard-v1', ...patch })).toBeNull();
    }
  });
  it('requires custom URL/version without a preset', () => {
    expect(parseLicenseCreationTerms(terms)).toEqual(terms);
    expect(parseLicenseCreationTerms({ ...terms, termsUrl: undefined })).toBeNull();
    expect(parseLicenseCreationTerms({ ...terms, termsVersion: undefined })).toBeNull();
  });
  it('never resolves presets in stored terms or definitions, preserving the golden vector', () => {
    expect(parseLicenseTerms({ supply: 2, transferable: false, termsPreset: 'standard-v1' })).toBeNull();
    expect(parseLicenseTerms({ ...terms, termsPreset: 'standard-v1' })).toEqual(terms);
    const d = createLicenseDefinition(ID, terms, 80002, CONTRACT);
    expect(parseLicenseDefinition({ ...d, termsPreset: 'standard-v1' })).toEqual(d);
    expect(d.definitionHash).toBe('0xb95791117ca595c9a3d6c029de67262c5727896c94a68b2f57602080dcf12654');
    expect(parseLicenseDefinition({ ...d, termsUrl: undefined, termsVersion: undefined, termsPreset: 'standard-v1' })).toBeNull();
  });
});
