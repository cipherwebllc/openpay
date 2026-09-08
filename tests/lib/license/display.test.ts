import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { licenseSummariesFor } from '@/lib/license/display';
import { createLicenseDefinition } from '@/lib/license/definition';
import type { HostedProduct } from '@/lib/x402/hostedStore';

const kvMget = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({ kvMget }));

const owner = getAddress(`0x${'ab'.repeat(20)}`);
const id = `h_${'a'.repeat(32)}`;
const definition = createLicenseDefinition(id, {
  supply: 10, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '1',
}, 137, owner);
const product: HostedProduct = {
  id, owner, payTo: owner, productKind: 'license', license: definition,
  title: 'License', priceJpyc: '1000', contentKind: 'text', label: 'api',
  contentRevision: 1, contentAvailable: true, saleActive: true, createdAt: 1,
};
const stock = { supply: 10, reserved: 2, sold: 3, gen: definition.definitionHash };
beforeEach(() => { kvMget.mockReset(); });

describe('license display stock', () => {
  it('在庫を一括取得して supply − sold − reserved を公開する', async () => {
    kvMget.mockResolvedValue({ ok: true, value: [JSON.stringify(stock)] });
    const summaries = await licenseSummariesFor([product]);
    expect(kvMget).toHaveBeenCalledOnce();
    expect(kvMget).toHaveBeenCalledWith([`x402:hosted:${id}:license:stock`]);
    expect(summaries.get(id)).toEqual({ supply: 10, remaining: 5, transferable: false, termsUrl: definition.termsUrl, termsVersion: '1', tokenChainId: 137 });
    expect(JSON.stringify([...summaries.values()])).not.toMatch(/definitionHash|contract|tokenId/);
  });

  it('残数ゼロは完売として返す', async () => {
    kvMget.mockResolvedValue({ ok: true, value: [JSON.stringify({ ...stock, sold: 8 })] });
    expect((await licenseSummariesFor([product])).get(id)?.remaining).toBe(0);
  });

  it.each([null, '{broken', JSON.stringify({ ...stock, gen: 'stale' }), JSON.stringify({ ...stock, sold: -1 }), JSON.stringify({ ...stock, reserved: 8 }), JSON.stringify({ ...stock, sold: 1.5 })])('欠損や不正な在庫 %s は表示だけ unknown にする', async (raw) => {
    kvMget.mockResolvedValue({ ok: true, value: [raw] });
    expect((await licenseSummariesFor([product])).get(id)?.remaining).toBeNull();
  });

  it('KV 障害でも定義の表示を保ち、デジタル商品は追加 I/O を行わない', async () => {
    kvMget.mockResolvedValue({ ok: false, reason: 'timeout' });
    expect((await licenseSummariesFor([product])).get(id)).toMatchObject({ remaining: null, supply: 10 });
    kvMget.mockClear();
    expect(await licenseSummariesFor([{ ...product, productKind: undefined, license: undefined }])).toEqual(new Map());
    expect(kvMget).not.toHaveBeenCalled();
  });

  it.each([null, [], {}])('KV の応答形式 %j が不正なら、一覧を落とさず残数を unknown にする', async (value) => {
    kvMget.mockResolvedValue({ ok: true, value });
    expect((await licenseSummariesFor([product])).get(id)).toMatchObject({ remaining: null, supply: 10 });
  });
});
