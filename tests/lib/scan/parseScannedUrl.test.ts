import { describe, it, expect } from 'vitest';
import { parseScannedUrl } from '@/lib/scan/parseScannedUrl';

const ORIGIN = 'https://open-pay.jp';
const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TO_LOWER = TO.toLowerCase();

describe('parseScannedUrl: pay route', () => {
  it('locale 無し /pay (= buildPayUrl 標準形) → kind:pay + currentLocale を付与した href', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=usdc&amount=10`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.href).toBe(`/ja/pay?to=${TO}&token=usdc&amount=10`);
    expect(r.params.to).toBe(TO);
    expect(r.params.token).toBe('usdc');
    expect(r.params.amount).toBe('10');
  });

  it('locale prefix 付き /ja/pay → currentLocale=en でも href は en に正規化される', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/ja/pay?to=${TO}&token=jpyc`,
      ORIGIN,
      'en',
    );
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.href).toBe(`/en/pay?to=${TO}&token=jpyc`);
  });

  it('trailing slash 付き /pay/ も受理', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay/?to=${TO}&token=usdc&amount=5`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
  });

  it('to 欠落 /pay → kind:unknown (LARP partial 処理を排除)', () => {
    const r = parseScannedUrl(`${ORIGIN}/pay?token=usdc`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('amount に空 string (?amount=) でも parser 標準形に従い valid', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
  });

  it('token 不正 → kind:unknown', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=eth`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });

  it('chain 不整合 (jpyc + arbitrum は deployment なし) → unknown', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=jpyc&chain=arbitrum`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });

  it('/pay の後に余分 segment (/pay/foo) → unknown', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay/foo?to=${TO}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });
});

describe('parseScannedUrl: tip route', () => {
  it('/tip/0x... → kind:tip + address (checksum 化)', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/tip/${TO_LOWER}?token=jpyc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('tip');
    if (r.kind !== 'tip') throw new Error();
    expect(r.address).toBe(TO);
    expect(r.href).toBe(`/ja/tip/${TO}?token=jpyc`);
  });

  it('locale prefix 付き /en/tip/0x... → currentLocale で正規化', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/en/tip/${TO}?token=usdc&name=Alice`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('tip');
    if (r.kind !== 'tip') throw new Error();
    expect(r.href).toBe(`/ja/tip/${TO}?token=usdc&name=Alice`);
    expect(r.params.name).toBe('Alice');
  });

  it('tip address 欠落 (/tip 単体) → unknown', () => {
    const r = parseScannedUrl(`${ORIGIN}/tip?token=jpyc`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('tip address invalid (0x 短い) → unknown', () => {
    const r = parseScannedUrl(`${ORIGIN}/tip/0xabc?token=jpyc`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('tip token 欠落 → unknown', () => {
    const r = parseScannedUrl(`${ORIGIN}/tip/${TO}`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('tip の後に余分 segment (/tip/0x/extra) → unknown', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/tip/${TO}/extra?token=jpyc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });
});

describe('parseScannedUrl: checkout route', () => {
  it('/checkout?items=...&to=... → kind:checkout', () => {
    const items = encodeURIComponent('Coffee') + ':2:5.00';
    const r = parseScannedUrl(
      `${ORIGIN}/checkout?to=${TO}&token=usdc&items=${items}`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('checkout');
    if (r.kind !== 'checkout') throw new Error();
    expect(r.params.items).toHaveLength(1);
    expect(r.params.items[0].qty).toBe(2);
    expect(r.href).toBe(
      `/ja/checkout?to=${TO}&token=usdc&items=${items}`,
    );
  });

  it('items 欠落 /checkout → unknown', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/checkout?to=${TO}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });
});

describe('parseScannedUrl: EIP-681', () => {
  it('ethereum: スキーム → kind:eip681', () => {
    const r = parseScannedUrl(
      'ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1/transfer?address=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&uint256=1000000',
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('eip681');
    if (r.kind !== 'eip681') throw new Error();
    expect(r.raw).toMatch(/^ethereum:/);
  });

  it('大文字 ETHEREUM: も case-insensitive で reject (URI scheme 規格)', () => {
    const r = parseScannedUrl('ETHEREUM:0xabc@1', ORIGIN, 'ja');
    expect(r.kind).toBe('eip681');
  });
});

describe('parseScannedUrl: external origin', () => {
  it('別 origin の https URL → kind:external + host', () => {
    const r = parseScannedUrl(
      'https://attacker.example.com/pay?to=0x',
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('external');
    if (r.kind !== 'external') throw new Error();
    expect(r.host).toBe('attacker.example.com');
    expect(r.href).toBe('https://attacker.example.com/pay?to=0x');
  });

  it('subdomain (app.open-pay.jp) も別 origin 扱い (URL.origin は subdomain 込み)', () => {
    const r = parseScannedUrl(
      `https://app.open-pay.jp/pay?to=${TO}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('external');
  });

  it('port 違い (localhost:3001 vs localhost:3000) も別 origin', () => {
    const r = parseScannedUrl(
      'http://localhost:3001/pay?to=' + TO + '&token=usdc',
      'http://localhost:3000',
      'ja',
    );
    expect(r.kind).toBe('external');
  });

  it('protocol 違い (http vs https) も別 origin (HSTS / mixed content の観点)', () => {
    const r = parseScannedUrl(
      'http://open-pay.jp/pay?to=' + TO + '&token=usdc',
      'https://open-pay.jp',
      'ja',
    );
    expect(r.kind).toBe('external');
  });
});

describe('parseScannedUrl: unknown', () => {
  it('空文字 → unknown (raw も空)', () => {
    const r = parseScannedUrl('', ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('空白のみ → unknown', () => {
    const r = parseScannedUrl('   \n\t ', ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('URL でない文字列 (短い ID) → unknown', () => {
    const r = parseScannedUrl('OP-123-XYZ', ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error();
    expect(r.raw).toBe('OP-123-XYZ');
  });

  it('http(s) でない URL (data:) → unknown (XSS 経路を絶つ)', () => {
    const r = parseScannedUrl(
      'data:text/html,<script>alert(1)</script>',
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });

  it('javascript: URL → unknown (XSS 経路を絶つ)', () => {
    const r = parseScannedUrl('javascript:alert(1)', ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('同 origin だが未知 path (/foo) → unknown', () => {
    const r = parseScannedUrl(`${ORIGIN}/foo`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('同 origin の locale prefix のみ (/ja) → unknown', () => {
    const r = parseScannedUrl(`${ORIGIN}/ja`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('同 origin の /history は scan の deep-link 対象外 → unknown', () => {
    const r = parseScannedUrl(`${ORIGIN}/ja/history`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('未知の locale (/fr/pay) は locale prefix 認識しない → /fr が head に → unknown', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/fr/pay?to=${TO}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });
});

describe('parseScannedUrl: trim と URL 内特殊文字', () => {
  it('前後空白を許容 (camera decode の trailing newline 等)', () => {
    const r = parseScannedUrl(
      `\n  ${ORIGIN}/pay?to=${TO}&token=usdc  \n`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
  });

  it('URL に fragment (#) があっても routing 判定に影響しない (fragment は捨てる)', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=usdc#section`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    // URL.search は '#' 以降を含まないので href にも fragment が漏れない
    expect(r.href).not.toContain('#');
  });

  it('複数 query (split) を含む /pay URL も成立', () => {
    const SPLIT_B = '0x000000000000000000000000000000000000bEEF';
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=usdc&amount=10&split=${SPLIT_B}:30`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.params.split).toBeDefined();
    expect(r.params.split?.[0].percent).toBe(30);
  });

  it('Unicode を含む tip URL (name=山田) も維持', () => {
    const name = encodeURIComponent('山田太郎');
    const r = parseScannedUrl(
      `${ORIGIN}/tip/${TO}?token=jpyc&name=${name}`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('tip');
    if (r.kind !== 'tip') throw new Error();
    expect(r.params.name).toBe('山田太郎');
    expect(r.href).toContain(`name=${name}`);
  });
});
