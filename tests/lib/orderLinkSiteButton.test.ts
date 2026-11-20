// 「サイトにボタンを設置」の HTML (lib/orderLinkSiteButton.ts) の検査:
// - 単一の <a> だけ (script・iframe・class・外部 CSS なし)・target="_blank" rel="noopener"
// - URL と文字は実体参照化され、& " < > を含む値でも HTML が壊れず、取り出した href が元の URL と一致する
// - 見た目に効く値をすべて inline の style に書く (貼ったサイトの CSS に左右されにくい)
// - 注文リンク (buildOrderLink) の URL をそのまま使い、/checkout の parser で読むと同じ明細と合計になる

import { describe, expect, it, vi } from 'vitest';
import { escapeHtmlAttr } from '@/lib/htmlEscape';
import { buildOrderLink, type OrderLinkInput } from '@/lib/orderLink';
import { ORDER_LINK_SITE_BUTTON_STYLE, orderLinkSiteButtonHtml } from '@/lib/orderLinkSiteButton';
import { calcCheckoutPayable, parseCheckoutParams } from '@/lib/url/checkout';

vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return {
    ...actual,
    jpycForwarderFor: () => '0x0F4560a777415580F0680F8B56a79B0022C6B848',
    relayGasFeeValue: () => 2n * 10n ** 18n,
  };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, recoverFeeBps: 100, enableJpycEip3009: true } };
});

const TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const LABEL = 'JPYCで支払う';

/** 貼られた HTML を、サイトのページと同じくブラウザの parser で読む。 */
function parse(html: string): HTMLTemplateElement['content'] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function onlyAnchor(html: string): HTMLAnchorElement {
  const content = parse(html);
  const elements = content.querySelectorAll('*');
  expect(elements).toHaveLength(1);
  expect(content.childNodes).toHaveLength(1);
  const anchor = elements[0];
  expect(anchor.tagName).toBe('A');
  return anchor as HTMLAnchorElement;
}

function reusableInput(patch: Partial<OrderLinkInput> = {}): OrderLinkInput {
  return {
    origin: 'https://open-pay.jp',
    to: TO,
    chains: ['polygon'],
    mode: 'gasless',
    reusable: true,
    orderId: '',
    contact: null,
    description: '',
    storeName: '',
    lines: [{ name: 'Tシャツ M', qty: '2', price: '3000' }],
    shipping: '500',
    shippingLabel: '送料',
    ...patch,
  };
}

describe('orderLinkSiteButtonHtml', () => {
  it('単一の <a> で、属性は href・target="_blank"・rel="noopener"・style だけ (class・script・iframe・外部 CSS なし)', () => {
    const url = 'https://open-pay.jp/checkout?to=0x52d4901142e2B5680027da5EB47C86CB02a3cA81&token=jpyc&items=a&ship=ask';
    const html = orderLinkSiteButtonHtml(url, LABEL);
    const anchor = onlyAnchor(html);
    expect(anchor.getAttributeNames().sort()).toEqual(['href', 'rel', 'style', 'target']);
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener');
    expect(anchor.getAttribute('href')).toBe(url);
    expect(anchor.textContent).toBe(LABEL);
    expect(anchor.children).toHaveLength(0);
    expect(html).not.toMatch(/<script|<iframe|<style|<link|class=|javascript:|\son\w+=/i);
    // 1 行 (貼る先のエディタが改行を <br> に変えても、タグの中で割れない)。
    expect(html).not.toContain('\n');
    // 生の & は URL の引数の区切りでも残さない (属性の値として正しい HTML)。
    expect(html).not.toMatch(/&(?!amp;|quot;|lt;|gt;)/);
  });

  it('& " < > を含む URL と文字でも HTML が壊れず、取り出した href と文字が元と一致する', () => {
    const url = 'https://open-pay.jp/checkout?a=1&b="><script>alert(1)</script>&c=<i>&d=\'x\'';
    const label = 'A&B <b>"払う"</b>';
    const html = orderLinkSiteButtonHtml(url, label);
    const anchor = onlyAnchor(html);
    expect(anchor.getAttribute('href')).toBe(url);
    expect(anchor.textContent).toBe(label);
    expect(anchor.getAttributeNames().sort()).toEqual(['href', 'rel', 'style', 'target']);
  });

  it('見た目に効く値をすべて inline の style に書く (主ボタンの色・system-ui の書体・押しやすい高さ)', () => {
    expect(ORDER_LINK_SITE_BUTTON_STYLE).not.toContain('"');
    const anchor = onlyAnchor(orderLinkSiteButtonHtml('https://open-pay.jp/checkout?a=1', LABEL));
    const { style } = anchor;
    expect(style.display).toBe('inline-block');
    expect(style.minHeight).toBe('44px');
    expect(style.padding).toBe('12px 24px');
    expect(style.borderRadius).toBe('12px');
    expect(style.background).toMatch(/^(#1e40af|rgb\(30, 64, 175\))$/);
    expect(style.color).toMatch(/^(#ffffff|rgb\(255, 255, 255\))$/);
    expect(style.fontFamily.startsWith('system-ui')).toBe(true);
    expect(style.fontSize).toBe('16px');
    expect(style.fontWeight).toBe('700');
    expect(style.lineHeight).toBe('20px');
    expect(style.textDecoration).toBe('none');
    // 和文のサイトの字間・詰め組 (palt) を引き継がない (見本と貼ったボタンで文字の幅をそろえる)。
    expect(style.letterSpacing).toBe('normal');
    expect(ORDER_LINK_SITE_BUTTON_STYLE.split(';')).toContain('font-feature-settings:normal');
  });

  it('チップの埋め込みと同じ実体参照化 (& " < > を変え、\' は変えない)', () => {
    expect(escapeHtmlAttr(`a&b"c<d>e'f`)).toBe(`a&amp;b&quot;c&lt;d&gt;e'f`);
  });

  it('何度でも使える注文リンクの URL をそのまま使い、/checkout の parser で読むと同じ明細と合計になる (店名・商品名・説明に & " < >)', () => {
    const result = buildOrderLink(
      reusableInput({
        storeName: 'A&B "工房" <shop>',
        description: '"秋" & <冬> の販売',
        lines: [
          { name: 'T&C <M> "red"', qty: '2', price: '3000' },
          { name: "カップ 'L' & 皿", qty: '1', price: '1200' },
        ],
      }),
    );
    if (!result.ok) throw new Error(`link not built: ${result.error}`);
    const anchor = onlyAnchor(orderLinkSiteButtonHtml(result.url, LABEL));
    const href = anchor.getAttribute('href') ?? '';
    expect(href).toBe(result.url);

    const parsed = parseCheckoutParams(new URL(href).searchParams);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.params.items).toEqual([
      { name: 'T&C <M> "red"', qty: 2, price: '3000' },
      { name: "カップ 'L' & 皿", qty: 1, price: '1200' },
      { name: '送料', qty: 1, price: '500' },
    ]);
    expect(parsed.params.storeName).toBe('A&B "工房" <shop>');
    expect(parsed.params.description).toBe('"秋" & <冬> の販売');
    expect(parsed.params.ship).toBe('ask');
    expect(parsed.params.orderId).toBeUndefined();
    // 3,000 × 2 + 1,200 + 送料 500 = 7,700
    expect(calcCheckoutPayable(parsed.params, 18)).toBe(7_700n * 10n ** 18n);
    expect(result.total).toBe('7700');
  });
});
