import { describe, it, expect } from 'vitest';
import { parseScannedUrl } from '@/lib/scan/parseScannedUrl';
import {
  buildCheckoutUrl,
  buildPayUrl,
  buildTipUrl,
  parsePayParams,
  parseTipParams,
  parseCheckoutParams,
} from '@/lib/url';
import { encodeOrderConfig, type MobileOrderConfig } from '@/lib/mobileOrder';

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
  it('/tip/0x... → kind:tip + params.to が checksum 化', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/tip/${TO_LOWER}?token=jpyc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('tip');
    if (r.kind !== 'tip') throw new Error();
    expect(r.params.to).toBe(TO);
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

// --- 実 builder (lib/url.ts) との往復統合 ------------------------------------
// builder が出力する URL を parseScannedUrl で読み戻し、両者で意味が一貫している
// ことを保証する。これにより builder/parser が片方だけ仕様変更されて scanner が
// 静かに壊れる regression を構造的に検知する。

describe('parseScannedUrl: buildPayUrl 往復統合', () => {
  it('全 option (chain + gas=merchant 不可 mode=standard + split) の URL を読み戻せる', () => {
    const SPLIT_B = '0x000000000000000000000000000000000000bEEF';
    const url = buildPayUrl(ORIGIN, {
      to: TO,
      token: 'usdc',
      chain: 'arbitrum',
      gas: 'customer', // standard では URL に出ない (parser がデフォルト)
      amount: '12.345',
      mode: 'standard',
      split: [{ to: SPLIT_B, percent: 25 }],
    });
    const r = parseScannedUrl(url, ORIGIN, 'ja');
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.params.to).toBe(TO);
    expect(r.params.token).toBe('usdc');
    expect(r.params.chain).toBe('arbitrum');
    expect(r.params.amount).toBe('12.345');
    expect(r.params.mode).toBe('standard');
    expect(r.params.split?.[0].to).toBe(SPLIT_B);
    expect(r.params.split?.[0].percent).toBe(25);
  });

  it('gasless + gas=merchant の URL → parser 結果が merchant 維持', () => {
    const url = buildPayUrl(ORIGIN, {
      to: TO,
      token: 'jpyc',
      chain: 'polygon',
      gas: 'merchant',
      amount: '1000',
      mode: 'gasless',
    });
    expect(url).toContain('gas=merchant');
    const r = parseScannedUrl(url, ORIGIN, 'ja');
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.params.gas).toBe('merchant');
    expect(r.params.mode).toBe('gasless');
  });

  it('href を /pay URL として 2 回目に流す (recursive parse 不可で kind=unknown)', () => {
    // 再 parse すると href は path のみ (origin なし) なので URL.canParse は false。
    // scanner が PaymentForm に navigate した後の URL を再スキャンしても何も起きない
    // ことを保証 (誤動作で同じ画面に永久ループする regression 防御)。
    const r1 = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=usdc&amount=1`,
      ORIGIN,
      'ja',
    );
    expect(r1.kind).toBe('pay');
    if (r1.kind !== 'pay') throw new Error();
    const r2 = parseScannedUrl(r1.href, ORIGIN, 'ja');
    expect(r2.kind).toBe('unknown');
  });
});

describe('parseScannedUrl: buildTipUrl 往復統合', () => {
  it('全 option (color + preset + name + message + thanks + thanksUrl + webhook)', () => {
    const url = buildTipUrl(ORIGIN, {
      to: TO,
      token: 'jpyc',
      chain: 'polygon',
      name: 'クリエイター',
      message: 'コーヒー一杯ありがとう',
      color: '#ff0080',
      presets: ['100', '500', '1000'],
      thanks: 'Thanks!',
      thanksUrl: 'https://example.com/thanks',
      webhook: 'https://example.com/hook',
    });
    const r = parseScannedUrl(url, ORIGIN, 'en');
    expect(r.kind).toBe('tip');
    if (r.kind !== 'tip') throw new Error();
    expect(r.params.to).toBe(TO);
    expect(r.params.token).toBe('jpyc');
    expect(r.params.name).toBe('クリエイター');
    expect(r.params.message).toBe('コーヒー一杯ありがとう');
    expect(r.params.color).toBe('#ff0080');
    expect(r.params.presets).toEqual(['100', '500', '1000']);
    expect(r.params.thanks).toBe('Thanks!');
    expect(r.params.thanksUrl).toBe('https://example.com/thanks');
    expect(r.params.webhook).toBe('https://example.com/hook');
    // href は en で正規化
    expect(r.href).toMatch(/^\/en\/tip\/0x/);
  });
});

describe('parseScannedUrl: buildCheckoutUrl 往復統合', () => {
  it('複数 item + order_id + email + success/cancel URL + webhook + standard mode', () => {
    const url = buildCheckoutUrl(ORIGIN, {
      to: TO,
      token: 'usdc',
      chain: 'base',
      gas: 'customer',
      mode: 'standard',
      items: [
        { name: 'Coffee', qty: 2, price: '4.50' },
        { name: 'Croissant', qty: 1, price: '6.00' },
      ],
      orderId: 'ORDER-42',
      description: 'morning order',
      customerEmail: 'a@example.com',
      successUrl: 'https://shop.example.com/thanks',
      cancelUrl: 'https://shop.example.com/cart',
      webhook: 'https://shop.example.com/hook',
    });
    const r = parseScannedUrl(url, ORIGIN, 'ja');
    expect(r.kind).toBe('checkout');
    if (r.kind !== 'checkout') throw new Error();
    expect(r.params.items).toHaveLength(2);
    expect(r.params.items[0].name).toBe('Coffee');
    expect(r.params.items[0].qty).toBe(2);
    expect(r.params.items[1].name).toBe('Croissant');
    expect(r.params.items[1].price).toBe('6.00');
    expect(r.params.orderId).toBe('ORDER-42');
    expect(r.params.customerEmail).toBe('a@example.com');
    expect(r.params.successUrl).toBe('https://shop.example.com/thanks');
    expect(r.params.cancelUrl).toBe('https://shop.example.com/cart');
    expect(r.params.webhook).toBe('https://shop.example.com/hook');
    expect(r.params.mode).toBe('standard');
  });

  it('parseScannedUrl が出した href は再度 parser に通っても等価 params を生む', () => {
    // builder → scanner → href → 既存 parser の系全体で entropy が増えないことの確認。
    // href は path + search のみ (origin なし) なので URLSearchParams を直接組む。
    const items = encodeURIComponent('Coffee') + ':3:7.00';
    const r = parseScannedUrl(
      `${ORIGIN}/checkout?to=${TO}&token=usdc&items=${items}&order_id=Z-1`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('checkout');
    if (r.kind !== 'checkout') throw new Error();
    const search = new URLSearchParams(r.href.split('?')[1] ?? '');
    const re = parseCheckoutParams({ get: (k) => search.get(k) });
    expect(re.ok).toBe(true);
    if (!re.ok) throw new Error();
    expect(re.params.items[0].qty).toBe(3);
    expect(re.params.items[0].price).toBe('7.00');
  });
});

// --- URL 境界条件 ------------------------------------------------------------

describe('parseScannedUrl: URL 境界条件', () => {
  it('port 違い: localhost:3001 (e2e dev) のような非標準 port を持つ同 host も別 origin', () => {
    // URL.origin は protocol + host + port を含む。dev (3000) と試験 server (3001) は
    // 別 origin と判定されることを担保 (scanner の同 origin guard の根拠)。
    const r = parseScannedUrl(
      `http://localhost:3001/pay?to=${TO}&token=usdc`,
      'http://localhost:3000',
      'ja',
    );
    expect(r.kind).toBe('external');
  });

  it('userinfo (https://user:pass@host) は URL.origin に含まれない (RFC 3986) → 同 origin 判定が通る', () => {
    // userinfo を含む URL でも origin 比較は host + port + scheme のみ。
    // 攻撃者が「username に open-pay.jp を入れる」ような mimicry には URL.host が正しい host
    // を返すので fool されない。
    const r = parseScannedUrl(
      `https://attacker.example.com@open-pay.jp/pay?to=${TO}&token=usdc&amount=1`,
      'https://open-pay.jp',
      'ja',
    );
    expect(r.kind).toBe('pay');
  });

  it('userinfo 攻撃 (https://open-pay.jp@attacker.example.com/...) は別 origin として弾く', () => {
    // 上の逆: open-pay.jp を userinfo に置いて attacker host を本体にする古典的フィッシング。
    // URL.host = "attacker.example.com" になり origin 不一致で external に落ちる。
    const r = parseScannedUrl(
      `https://open-pay.jp@attacker.example.com/pay?to=${TO}&token=usdc`,
      'https://open-pay.jp',
      'ja',
    );
    expect(r.kind).toBe('external');
    if (r.kind !== 'external') throw new Error();
    expect(r.host).toBe('attacker.example.com');
  });

  it('IDN host (Punycode 形) も URL として扱われ別 origin', () => {
    const r = parseScannedUrl(
      `https://xn--open-pay-bx9b.jp/pay?to=${TO}&token=usdc`,
      'https://open-pay.jp',
      'ja',
    );
    expect(r.kind).toBe('external');
  });

  it('長大 URL (~4 KB) でも parse 失敗しない', () => {
    // long 文字列を name に持つ tip URL。truncate される (60 文字) ことも合わせて確認。
    const longName = encodeURIComponent('x'.repeat(4000));
    const r = parseScannedUrl(
      `${ORIGIN}/tip/${TO}?token=jpyc&name=${longName}`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('tip');
    if (r.kind !== 'tip') throw new Error();
    // 60 文字上限 (sanitizeText) で truncate
    expect(r.params.name).toBe('x'.repeat(60));
  });

  it('hash fragment (#section) は URL.search に含まれず href からも消える', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=usdc#receipt`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.href).not.toContain('#');
    expect(r.href).not.toContain('receipt');
  });

  it('同一 query key の重複 (?to=A&to=B) は URLSearchParams.get で first を採用', () => {
    const TO_B = '0x000000000000000000000000000000000000bEEF';
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&to=${TO_B}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.params.to).toBe(TO);
  });

  it('scan が他の /scan URL を読み戻すと unknown (recursion なし)', () => {
    const r = parseScannedUrl(`${ORIGIN}/ja/scan`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('/history /terms /privacy などの未対応 route は unknown', () => {
    for (const route of ['history', 'terms', 'privacy', 'disclaimer', 'tokutei']) {
      const r = parseScannedUrl(`${ORIGIN}/ja/${route}`, ORIGIN, 'ja');
      expect(r.kind).toBe('unknown');
    }
  });

  it('URL に trailing slash 付き locale (/ja/) → /ja の path-only と等価扱い (unknown)', () => {
    const r = parseScannedUrl(`${ORIGIN}/ja/`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('locale prefix の大文字 (/JA/pay) は LOCALES と一致しないので unknown', () => {
    // isLocale は LOCALES = ['ja', 'en'] の strict 比較 (case sensitive)。
    const r = parseScannedUrl(
      `${ORIGIN}/JA/pay?to=${TO}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });

  it('/pay/0xABC (locale 無し + tail 付き) は unknown (segment overrun)', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay/0xABC?to=${TO}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('unknown');
  });

  it('pathname=/ (root) → unknown (decomposePath が trimmed=空で null)', () => {
    const r = parseScannedUrl(`${ORIGIN}/`, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('pathname=空 (https://host のみ) → unknown', () => {
    const r = parseScannedUrl(ORIGIN, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
  });

  it('blob: / about: などの稀 scheme も unknown', () => {
    expect(parseScannedUrl('blob:https://open-pay.jp/abc', ORIGIN, 'ja').kind).toBe(
      'unknown',
    );
    expect(parseScannedUrl('about:blank', ORIGIN, 'ja').kind).toBe('unknown');
    expect(parseScannedUrl('file:///etc/passwd', ORIGIN, 'ja').kind).toBe('unknown');
  });

  it('currentLocale が ja のとき path locale が en でも href は ja に正規化', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/en/pay?to=${TO}&token=usdc`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.href.startsWith('/ja/pay')).toBe(true);
  });

  it('pay の amount=0 は parser 側で受理されない (Number(amount) > 0 必須相当) → 実 parser 挙動で kind 判定', () => {
    // 実 parser (parsePayParams) は amount を valid なら入れる方針。amount=0 が
    // parser で reject されるか受理されるかは lib/url.ts の仕様に従う。
    // ここでは「scanner の判定が parser に従う」ことを assert する (drift 検知)。
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=usdc&amount=0`,
      ORIGIN,
      'ja',
    );
    // parsePayParams は amount を「空でなければ受理」する仕様なので 0 でも kind=pay。
    // この test は仕様の SoT を固定する意図 (UI 側 (PaymentForm) で 0 は弾く)。
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.params.amount).toBe('0');
  });

  it('parser が unknown へ落とした text は raw 文字列が input と同一 (truncate なし)', () => {
    const malformed = `${ORIGIN}/pay?token=usdc&chain=arbitrum`; // to 欠落
    const r = parseScannedUrl(malformed, ORIGIN, 'ja');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error();
    expect(r.raw).toBe(malformed);
  });
});

// --- 仕様の SoT 確認: pay の direct → standard alias を scanner も追従 ----------

describe('parseScannedUrl: legacy alias', () => {
  it('mode=direct (旧名) を読むと params.mode は standard に正規化される', () => {
    const r = parseScannedUrl(
      `${ORIGIN}/pay?to=${TO}&token=usdc&amount=10&mode=direct`,
      ORIGIN,
      'ja',
    );
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    expect(r.params.mode).toBe('standard');
  });
});

// --- 並行 parse (純粋関数なので副作用なし、保険として) -----------------------

describe('parseScannedUrl: 並行実行の純粋性', () => {
  it('同じ origin / locale で複数 URL を並行 parse しても結果が混線しない', async () => {
    // pure 関数だが、内部で URL / URLSearchParams を使うため Spec/jsdom の grid を確認。
    const urls = Array.from({ length: 50 }, (_, i) => {
      const addr = `0x${i.toString(16).padStart(40, '0')}`;
      return `${ORIGIN}/pay?to=${addr}&token=usdc&amount=${i + 1}`;
    });
    const results = await Promise.all(
      urls.map((u) => Promise.resolve(parseScannedUrl(u, ORIGIN, 'ja'))),
    );
    results.forEach((r, i) => {
      // address は viem.getAddress による checksum 形式なので大文字小文字混合。
      // i=0 のときは 0x000…000 (chain 別 deployment なし) で unknown に落ちないかは
      // hasDeployment(usdc, 'base'=default) は base 含むので OK、address 形式は valid。
      expect(r.kind).toBe('pay');
      if (r.kind !== 'pay') throw new Error();
      expect(r.params.amount).toBe(String(i + 1));
    });
  });
});

// --- 実 parser との data 等価性 (LARP 防御の意図確認) -------------------------

describe('parseScannedUrl: 実 parser data の data 等価性', () => {
  it('href の query を既存 parsePayParams に直接通しても同じ PayParams が出る', () => {
    // 「scanner の params と PaymentForm の params が一致する」ことの保証。
    // 同じ search を 2 つの経路 (scanner→params, search→parsePayParams) で評価し
    // data が一致することを assert する。
    const url = `${ORIGIN}/pay?to=${TO}&token=usdc&amount=10&mode=standard`;
    const r = parseScannedUrl(url, ORIGIN, 'ja');
    expect(r.kind).toBe('pay');
    if (r.kind !== 'pay') throw new Error();
    const search = new URLSearchParams(r.href.split('?')[1] ?? '');
    const direct = parsePayParams({ get: (k) => search.get(k) });
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error();
    expect(direct.params).toEqual(r.params);
  });

  it('tip も同じ等価性が成り立つ', () => {
    const url = `${ORIGIN}/tip/${TO}?token=jpyc&name=Alice`;
    const r = parseScannedUrl(url, ORIGIN, 'ja');
    expect(r.kind).toBe('tip');
    if (r.kind !== 'tip') throw new Error();
    const [path, query] = r.href.split('?');
    const addr = path.split('/').slice(-1)[0]; // 0x... の checksum 形
    const sp = new URLSearchParams(query ?? '');
    const direct = parseTipParams(addr, { get: (k) => sp.get(k) });
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error();
    expect(direct.params).toEqual(r.params);
  });
});

// ── @handle (固定店舗 / プロフ) ─────────────────────────────────────────
// enableHandles ON のとき同 origin /@handle を handle として遷移可能にする。形式/予約語は
// decomposePath で検証 (存在確認はしない=純関数)。flag OFF は unknown (404 遷移回避)。
const HANDLES_ON = { enableHandles: true } as const;

describe('parseScannedUrl: @handle route', () => {
  it('/@shop (flag ON) → kind:handle + /{currentLocale}/@shop', () => {
    const r = parseScannedUrl(`${ORIGIN}/@openpay_test`, ORIGIN, 'ja', HANDLES_ON);
    expect(r.kind).toBe('handle');
    if (r.kind !== 'handle') throw new Error();
    expect(r.href).toBe('/ja/@openpay_test');
    expect(r.handle).toBe('openpay_test');
  });

  it('locale prefix 付き /ja/@shop → currentLocale=en で href は en に正規化', () => {
    const r = parseScannedUrl(`${ORIGIN}/ja/@shop`, ORIGIN, 'en', HANDLES_ON);
    expect(r.kind).toBe('handle');
    if (r.kind !== 'handle') throw new Error();
    expect(r.href).toBe('/en/@shop');
  });

  it('%40 エンコード /%40shop も handle として受理', () => {
    const r = parseScannedUrl(`${ORIGIN}/%40shop`, ORIGIN, 'ja', HANDLES_ON);
    expect(r.kind).toBe('handle');
    if (r.kind !== 'handle') throw new Error();
    expect(r.href).toBe('/ja/@shop');
  });

  it('trailing slash /@shop/ も受理', () => {
    const r = parseScannedUrl(`${ORIGIN}/@shop/`, ORIGIN, 'ja', HANDLES_ON);
    expect(r.kind).toBe('handle');
  });

  it('大文字は normalize で小文字化されて受理 (/@Shop → handle shop)', () => {
    const r = parseScannedUrl(`${ORIGIN}/@Shop`, ORIGIN, 'ja', HANDLES_ON);
    expect(r.kind).toBe('handle');
    if (r.kind !== 'handle') throw new Error();
    expect(r.handle).toBe('shop');
  });

  it('形式不正 (短すぎ /@ab・ハイフン /@bad-handle) → unknown', () => {
    expect(parseScannedUrl(`${ORIGIN}/@ab`, ORIGIN, 'ja', HANDLES_ON).kind).toBe('unknown');
    expect(parseScannedUrl(`${ORIGIN}/@bad-handle`, ORIGIN, 'ja', HANDLES_ON).kind).toBe('unknown');
  });

  it('予約語 = 全 route 名 (/@pay・/@admin・/@order・/@orders) → unknown (route shadow / 成りすまし防御)', () => {
    expect(parseScannedUrl(`${ORIGIN}/@pay`, ORIGIN, 'ja', HANDLES_ON).kind).toBe('unknown');
    expect(parseScannedUrl(`${ORIGIN}/@admin`, ORIGIN, 'ja', HANDLES_ON).kind).toBe('unknown');
    // /order route と同名の handle は予約済 (route を shadow させない)。
    expect(parseScannedUrl(`${ORIGIN}/@order`, ORIGIN, 'ja', HANDLES_ON).kind).toBe('unknown');
    expect(parseScannedUrl(`${ORIGIN}/@orders`, ORIGIN, 'ja', HANDLES_ON).kind).toBe('unknown');
  });

  it('余分 segment /@shop/extra → unknown', () => {
    expect(parseScannedUrl(`${ORIGIN}/@shop/extra`, ORIGIN, 'ja', HANDLES_ON).kind).toBe('unknown');
  });

  it('空 handle /@ → unknown', () => {
    expect(parseScannedUrl(`${ORIGIN}/@`, ORIGIN, 'ja', HANDLES_ON).kind).toBe('unknown');
  });

  it('flag OFF (既定 / 明示 false) → unknown (404 遷移回避)', () => {
    expect(parseScannedUrl(`${ORIGIN}/@shop`, ORIGIN, 'ja').kind).toBe('unknown');
    expect(
      parseScannedUrl(`${ORIGIN}/@shop`, ORIGIN, 'ja', { enableHandles: false }).kind,
    ).toBe('unknown');
  });

  it('別オリジンの /@shop は external (handle 化しない)', () => {
    const r = parseScannedUrl('https://evil.example/@shop', ORIGIN, 'ja', HANDLES_ON);
    expect(r.kind).toBe('external');
  });
});

// ── /order?s=… (モバイル注文) ───────────────────────────────────────────
// enableMobileOrder ON かつ s トークンが decodeOrderConfig を通る (= 全項目 valid) ときだけ
// order。token は attacker-controllable ゆえスキャン時点で厳格 decode する。
const ORDER_ON = { enableMobileOrder: true } as const;
const ORDER_CONFIG: MobileOrderConfig = {
  receiver: TO,
  chain: 'polygon',
  shopName: 'Test Shop',
  mode: 'storefront',
  feePayer: 'merchant',
  socials: [],
  menu: [{ id: 'a1', name: 'Coffee', price: '500' }],
};
const ORDER_TOKEN = encodeOrderConfig(ORDER_CONFIG);

describe('parseScannedUrl: /order route', () => {
  it('/order?s=<valid> (flag ON) → kind:order + /{currentLocale}/order?s=…', () => {
    const r = parseScannedUrl(`${ORIGIN}/order?s=${ORDER_TOKEN}`, ORIGIN, 'ja', ORDER_ON);
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') throw new Error();
    expect(r.href).toBe(`/ja/order?s=${ORDER_TOKEN}`);
  });

  it('locale prefix 付き /en/order?s=… → currentLocale=ja で href は ja に正規化', () => {
    const r = parseScannedUrl(`${ORIGIN}/en/order?s=${ORDER_TOKEN}`, ORIGIN, 'ja', ORDER_ON);
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') throw new Error();
    expect(r.href).toBe(`/ja/order?s=${ORDER_TOKEN}`);
  });

  it('trailing slash /order/?s=<valid> も受理', () => {
    const r = parseScannedUrl(`${ORIGIN}/order/?s=${ORDER_TOKEN}`, ORIGIN, 'ja', ORDER_ON);
    expect(r.kind).toBe('order');
  });

  it('壊れた s トークン → unknown (decodeOrderConfig=null)', () => {
    expect(parseScannedUrl(`${ORIGIN}/order?s=not-a-valid-token`, ORIGIN, 'ja', ORDER_ON).kind).toBe('unknown');
  });

  it('s 欠落 /order → unknown', () => {
    expect(parseScannedUrl(`${ORIGIN}/order`, ORIGIN, 'ja', ORDER_ON).kind).toBe('unknown');
  });

  it('flag OFF (既定) → unknown', () => {
    expect(parseScannedUrl(`${ORIGIN}/order?s=${ORDER_TOKEN}`, ORIGIN, 'ja').kind).toBe('unknown');
  });

  it('/order/status?t=… は対象外 (2 segment) → unknown', () => {
    expect(
      parseScannedUrl(`${ORIGIN}/order/status?t=abc`, ORIGIN, 'ja', {
        enableMobileOrder: true,
      }).kind,
    ).toBe('unknown');
  });
});
