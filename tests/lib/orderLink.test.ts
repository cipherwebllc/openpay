// 注文リンク (lib/orderLink.ts): 公開の文書にあるパラメーターだけで /checkout のリンクを作り、
// 表示する利用料が /checkout の実計算と同じであることを固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const JPYC_FLOOR = 2n * 10n ** 18n;
const flags = vi.hoisted(() => ({ relay: true, forwarder: true }));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return {
    ...actual,
    jpycForwarderFor: () => (flags.forwarder ? '0x0F4560a777415580F0680F8B56a79B0022C6B848' : null),
    relayGasFeeValue: () => JPYC_FLOOR,
  };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      recoverFeeBps: 100,
      get enableJpycEip3009() {
        return flags.relay;
      },
    },
  };
});

import { JPYC_CHAINS } from '@/lib/chains';
import { buildOrderLink, orderLinkChains, type OrderLinkInput } from '@/lib/orderLink';
import { deploymentForSlug, isGaslessSupported } from '@/lib/tokens';
import { parseCheckoutParams } from '@/lib/url/checkout';

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;

function input(patch: Partial<OrderLinkInput> = {}): OrderLinkInput {
  return {
    origin: 'https://open-pay.jp',
    to: TO,
    chain: 'polygon',
    mode: 'gasless',
    orderId: 'A-001',
    description: '',
    lines: [{ name: 'Tシャツ M', qty: '2', price: '3000' }],
    shipping: '500',
    shippingLabel: '送料',
    ...patch,
  };
}

function okUrl(result: ReturnType<typeof buildOrderLink>): URL {
  if (!result.ok) throw new Error(`expected ok: ${result.error}`);
  return new URL(result.url);
}

beforeEach(() => {
  flags.relay = true;
  flags.forwarder = true;
});

describe('buildOrderLink', () => {
  it('商品と送料の明細・注文番号をお客様の画面で読めるリンクにする', () => {
    const url = okUrl(buildOrderLink(input()));
    expect(url.pathname).toBe('/checkout');
    const parsed = parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.to).toBe(TO);
    expect(parsed.params.token).toBe('jpyc');
    expect(parsed.params.orderId).toBe('A-001');
    expect(parsed.params.items).toEqual([
      { name: 'Tシャツ M', qty: 2, price: '3000' },
      { name: '送料', qty: 1, price: '500' },
    ]);
  });

  it('公開の文書にあるパラメーターだけを使う (内部用を足さない)', () => {
    const url = okUrl(
      buildOrderLink(input({ chain: 'kaia', mode: 'standard', description: '秋のイベント物販' })),
    );
    expect([...url.searchParams.keys()].sort()).toEqual(
      ['chain', 'description', 'items', 'mode', 'order_id', 'to', 'token'].sort(),
    );
  });

  it('既定のチェーンとガスレスは URL を増やさない', () => {
    const url = okUrl(buildOrderLink(input()));
    expect([...url.searchParams.keys()].sort()).toEqual(['items', 'order_id', 'to', 'token'].sort());
  });

  it('ガスレスは利用料を受取額から引く: 1% が最低額を超える場合', () => {
    const result = buildOrderLink(input());
    expect(result).toMatchObject({ ok: true, total: '6500', fee: '65', receive: '6435' });
  });

  it('ガスレスは利用料を受取額から引く: 1% が最低額より小さい場合', () => {
    const result = buildOrderLink(input({ lines: [{ name: 'ステッカー', qty: '1', price: '100' }], shipping: '' }));
    expect(result).toMatchObject({ ok: true, total: '100', fee: '2', receive: '98' });
  });

  it('通常決済は利用料 0', () => {
    const result = buildOrderLink(input({ mode: 'standard' }));
    expect(result).toMatchObject({ ok: true, total: '6500', fee: '0', receive: '6500' });
  });

  it('利用料は /checkout の経路の判定に従う: relay が無効なら 0', () => {
    flags.relay = false;
    expect(buildOrderLink(input())).toMatchObject({ ok: true, fee: '0', receive: '6500' });
  });

  it('利用料は /checkout の経路の判定に従う: forwarder が無ければ 0', () => {
    flags.forwarder = false;
    expect(buildOrderLink(input())).toMatchObject({ ok: true, fee: '0', receive: '6500' });
  });

  it('利用料が 0 の経路では、少額を止めない', () => {
    flags.relay = false;
    const result = buildOrderLink(input({ lines: [{ name: 'ステッカー', qty: '1', price: '1' }], shipping: '' }));
    expect(result).toMatchObject({ ok: true, total: '1', receive: '1' });
  });

  it('上限を超えるリンクを作らない', () => {
    const at = (price: string, mode: 'gasless' | 'standard') =>
      buildOrderLink(input({ mode, lines: [{ name: '機材', qty: '1', price }], shipping: '' }));
    expect(at('50000', 'gasless').ok).toBe(true);
    expect(at('50001', 'gasless')).toEqual({ ok: false, error: 'tooLarge', maximum: '50000' });
    expect(at('1000000', 'standard').ok).toBe(true);
    expect(at('1000001', 'standard')).toEqual({ ok: false, error: 'tooLarge', maximum: '1000000' });
  });

  it('説明が読み直しで変わるならリンクを作らない', () => {
    expect(buildOrderLink(input({ description: 'a\u0007b' }))).toEqual({ ok: false, error: 'invalid' });
  });

  it('商品名の記号はリンクを壊さない', () => {
    const url = okUrl(buildOrderLink(input({ lines: [{ name: 'A:B,C', qty: '1', price: '500' }], shipping: '' })));
    const parsed = parseCheckoutParams(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.items[0].name).toBe('A:B,C');
  });

  it('空の行は無視し、送料が空または 0 なら送料の行を出さない', () => {
    for (const shipping of ['', '0', '0.0']) {
      const url = okUrl(
        buildOrderLink(input({ lines: [{ name: 'Tシャツ', qty: '1', price: '3000' }, { name: '', qty: '1', price: '' }], shipping })),
      );
      const parsed = parseCheckoutParams(url.searchParams);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.params.items).toHaveLength(1);
    }
  });

  it('入力の不足と不正は、どこを直すかを返す', () => {
    expect(buildOrderLink(input({ to: null }))).toEqual({ ok: false, error: 'receiver' });
    expect(buildOrderLink(input({ orderId: ' ' }))).toEqual({ ok: false, error: 'orderId' });
    expect(buildOrderLink(input({ orderId: 'x'.repeat(65) }))).toEqual({ ok: false, error: 'orderId' });
    expect(buildOrderLink(input({ lines: [{ name: '', qty: '1', price: '' }] }))).toEqual({ ok: false, error: 'noItems' });
    expect(buildOrderLink(input({ shipping: 'abc' }))).toEqual({ ok: false, error: 'shipping' });
    for (const line of [
      { name: '', qty: '1', price: '500' },
      { name: 'Tシャツ', qty: '1', price: '' },
      { name: 'Tシャツ', qty: '0', price: '500' },
      { name: 'Tシャツ', qty: '1000', price: '500' },
      { name: 'Tシャツ', qty: '1.5', price: '500' },
      { name: 'Tシャツ', qty: '1', price: '0' },
      { name: 'Tシャツ', qty: '1', price: '-5' },
      { name: 'x'.repeat(81), qty: '1', price: '500' },
    ]) {
      expect(buildOrderLink(input({ lines: [line] })), JSON.stringify(line)).toEqual({ ok: false, error: 'item' });
    }
  });

  it('明細は送料を含めて 10 行まで', () => {
    const line = { name: 'Tシャツ', qty: '1', price: '500' };
    expect(buildOrderLink(input({ lines: Array(9).fill(line) })).ok).toBe(true);
    expect(buildOrderLink(input({ lines: Array(10).fill(line) }))).toEqual({ ok: false, error: 'tooManyLines' });
  });

  it('合計が利用料以下ならリンクを作らない (/checkout が止める額を渡さない)', () => {
    const result = buildOrderLink(input({ lines: [{ name: 'ステッカー', qty: '1', price: '2' }], shipping: '' }));
    expect(result).toEqual({ ok: false, error: 'tooSmall', minimum: '2' });
  });
});

describe('orderLinkChains', () => {
  it('ガスレスを使えるチェーンだけを返す', () => {
    const chains = orderLinkChains(JPYC_CHAINS);
    expect(chains).toContain('polygon');
    expect(chains.every((slug) => isGaslessSupported(deploymentForSlug('jpyc', slug)))).toBe(true);
  });
});
