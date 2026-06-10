import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';

// next/og の ImageResponse は Satori + wasm を要するため、描画せず引数を捕捉する軽量
// モックに差し替え、route の配線 (KV 解決 → モデル → 要素 / avatar fetch / fallback) を
// 検証する (og-tip-route.test と同じ流儀)。
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

const h = vi.hoisted(() => ({
  enableHandles: true,
  record: null as unknown,
  resolveOk: true,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return h.enableHandles;
      },
    },
  };
});
vi.mock('@/lib/handleStore', () => ({
  resolveHandle: vi.fn(async () =>
    h.resolveOk ? { ok: true, record: h.record } : { ok: false },
  ),
}));

import { GET } from '@/app/api/og/handle/route';

function collectText(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return collectText(props?.children);
  }
  return [];
}

function collectImgSrcs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectImgSrcs);
  if (node && typeof node === 'object' && 'props' in node) {
    const n = node as {
      type?: unknown;
      props?: { src?: string; children?: unknown };
    };
    const own = n.type === 'img' && n.props?.src ? [n.props.src] : [];
    return [...own, ...collectImgSrcs(n.props?.children)];
  }
  return [];
}

async function callGet(query: string) {
  ctorCalls.length = 0;
  await GET(new Request(`https://open-pay.jp/api/og/handle?${query}`));
  return ctorCalls[0];
}

const RECORD = {
  owner: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
  config: {
    to: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
    name: '山田太郎',
    color: '#2563eb',
    methods: [
      { token: 'jpyc', chain: 'polygon' },
      { token: 'jpyc', chain: 'kaia' },
    ],
  },
  profile: { bio: 'Web3 クリエイター', avatar: 'https://cdn.example.com/a.png' },
  createdAt: 1,
  updatedAt: 2,
};

beforeEach(() => {
  h.enableHandles = true;
  h.resolveOk = true;
  h.record = RECORD;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/og/handle', () => {
  it('レコードあり: 名前・@handle・bio・ピル + アバター (data URL) を描く', async () => {
    // アバター fetch を画像レスポンスでスタブ
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );
    const { element, options } = await callGet('h=masia&locale=ja');
    const text = collectText(element).join(' ');
    expect(text).toContain('山田太郎');
    expect(text).toContain('@masia');
    expect(text).toContain('Web3 クリエイター');
    expect(text).toContain('JPYC で応援');
    expect(text).toContain('ガス不要');
    // アバターが data URL の img として描かれる (ブランドアイコンとは別に 2 枚)
    const srcs = collectImgSrcs(element);
    expect(srcs.some((s) => s.startsWith('data:image/png;base64,'))).toBe(true);
    expect(srcs).toHaveLength(2);
    expect(options.width).toBe(1200);
    expect(options.height).toBe(630);
    const headers = options.headers as Record<string, string>;
    expect(headers['cache-control']).toContain('s-maxage=3600');
  });

  it('アバター fetch 失敗 (非画像) → イニシャル円へフォールバック', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const { element } = await callGet('h=masia&locale=ja');
    const srcs = collectImgSrcs(element);
    expect(srcs).toHaveLength(1); // ブランドアイコンのみ
    expect(collectText(element).join(' ')).toContain('山'); // initial
  });

  it('未存在 handle / KV エラーは汎用ブランドカードに倒す (壊れた画像を出さない)', async () => {
    h.record = null;
    const { element } = await callGet('h=ghost&locale=ja');
    expect(collectText(element).join(' ')).toContain('チップを送る');
    h.resolveOk = false;
    const second = await callGet('h=masia&locale=ja');
    expect(collectText(second.element).join(' ')).toContain('チップを送る');
  });

  it('flag OFF / 不正 handle も汎用カード', async () => {
    h.enableHandles = false;
    const { element } = await callGet('h=masia&locale=en');
    expect(collectText(element).join(' ')).toContain('Send a tip');
    h.enableHandles = true;
    const second = await callGet('h=!!&locale=ja');
    expect(collectText(second.element).join(' ')).toContain('チップを送る');
  });
});
