import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

describe('protected delivery disclosure drafts', () => {
  it('README and llms describe the same mechanism without changing the price fence', () => {
    const readme = readFileSync('README.md', 'utf8').split('\n').find((line) => line.startsWith('- **Protected delivery'))!;
    const llms = readFileSync('public/llms.txt', 'utf8').split('\n').find((line) => line.startsWith('- 保護配布'))!;
    for (const line of [readme, llms]) {
      for (const text of ['OFF', '60', 'EdDSA', '/.well-known/openpay-delivery-keys.json', 'SDK 0.8.0', 'openpay-x402-sdk/delivery']) expect(line).toContain(text);
      expect(line).not.toMatch(/JPYC|USDC|%|手数料|価格/);
    }
    for (const text of ['does not host', 'not yet published', 'responsible for its availability', 'not copying or sharing']) expect(readme).toContain(text);
    for (const text of ['保管・配信しない', '未 publish', '可用性は売り手の責任', '期限内の共有']) expect(llms).toContain(text);
  });
  it('UI keys live in their intended namespaces in both languages', () => {
    for (const messages of [ja, en]) {
      for (const key of ['deliveryUrlLabel', 'deliveryUrlHelp', 'deliveryGuideLink', 'detailInvalidDeliveryUrl'] as const) expect(messages.CreatorStoreSeller[key]).toBeTruthy();
      for (const key of ['openProtectedDownload', 'protectedDownloadCaption'] as const) expect(messages.CreatorStoreLibrary[key]).toBeTruthy();
      expect(messages.CreatorStorefront.protectedDeliveryBadge).toBeTruthy();
    }
  });
});
