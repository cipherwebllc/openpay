import { describe, expect, it } from 'vitest';
import { displayTitleOf, splitDisplayTitle } from '@/lib/x402/displayTitle';

const base = { resource: 'https://example.jp:8443/paid/data?q=test#section', description: 'Description' };

describe('displayTitleOf', () => {
  it('prefers the explicit title over serviceName and description', () => {
    expect(displayTitleOf({ ...base, title: 'Product', usdc: { serviceName: 'Service' } })).toBe('Product');
  });

  it('uses serviceName when title is absent or empty', () => {
    expect(displayTitleOf({ ...base, title: '', usdc: { serviceName: 'Service' } })).toBe('Service');
  });

  it.each(['。', '. ', ' — ', ' – ', ': ', ' / ', '・', '：'])('cuts a long description at %s', (separator) => {
    expect(displayTitleOf({ ...base, description: `API${separator}${'Details '.repeat(30)}` })).toBe('API');
  });

  it('uses the first separator, not the order in the separator list', () => {
    expect(displayTitleOf({ ...base, description: 'API：Details — More. End' })).toBe('API');
  });

  it('keeps a first sentence of up to 120 characters as the heading (display clamps it)', () => {
    expect(displayTitleOf({ ...base, description: 'あ'.repeat(120) })).toBe('あ'.repeat(120));
    expect(displayTitleOf({ ...base, description: 'あ'.repeat(49) })).toBe('あ'.repeat(49));
  });

  it('truncates a sentence over 120 characters to 47 characters and an ellipsis', () => {
    expect(displayTitleOf({ ...base, description: 'あ'.repeat(121) })).toBe(`${'あ'.repeat(47)}…`);
  });

  it('truncates without splitting Unicode characters', () => {
    expect(displayTitleOf({ ...base, description: `${'😀'.repeat(121)}。詳細` })).toBe(`${'😀'.repeat(47)}…`);
  });

  it('drops a trailing full stop from a single-sentence description', () => {
    expect(
      displayTitleOf({
        ...base,
        description: 'Directory of JPYC-accepting exchanges, dApps and bridges (curated JSON).',
      }),
    ).toBe('Directory of JPYC-accepting exchanges, dApps and bridges (curated JSON)');
  });

  it('keeps the mixed Japanese/English ICP product phrase intact', () => {
    expect(displayTitleOf({ ...base, description: 'ICP の技術調査・設計相談を 1 件完了。質問文→回答の 1 往復を人手で提供します。 / Completes one round of ICP technical research and design consultation.' }))
      .toBe('ICP の技術調査・設計相談を 1 件完了');
  });

  it('falls back to the URL host and pathname without query or fragment', () => {
    expect(displayTitleOf({ ...base, description: '' })).toBe('example.jp:8443/paid/data');
  });

  it('keeps an invalid resource string as the heading instead of throwing', () => {
    expect(displayTitleOf({ resource: 'not a url', description: '' })).toBe('not a url');
  });
});

describe('splitDisplayTitle', () => {
  it('gives the whole description as body when the product has a name', () => {
    expect(splitDisplayTitle({ ...base, title: 'Product', description: 'One. Two.' })).toEqual({
      title: 'Product',
      body: 'One. Two.',
    });
    expect(
      splitDisplayTitle({ ...base, usdc: { serviceName: 'Service' }, description: 'One. Two.' }),
    ).toEqual({ title: 'Service', body: 'One. Two.' });
  });

  it('drops a "Name: " prefix from the body when it repeats the heading', () => {
    expect(
      splitDisplayTitle({
        ...base,
        title: 'JPYC Service Monitor',
        description: 'JPYC Service Monitor: weekly change feed for Japan-related services.',
      }),
    ).toEqual({ title: 'JPYC Service Monitor', body: 'Weekly change feed for Japan-related services.' });
    expect(
      splitDisplayTitle({ ...base, title: 'Demo', description: 'Demo data for testing.' }),
    ).toEqual({ title: 'Demo', body: 'Demo data for testing.' });
  });

  it('promotes the first sentence to the heading and leaves only the rest as body', () => {
    expect(
      splitDisplayTitle({
        ...base,
        description: 'Aegis - Cut Through the Noise in Your Feeds. ブリーフィング トップ3',
      }),
    ).toEqual({ title: 'Aegis - Cut Through the Noise in Your Feeds', body: 'ブリーフィング トップ3' });
    expect(splitDisplayTitle({ ...base, description: 'Tokyo Weather Data' })).toEqual({
      title: 'Tokyo Weather Data',
      body: '',
    });
  });

  it('keeps the full description as body only when the heading had to be truncated', () => {
    const long = 'あ'.repeat(121);
    expect(splitDisplayTitle({ ...base, description: long })).toEqual({
      title: `${'あ'.repeat(47)}…`,
      body: long,
    });
    const mid = 'あ'.repeat(60);
    expect(splitDisplayTitle({ ...base, description: mid })).toEqual({ title: mid, body: '' });
  });

  it('has an empty body when falling back to the URL', () => {
    expect(splitDisplayTitle({ ...base, description: '   ' })).toEqual({
      title: 'example.jp:8443/paid/data',
      body: '',
    });
  });
});
