import { describe, it, expect } from 'vitest';
import {
  buildTipOgModel,
  buildTipOgImageUrl,
  buildTipMeta,
  OG_DEFAULT_COLOR,
} from '@/lib/ogTipCard';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const sp = (q: string) => new URLSearchParams(q);

describe('buildTipOgModel', () => {
  it('default (no params) is the Japanese generic card', () => {
    const m = buildTipOgModel(sp(''));
    expect(m.locale).toBe('ja');
    expect(m.brand).toBe('OpenPay');
    expect(m.heading).toBe('チップを送る');
    expect(m.sub).toBe('JPYC / USDCで応援 · ガス不要');
    expect(m.footer).toBe('ウォレットで直接受け取り');
    expect(m.url).toBe('open-pay.jp');
    expect(m.color).toBe(OG_DEFAULT_COLOR);
  });

  it('locale=en uses English generic copy', () => {
    const m = buildTipOgModel(sp('locale=en'));
    expect(m.locale).toBe('en');
    expect(m.heading).toBe('Send a tip');
    expect(m.sub).toBe('Support with JPYC / USDC · no gas');
    expect(m.footer).toBe('Straight to your wallet');
  });

  it('valid tip (to+token=jpyc, ja): named heading + JPYC sub', () => {
    const m = buildTipOgModel(sp(`to=${ADDR}&token=jpyc&name=Alice`));
    expect(m.heading).toBe('Alice さんへ');
    expect(m.sub).toBe('JPYCで応援 · ガス不要');
  });

  it('valid tip (to+token=usdc, en): Tip heading + USDC sub', () => {
    const m = buildTipOgModel(sp(`locale=en&to=${ADDR}&token=usdc&name=Bob`));
    expect(m.heading).toBe('Tip Bob');
    expect(m.sub).toBe('Support with USDC · no gas');
  });

  it('native=polygon => POL label; not gasless so no gas claim', () => {
    const m = buildTipOgModel(sp(`to=${ADDR}&native=polygon&name=Alice`));
    expect(m.heading).toBe('Alice さんへ');
    expect(m.sub).toBe('POLで応援');
    expect(m.sub).not.toContain('ガス不要');
  });

  it('native=kaia (en): KAIA label, no gas claim', () => {
    const m = buildTipOgModel(sp(`locale=en&to=${ADDR}&native=kaia`));
    expect(m.sub).toBe('Support with KAIA');
    expect(m.sub).not.toContain('no gas');
  });

  it('name is only used for a valid tip (to + token/native); otherwise generic', () => {
    // 宛先 (to) 無しの直接アクセスは name を採らない (ブランド悪用防止)。
    expect(buildTipOgModel(sp('token=jpyc&name=Evil')).heading).toBe('チップを送る');
    // token も native も無ければ name 無視。
    expect(buildTipOgModel(sp(`to=${ADDR}&name=Evil`)).heading).toBe('チップを送る');
    // 不正 address は name 無視。
    expect(
      buildTipOgModel(sp('to=0xnope&token=jpyc&name=Evil')).heading,
    ).toBe('チップを送る');
  });

  it('long name is truncated to 20 with an ellipsis', () => {
    const long = 'a'.repeat(25);
    const m = buildTipOgModel(sp(`to=${ADDR}&token=jpyc&name=${long}`));
    expect(m.heading).toBe(`${'a'.repeat(20)}… さんへ`);
    expect(m.heading).not.toContain('a'.repeat(21));
  });

  it('control characters are stripped from name (NUL / BEL)', () => {
    // 制御文字はソースに literal で置かず runtime 生成 (source を純 ASCII に保つ)。
    const noisy = `A${String.fromCharCode(0)}B${String.fromCharCode(7)}C`;
    const m = buildTipOgModel(
      sp(`to=${ADDR}&token=jpyc&name=${encodeURIComponent(noisy)}`),
    );
    expect(m.heading).toBe('ABC さんへ');
  });

  it('whitespace-only name falls back to generic', () => {
    const m = buildTipOgModel(
      sp(`to=${ADDR}&token=jpyc&name=${encodeURIComponent('   ')}`),
    );
    expect(m.heading).toBe('チップを送る');
  });

  it('valid color is used; invalid / missing falls back to default', () => {
    expect(buildTipOgModel(sp(`to=${ADDR}&token=jpyc&color=%23ff8800`)).color).toBe(
      '#ff8800',
    );
    expect(buildTipOgModel(sp('color=red')).color).toBe(OG_DEFAULT_COLOR);
    expect(buildTipOgModel(sp('color=%23xyz')).color).toBe(OG_DEFAULT_COLOR);
  });

  it('invalid token falls back to the JPYC / USDC label', () => {
    expect(buildTipOgModel(sp(`to=${ADDR}&token=eth`)).sub).toBe(
      'JPYC / USDCで応援 · ガス不要',
    );
  });
});

describe('buildTipOgImageUrl', () => {
  it('always carries to/token/locale; name/color only when present', () => {
    const url = buildTipOgImageUrl(
      ADDR,
      { token: 'jpyc', name: 'Alice', color: '#ff8800' },
      'ja',
    );
    expect(url.startsWith('/api/og/tip?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('to')).toBe(ADDR);
    expect(q.get('token')).toBe('jpyc');
    expect(q.get('name')).toBe('Alice');
    expect(q.get('color')).toBe('#ff8800');
    expect(q.get('locale')).toBe('ja');
  });

  it('omits name/color when not provided', () => {
    const url = buildTipOgImageUrl(ADDR, { token: 'usdc' }, 'en');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.has('name')).toBe(false);
    expect(q.has('color')).toBe(false);
    expect(q.get('token')).toBe('usdc');
    expect(q.get('locale')).toBe('en');
  });

  it('carries native instead of token when native is given', () => {
    const url = buildTipOgImageUrl(ADDR, { native: 'polygon', name: 'Alice' }, 'ja');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('native')).toBe('polygon');
    expect(q.has('token')).toBe(false);
    expect(q.get('name')).toBe('Alice');
  });
});

describe('buildTipMeta', () => {
  it('named ja (gasless): name + token + gas-free claim', () => {
    const { title, description } = buildTipMeta(
      { name: 'Alice', tokenLabel: 'JPYC', gasless: true },
      'ja',
    );
    expect(title).toBe('Alice さんへチップ — OpenPay');
    expect(description).toContain('JPYC で Alice さんを応援');
    expect(description).toContain('ガス不要');
  });

  it('named en (gasless)', () => {
    const { title } = buildTipMeta(
      { name: 'Bob', tokenLabel: 'USDC', gasless: true },
      'en',
    );
    expect(title).toBe('Tip Bob — OpenPay');
  });

  it('nameless but known token => description uses that token (not both)', () => {
    const { description } = buildTipMeta(
      { tokenLabel: 'USDC', gasless: true },
      'ja',
    );
    expect(description).toContain('USDC');
    expect(description).not.toContain('JPYC / USDC');
  });

  it('native (gasless=false) does not claim gas-free', () => {
    const { description } = buildTipMeta(
      { name: 'Alice', tokenLabel: 'POL', gasless: false },
      'ja',
    );
    expect(description).toContain('POL');
    expect(description).not.toContain('ガス不要');
  });

  it('generic (facts=null) ja/en uses both-token generic copy', () => {
    expect(buildTipMeta(null, 'ja').title).toBe('OpenPay でチップを送る');
    expect(buildTipMeta(null, 'ja').description).toContain('JPYC / USDC');
    expect(buildTipMeta(null, 'en').title).toBe('Send a tip with OpenPay');
  });
});
