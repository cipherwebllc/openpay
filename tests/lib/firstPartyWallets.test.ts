import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_WALLETS } from '@/lib/externalPurchases';

const wallets = [
  { address: '0x9a76ea8fc0b9f34d34b91d453f2940932c9a7fe0', note: 'テスト買い手 / license minter' },
  { address: '0x8f16ef365676c405c739175fe7a11343e864343b', note: '運営者個人 (テスト兼用)' },
  { address: '0xda33e4cee3f06b19b174e299a36fcd075f0f9674', note: 'テストネット使い捨て (mainnet でも動作確認に使用)' },
  { address: '0x52d4901142e2b5680027da5eb47c86cb02a3ca81', note: '受取ウォレット' },
  { address: '0x428483fba62edcef1e3a100d3799f6d71759c560', note: '手数料受取' },
];

describe('first-party wallet extraction pins', () => {
  it('preserves the public module/export, lowercase addresses and their order', () => {
    expect(FIRST_PARTY_WALLETS).toEqual(wallets.map(({ address }) => address));
  });

  it('preserves every wallet provenance note', () => {
    // Only the source reader changed after extraction; the provenance expectation is unchanged.
    const entries = JSON.parse(readFileSync(resolve('lib/firstPartyWallets.json'), 'utf8'));
    expect(entries).toEqual(wallets);
  });

  it('keeps the list well-formed: lowercase, unique, and each with a provenance note', () => {
    const entries: { address: string; note: string }[] = JSON.parse(readFileSync(resolve('lib/firstPartyWallets.json'), 'utf8'));
    expect(entries.length).toBeGreaterThan(0);
    for (const { address, note } of entries) {
      expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(note.trim()).not.toBe('');
    }
    expect(new Set(entries.map(({ address }) => address)).size).toBe(entries.length);
  });
});
