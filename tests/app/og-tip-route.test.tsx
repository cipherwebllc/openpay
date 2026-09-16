import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';

// next/og の ImageResponse は Satori + wasm を要するため、ここでは描画せず引数を捕捉する
// 軽量モックに差し替え、route の配線 (寸法・フォント・キャッシュヘッダ・モデル→要素) を検証する。
const ctorCalls: Array<{ element: ReactElement; options: Record<string, unknown> }> = [];
vi.mock('next/og', () => ({
  ImageResponse: vi.fn(function (
    this: unknown,
    element: ReactElement,
    options: Record<string, unknown>,
  ) {
    ctorCalls.push({ element, options });
    return { element, options, status: 200 };
  }),
}));

import { GET } from '@/app/api/og/tip/route';

// React 要素ツリーから文字列の子だけ再帰収集する。
function collectText(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return collectText(props?.children);
  }
  return [];
}

function callGet(query: string) {
  ctorCalls.length = 0;
  GET(new Request(`https://open-pay.jp/api/og/tip?${query}`));
  return ctorCalls[0];
}

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

beforeEach(() => {
  ctorCalls.length = 0;
});

describe('GET /api/og/tip', () => {
  it('1200x630・日本語フォント 1 件・長期キャッシュヘッダで ImageResponse を構築する', () => {
    const { options } = callGet(`to=${ADDR}&token=jpyc&name=Alice`);
    expect(options.width).toBe(1200);
    expect(options.height).toBe(630);
    const fonts = options.fonts as Array<{ name: string; weight: number }>;
    expect(fonts).toHaveLength(1);
    expect(fonts[0].name).toBe('NotoSansJP');
    expect(fonts[0].weight).toBe(700);
    const headers = options.headers as Record<string, string>;
    expect(headers['cache-control']).toContain('max-age=86400');
  });

  it('name 入りカードは受取人名と open-pay.jp を含む', () => {
    const { element } = callGet(`to=${ADDR}&token=jpyc&name=Alice&locale=ja`);
    const text = collectText(element).join(' ');
    expect(text).toContain('Alice さんへ');
    expect(text).toContain('open-pay.jp');
    expect(text).toContain('OpenPay');
  });

  it('パラメータ無し (不正) でも generic カードに倒す (画像は壊さない)', () => {
    const { element } = callGet('');
    const text = collectText(element).join(' ');
    expect(text).toContain('チップを送る');
    expect(text).toContain('open-pay.jp');
  });
});

it.each([[false, false], [false, true], [true, false], [true, true]])('metadata → image URL → actual route: arc=%s tip=%s', async (arc, tip) => {
  const { env } = await import('@/lib/env');
  const oldArc = env.enableUsdcArc; const oldTip = env.enableUsdcArcTip;
  Object.assign(env, { enableUsdcArc: arc, enableUsdcArcTip: tip });
  try {
    const { generateMetadata } = await import('@/app/[locale]/tip/[address]/page');
    const meta = await generateMetadata({ params: Promise.resolve({ locale: 'ja', address: ADDR }), searchParams: Promise.resolve({ token: 'usdc', chain: 'arc', preset: '0.5' }) });
    const image = (meta.openGraph!.images as Array<{ url: string }>)[0].url;
    expect(image.includes('chain=arc')).toBe(arc && tip);
    GET(new Request(new URL(image.replace('/og/', '/api/og/'), 'https://open-pay.jp')));
    const text = collectText(ctorCalls.at(-1)!.element).join(' ');
    expect(text).not.toContain('ガス不要');
    expect(text.includes('ガスも USDC')).toBe(arc && tip);
    expect(meta.description).not.toContain('ガス不要');
  } finally { Object.assign(env, { enableUsdcArc: oldArc, enableUsdcArcTip: oldTip }); }
});
