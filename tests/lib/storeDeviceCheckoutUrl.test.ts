import { describe, it, expect, vi, beforeEach } from 'vitest';

const hold = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableStoreGasWallet() {
        return hold.enabled;
      },
    },
  };
});

import { buildCheckoutPath, parseCheckoutParams, type CheckoutItem } from '@/lib/url';

const TO = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const HS = 'AbCdEfGhIjKlMnOpQrStUv';
const items: CheckoutItem[] = [{ name: 'コーヒー', qty: 2, price: '500' }];
const base = { to: TO, token: 'jpyc' as const, gas: 'customer' as const, mode: 'gasless' as const, items };

function parse(path: string, extra = '') {
  return parseCheckoutParams(new URLSearchParams(`${path.split('?')[1]}${extra}`));
}

describe('/checkout の「お店の端末で送る」(submit=store&hs=)', () => {
  beforeEach(() => {
    hold.enabled = true;
  });

  it('往復: submit と hs が残り、通常の項目もそのまま', () => {
    const path = buildCheckoutPath({ ...base, submit: 'store', handoffId: HS });
    expect(path).toContain('submit=store');
    expect(path).toContain(`hs=${HS}`);
    const r = parse(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.submit).toBe('store');
    expect(r.params.handoffId).toBe(HS);
    expect(r.params.items).toEqual(items);
  });

  it('submit が無い URL は従来どおり (submit/hs を持たない)', () => {
    const r = parse(buildCheckoutPath(base));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.submit).toBeUndefined();
    expect(r.params.handoffId).toBeUndefined();
  });

  it.each([
    ['flag OFF', () => (hold.enabled = false), ''],
    ['未知の submit 値', () => {}, '&submit=relay'],
    ['hs が無い', () => {}, '&submit=store'],
    ['hs の形が違う', () => {}, '&submit=store&hs=short'],
    ['モバイル注文の手数料つき', () => {}, `&submit=store&hs=${HS}&fee_kind=storefront`],
    ['@handle の店舗束縛つき', () => {}, `&submit=store&hs=${HS}&store_handle=cafe`],
  ])('%s → 「この QR は使えません」で止める (通常の経路に倒さない)', (_, setup, extra) => {
    setup();
    const path = buildCheckoutPath(base);
    const r = parse(path, extra || `&submit=store&hs=${HS}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.urlError.code).toBe('storeDeviceUnavailable');
  });

  it('JPYC 以外・対象外のチェーンは止める', () => {
    const usdc = buildCheckoutPath({ ...base, token: 'usdc', chain: 'base', items: [{ name: 'x', qty: 1, price: '1' }] });
    expect(parse(usdc, `&submit=store&hs=${HS}`)).toMatchObject({ ok: false, urlError: { code: 'storeDeviceUnavailable' } });
    const kaia = buildCheckoutPath({ ...base, chain: 'kaia' });
    expect(parse(kaia, `&submit=store&hs=${HS}`)).toMatchObject({ ok: false, urlError: { code: 'storeDeviceUnavailable' } });
  });

  it('build は hs の形が違えば submit を出さない', () => {
    const path = buildCheckoutPath({ ...base, submit: 'store', handoffId: 'bad' });
    expect(path).not.toContain('submit=');
    expect(path).not.toContain('hs=');
  });
});
