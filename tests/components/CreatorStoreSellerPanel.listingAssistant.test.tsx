// 出品者のパネルに置いた AI 出品アシスタントの入口 (ProductEditorSection) と、既存の商品を編集したときの送る中身。
// 入口は出品者の GET の listingAssistant が true のときだけ出し、押すまで本体 (ListingAssistant.tsx) を読まない。
// ⚠️ 「押す前は読まない」は module の初回の読み込みで数えるので、この file の先頭の 2 つの test の順を変えない。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import { listingAssistantFactsOf, LISTING_ASSISTANT_FACT_KEYS } from '@/lib/store/listingAssistant';
import {
  COO_WORLD_DRAFT,
  MARKERS,
  SELLER_FORM,
  existingProductForm,
  jsonResponse,
} from '../_helpers/listingAssistantFixtures';

const ADDRESS = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const chunk = vi.hoisted(() => ({ loaded: vi.fn() }));

vi.mock('@/components/creator-store-seller/ListingAssistant', async (importOriginal) => {
  chunk.loaded();
  return importOriginal<typeof import('@/components/creator-store-seller/ListingAssistant')>();
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, enableCreatorStoreUi: true, enableLicenseNftUi: false, enableStoreDeliveryTicketUi: true },
  };
});
vi.mock('@/hooks/useStoreCacheScope', () => ({ useStoreCacheScope: () => {} }));
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true, address: ADDRESS }) }));
vi.mock('@/components/ConnectButton', () => ({ ConnectButton: () => <button type="button">Connect wallet</button> }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: true, sessionAddress: ADDRESS, signIn: vi.fn(), isSigningIn: false, signInError: null,
    signOut: vi.fn(), mismatch: false, isLoading: false,
  }),
}));

import { CreatorStoreSellerPanel } from '@/components/CreatorStoreSellerPanel';

const A = ja.CreatorStoreSeller.assistant;
const PRODUCT_ID = `h_${'c'.repeat(32)}`;

/** 目印を入れた既存の商品 (fixtures の existingProductForm と同じ値を、一覧と詳細の API の形で返す)。 */
function markedProduct() {
  const form = existingProductForm();
  return {
    id: PRODUCT_ID,
    payTo: MARKERS.payTo,
    title: form.title,
    desc: form.desc,
    details: form.details,
    specs: [{ label: '形式', value: 'GLB' }, { label: 'ポリゴン数', value: '約 3,000' }],
    demoUrl: MARKERS.demoUrl,
    usage: { commercial: 'allowed', modify: 'allowed', redistribute: 'not_allowed', note: form.usageNote },
    emoji: MARKERS.emoji,
    imageUrl: MARKERS.imageUrl,
    deliveryUrl: MARKERS.deliveryUrl,
    galleryUrls: [MARKERS.galleryUrls],
    priceJpyc: MARKERS.priceJpyc,
    contentKind: 'text',
    label: 'download',
    category: form.category,
    tags: ['Coo World', '照明', '3D'],
    handle: MARKERS.listingHandle,
    featured: true,
    saleActive: true,
    usdcEnabled: true,
    contentAvailable: true,
  };
}

function draftBody() {
  return {
    ok: true,
    draft: {
      title: { value: COO_WORLD_DRAFT.title, fits: true },
      desc: { value: COO_WORLD_DRAFT.desc, fits: true },
      tags: { value: COO_WORLD_DRAFT.tags, fits: true },
      en: { value: COO_WORLD_DRAFT.en, fits: true },
      x: { value: COO_WORLD_DRAFT.x, fits: true },
      checks: { value: COO_WORLD_DRAFT.checks, fits: true },
    },
  };
}

function stubApi(listingAssistant: boolean | undefined) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/store/seller') {
      return jsonResponse({
        ok: true,
        seller: { name: SELLER_FORM.name, contact: SELLER_FORM.contact, disclosure: SELLER_FORM.disclosure, updatedAt: 1 },
        ...(listingAssistant === undefined ? {} : { listingAssistant }),
      });
    }
    if (url === '/api/store/products') return jsonResponse({ ok: true, products: [markedProduct()], max: 24 });
    if (url === `/api/store/products/${PRODUCT_ID}`) {
      return jsonResponse({ ok: true, product: markedProduct(), content: { kind: 'text', value: MARKERS.content } });
    }
    if (url === '/api/store/seller/listing-assistant') return jsonResponse(draftBody());
    return jsonResponse({ ok: false, error: 'unexpected' }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={client}>
      <CreatorStoreSellerPanel handle="alice" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('出品フォームの AI 出品アシスタントの入口', () => {
  it.each([false, undefined])('出品者の GET の listingAssistant が %s なら入口を出さず、本体も読まない', async (flag) => {
    stubApi(flag);
    renderPanel();
    await screen.findByRole('heading', { name: '新しい商品' });
    expect(screen.queryByRole('button', { name: A.open })).not.toBeInTheDocument();
    expect(screen.queryByText(A.notice)).not.toBeInTheDocument();
    expect(chunk.loaded).not.toHaveBeenCalled();
  });

  it('true なら入口を出し、押したときだけ本体を読み込む (手入力のフォームはそのまま使える)', async () => {
    stubApi(true);
    renderPanel();
    const open = await screen.findByRole('button', { name: A.open });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(chunk.loaded).not.toHaveBeenCalled();
    expect(screen.getByLabelText('商品名')).toBeEnabled();

    fireEvent.click(open);
    expect(await screen.findByRole('button', { name: A.generate })).toBeInTheDocument();
    expect(chunk.loaded).toHaveBeenCalledTimes(1);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(open).toHaveAttribute('aria-controls', 'creator-store-listing-assistant');
    // 入口と本体は商品のフォームの外 (案の欄で Enter を押しても商品を保存しない)。
    expect(screen.getByLabelText('商品名').closest('form')).not.toContainElement(open);
    expect(screen.getByLabelText('商品名').closest('form')).not.toContainElement(screen.getByRole('button', { name: A.generate }));

    // 閉じても本体 (メモ) は残り、開き直すと続きから使える。
    fireEvent.change(screen.getByRole('textbox', { name: 'メモ (500 字まで)' }), { target: { value: '残すメモ' } });
    fireEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('creator-store-listing-assistant')).not.toBeVisible();
    fireEvent.click(open);
    expect(screen.getByRole('textbox', { name: 'メモ (500 字まで)' })).toHaveValue('残すメモ');
  });

  it('既存の商品の編集で送る中身は PR 1 の抽出と同じで、有料の本文・納品 URL・販売者情報などの目印が無い', async () => {
    const fetchMock = stubApi(true);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('heading', { name: '商品を編集' });
    expect(document.getElementById('creator-store-product-content')).toHaveValue(MARKERS.content);

    fireEvent.click(screen.getByRole('button', { name: A.open }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'メモ (500 字まで)' }), {
      target: { value: 'Coo World向けの木目調スタンドライト' },
    });
    fireEvent.click(screen.getByRole('button', { name: A.generate }));
    await screen.findByRole('heading', { name: A.resultHeading });

    const calls = fetchMock.mock.calls.filter(([url]) => url === '/api/store/seller/listing-assistant');
    expect(calls).toHaveLength(1);
    const raw = String((calls[0] as unknown as [string, RequestInit])[1].body);
    const body = JSON.parse(raw) as { memo: string; facts: Record<string, string> };
    expect(Object.keys(body).sort()).toEqual(['facts', 'memo']);
    expect(Object.keys(body.facts).sort()).toEqual([...LISTING_ASSISTANT_FACT_KEYS].sort());
    // 一覧の tags は配列なので、フォームに読み込んだ形 (カンマ区切り) で比べる。
    expect(body.facts).toEqual(listingAssistantFactsOf(existingProductForm({ tags: 'Coo World, 照明, 3D' })));
    for (const marker of [...Object.values(MARKERS), SELLER_FORM.name, SELLER_FORM.contact, SELLER_FORM.disclosure]) {
      expect(raw).not.toContain(marker);
    }
  });

  it('押した欄だけフォームに入り、ほかの欄と有料の本文は変わらない (生成だけでは変わらない)', async () => {
    stubApi(true);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await screen.findByRole('heading', { name: '商品を編集' });
    fireEvent.click(screen.getByRole('button', { name: A.open }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'メモ (500 字まで)' }), { target: { value: 'メモ' } });
    fireEvent.click(screen.getByRole('button', { name: A.generate }));
    await screen.findByRole('heading', { name: A.resultHeading });
    expect(screen.getByLabelText('商品名')).toHaveValue('木目調のスタンドライト');

    fireEvent.click(screen.getByRole('button', { name: A.applyTitle }));
    expect(screen.getByLabelText('商品名')).toHaveValue(COO_WORLD_DRAFT.title);
    expect(screen.getByLabelText('説明 (任意)')).toHaveValue('Coo World の部屋に置ける 3D 素材です。');
    expect(document.getElementById('creator-store-product-tags')).toHaveValue('Coo World, 照明, 3D');
    expect(document.getElementById('creator-store-product-content')).toHaveValue(MARKERS.content);
    await waitFor(() => expect(screen.getByRole('button', { name: A.undoTitle })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: A.undoTitle }));
    expect(screen.getByLabelText('商品名')).toHaveValue('木目調のスタンドライト');
  });
});
