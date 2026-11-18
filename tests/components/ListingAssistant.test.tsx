// AI 出品アシスタントの本体 (components/creator-store-seller/ListingAssistant.tsx)。フォームは state を持つ harness で
// 本物の updateProduct と同じく欄を merge する。fetch と画像の下ごしらえ (canvas) は差し替える。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { renderWithIntl } from './../_helpers/i18n';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import type { ProductForm } from '@/lib/store/productForm';
import { listingAssistantFactsOf, type ListingAssistantDraft } from '@/lib/store/listingAssistant';
import { MAX_HOSTED_DESC_LEN, MAX_HOSTED_TITLE_LEN } from '@/lib/x402/hostedStore';
import { parseDraft } from '@/lib/store/listingAssistantServer';
import { COO_WORLD_DRAFT, MARKERS, emptyProductForm, existingProductForm, jsonResponse } from '../_helpers/listingAssistantFixtures';

const image = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('@/components/creator-store-seller/listingAssistantImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/creator-store-seller/listingAssistantImage')>()),
  prepareListingImage: image.prepare,
}));

import {
  ASSISTANT_DESC_MAX,
  ASSISTANT_TITLE_MAX,
  GEMINI_TERMS_URL,
  LISTING_ASSISTANT_ENDPOINT,
  ListingAssistant,
} from '@/components/creator-store-seller/ListingAssistant';

const A = ja.CreatorStoreSeller.assistant;

function draftOf(over: Partial<Record<keyof ListingAssistantDraft, unknown>> = {}): ListingAssistantDraft {
  return {
    title: { value: COO_WORLD_DRAFT.title, fits: true },
    desc: { value: COO_WORLD_DRAFT.desc, fits: true },
    tags: { value: COO_WORLD_DRAFT.tags, fits: true },
    en: { value: COO_WORLD_DRAFT.en, fits: true },
    x: { value: COO_WORLD_DRAFT.x, fits: true },
    checks: { value: COO_WORLD_DRAFT.checks, fits: true },
    ...over,
  } as ListingAssistantDraft;
}

const okResponse = (draft = draftOf()) => jsonResponse({ ok: true, draft });

let latestForm: ProductForm;
const updates: Partial<ProductForm>[] = [];

function Harness({ initial }: { initial: ProductForm }) {
  const [form, setForm] = useState(initial);
  latestForm = form;
  return (
    <>
      {/* フォームの欄の代わり: 値の変化を DOM で見る (「生成だけでは変わらない」を確かめる)。 */}
      <span data-testid="form-title">{form.title}</span>
      <span data-testid="form-desc">{form.desc}</span>
      <span data-testid="form-tags">{form.tags}</span>
      <button type="button" onClick={() => setForm((current) => ({ ...current, title: '手で直した商品名' }))}>
        手で直す
      </button>
      <ListingAssistant
        productForm={form}
        updateProduct={(patch) => {
          updates.push(patch);
          setForm((current) => ({ ...current, ...patch }));
        }}
      />
    </>
  );
}

function renderAssistant(initial: ProductForm = existingProductForm(), locale: 'ja' | 'en' = 'ja') {
  return renderWithIntl(<Harness initial={initial} />, { locale });
}

const memoBox = () => screen.getByRole('textbox', { name: `メモ (500 字まで)` });
const generateButton = () => screen.getByRole('button', { name: /^(案を作る|もう一度作る)$/ });
const fetchMock = () => vi.mocked(globalThis.fetch);
const sentBodies = () =>
  fetchMock()
    .mock.calls.filter(([url]) => url === LISTING_ASSISTANT_ENDPOINT)
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

async function generateWithMemo(memo = 'Coo World向けの木目調スタンドライト') {
  fireEvent.change(memoBox(), { target: { value: memo } });
  fireEvent.click(generateButton());
  await screen.findByRole('heading', { name: A.resultHeading });
}

let clipboardDesc: PropertyDescriptor | undefined;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  updates.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
  image.prepare.mockResolvedValue({ ok: true, image: { data: '/9j/4AAQSkZJRg==', bytes: 2048, width: 1280, height: 960 } });
  clipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (clipboardDesc) Object.defineProperty(navigator, 'clipboard', clipboardDesc);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe('ListingAssistant: 送る前', () => {
  it('承認済みの注意文 (ja / en) をそのまま出し、Google の規約へ新しいタブで張る', () => {
    expect(A.notice).toBe('画像・メモと公開用の項目を Google の Gemini に送ります。無料枠のため、送った内容と作られた文は Google のサービス改善に使われ、担当者が読むことがあります。個人情報や購入者だけに渡す内容は入れないでください。');
    expect(en.CreatorStoreSeller.assistant.notice).toBe('Your image, memo and public listing fields are sent to Google Gemini. On the free tier, what you send and the generated text are used to improve Google’s services and may be read by reviewers. Do not include personal information or content meant only for buyers.');
    renderAssistant();
    expect(screen.getByText(A.notice)).toBeInTheDocument();
    const terms = screen.getByRole('link', { name: A.termsLink });
    expect(terms).toHaveAttribute('href', 'https://ai.google.dev/gemini-api/terms');
    expect(GEMINI_TERMS_URL).toBe('https://ai.google.dev/gemini-api/terms');
    expect(terms).toHaveAttribute('target', '_blank');
    expect(terms).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('en でも注意文と規約のリンクを出す', () => {
    renderAssistant(existingProductForm(), 'en');
    expect(screen.getByText(en.CreatorStoreSeller.assistant.notice)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.CreatorStoreSeller.assistant.termsLink })).toHaveAttribute('href', GEMINI_TERMS_URL);
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled();
  });

  it('一緒に送る項目は、許可リストの欄のうち値のある欄の名前だけ・有料の本文と納品 URL は送らないと書く', () => {
    renderAssistant(existingProductForm({ details: '', usageNote: '' }));
    expect(
      screen.getByText('フォームに入力済みの欄: 商品名、説明、仕様、商用利用、改変、再配布・再販売、カテゴリー、タグ'),
    ).toBeInTheDocument();
    expect(screen.getByText(A.notSent)).toHaveTextContent('有料の本文・納品 URL');
  });

  it('新しい商品で欄が空なら「入力済みの項目はありません」・画像もメモも無ければ作れない', () => {
    renderAssistant(emptyProductForm());
    expect(screen.getByText(A.sendNone)).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();
    expect(screen.getByText(A.needInput)).toBeInTheDocument();
    fireEvent.change(memoBox(), { target: { value: '   ' } });
    expect(generateButton()).toBeDisabled();
    fireEvent.click(generateButton());
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('利用ライセンスの商品は普通の商品の利用条件を送る項目に数えない (PR 1 の抽出のまま)', () => {
    renderAssistant(existingProductForm({ productKind: 'license', details: '' }));
    expect(screen.getByText('フォームに入力済みの欄: 商品名、説明、仕様、カテゴリー、タグ')).toBeInTheDocument();
  });

  it('メモは 500 字まで (残りの字数を出す)', () => {
    renderAssistant();
    expect(memoBox()).toHaveAttribute('maxLength', '500');
    fireEvent.change(memoBox(), { target: { value: 'あいう' } });
    expect(screen.getByText('残り 497 字')).toBeInTheDocument();
  });
});

describe('ListingAssistant: 送る中身', () => {
  it('メモだけで送れる (画像の key を付けない・facts は PR 1 の抽出と同じ・目印が無い)', async () => {
    renderAssistant();
    await generateWithMemo('  Coo World向けの木目調スタンドライト  ');
    const [body] = sentBodies();
    expect(Object.keys(body).sort()).toEqual(['facts', 'memo']);
    expect(body.memo).toBe('Coo World向けの木目調スタンドライト');
    expect(body.facts).toEqual(listingAssistantFactsOf(existingProductForm()));
    const sent = JSON.stringify(body);
    for (const marker of Object.values(MARKERS)) expect(sent).not.toContain(marker);
    const init = fetchMock().mock.calls[0][1];
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('画像だけで送れる (描き直した JPEG の base64・メモの key を付けない)', async () => {
    renderAssistant();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'lamp.png', { type: 'image/png' });
    const input = screen.getByLabelText(A.imageLabel);
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('送る画像: 1280 × 960px・2 KB')).toBeInTheDocument();
    expect(image.prepare).toHaveBeenCalledWith(file);
    expect(screen.getByRole('img', { name: A.imagePreviewAlt })).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
    fireEvent.click(generateButton());
    await screen.findByRole('heading', { name: A.resultHeading });
    const [body] = sentBodies();
    expect(Object.keys(body).sort()).toEqual(['facts', 'image']);
    expect(body.image).toEqual({ mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' });
  });

  it('画像を外すと送らない・下ごしらえに失敗した画像は送らずに案内する', async () => {
    renderAssistant();
    const input = screen.getByLabelText(A.imageLabel);
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByRole('button', { name: A.imageRemove }));
    expect(screen.queryByRole('img', { name: A.imagePreviewAlt })).not.toBeInTheDocument();
    expect(generateButton()).toBeDisabled();

    for (const [error, text] of [
      ['too_large', A.imageTooLarge],
      ['decode_failed', A.imageDecodeFailed],
      ['unsupported', A.imageUnsupported],
    ] as const) {
      image.prepare.mockResolvedValueOnce({ ok: false, error });
      fireEvent.change(input, { target: { files: [new File(['x'], 'b.heic', { type: 'image/heic' })] } });
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text));
      expect(generateButton()).toBeDisabled();
    }
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('二重送信しない: 同じ tick に 2 回押しても 1 回だけ送り、生成中はボタンを止めて表示を出す', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    renderAssistant();
    fireEvent.change(memoBox(), { target: { value: 'メモ' } });
    const button = generateButton();
    act(() => {
      // state の反映 (disabled) より前の 2 回目の押下は ref が止める。
      button.click();
      button.click();
    });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(A.generating);
    fireEvent.click(button);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    await act(async () => finish(okResponse()));
    await screen.findByRole('heading', { name: A.resultHeading });
    expect(screen.getByRole('button', { name: A.regenerate })).toBeEnabled();
  });

  it('再生成は押したときだけ送り、フォームを変えずに案と欄の手直しを入れ替える', async () => {
    renderAssistant();
    await generateWithMemo();
    fireEvent.change(screen.getByRole('textbox', { name: A.fieldTitle }), { target: { value: '手直しした案' } });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(okResponse(draftOf({ title: { value: '二回目の商品名', fits: true } })));
    fireEvent.click(screen.getByRole('button', { name: A.regenerate }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: A.fieldTitle })).toHaveValue('二回目の商品名'));
    expect(sentBodies()).toHaveLength(2);
    expect(updates).toEqual([]);
    expect(latestForm).toEqual(existingProductForm());
  });
});

describe('ListingAssistant: 案の反映', () => {
  it('生成だけではフォームを変えず、押した欄だけ入れる (ほかの欄は変わらない)', async () => {
    renderAssistant();
    await generateWithMemo();
    expect(updates).toEqual([]);
    expect(screen.getByTestId('form-title')).toHaveTextContent('木目調のスタンドライト');

    fireEvent.click(screen.getByRole('button', { name: A.applyTitle }));
    expect(updates).toEqual([{ title: COO_WORLD_DRAFT.title }]);
    expect(latestForm).toEqual({ ...existingProductForm(), title: COO_WORLD_DRAFT.title });

    fireEvent.click(screen.getByRole('button', { name: A.applyTags }));
    expect(updates.at(-1)).toEqual({ tags: 'Coo World, スタンドライト, 木目調' });
    expect(latestForm).toEqual({ ...existingProductForm(), title: COO_WORLD_DRAFT.title, tags: 'Coo World, スタンドライト, 木目調' });

    fireEvent.click(screen.getByRole('button', { name: A.applyDesc }));
    expect(latestForm).toEqual({
      ...existingProductForm(),
      title: COO_WORLD_DRAFT.title,
      tags: 'Coo World, スタンドライト, 木目調',
      desc: COO_WORLD_DRAFT.desc,
    });
  });

  it('入れた後は「元に戻す」で前の値に戻せる・手で直した後は戻すボタンを出さない', async () => {
    renderAssistant();
    await generateWithMemo();
    fireEvent.click(screen.getByRole('button', { name: A.applyTitle }));
    expect(screen.getByText(A.applied)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: A.undoTitle }));
    expect(latestForm.title).toBe('木目調のスタンドライト');
    expect(screen.queryByRole('button', { name: A.undoTitle })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: A.applyTitle }));
    fireEvent.click(screen.getByRole('button', { name: '手で直す' }));
    expect(screen.queryByRole('button', { name: A.undoTitle })).not.toBeInTheDocument();
    expect(latestForm.title).toBe('手で直した商品名');
  });

  it('欄で直した文を入れる (前後の空白・改行は保存と同じく整える)', async () => {
    renderAssistant();
    await generateWithMemo();
    fireEvent.change(screen.getByRole('textbox', { name: A.fieldDesc }), { target: { value: '  一行目\n二行目  ' } });
    fireEvent.change(screen.getByRole('textbox', { name: A.fieldTags }), { target: { value: '照明、 照明, 3D素材' } });
    fireEvent.click(screen.getByRole('button', { name: A.applyDesc }));
    fireEvent.click(screen.getByRole('button', { name: A.applyTags }));
    expect(updates).toEqual([{ desc: '一行目 二行目' }, { tags: '照明, 3D素材' }]);
  });

  it('fits:false の欄は上限の中に切った見本として見せ、入れるボタンを止める・欄で直すと入れられる (PR 1 の 0688fcdc の形)', async () => {
    // server は長すぎた案を上限の中に切って返す (lib/store/listingAssistantServer の lineField・tagsField・checksField)。
    const sample = `${'あ'.repeat(59)}い`;
    const tagSample = ['a', 'b', 'c', 'd', 'e'];
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(draftOf({
      title: { value: sample, fits: false },
      tags: { value: tagSample, fits: false },
      desc: { value: '', fits: false },
      x: { value: 'う'.repeat(120), fits: false },
      checks: { value: ['確認 1', '確認 2', '確認 3', '確認 4', '確認 5'], fits: false },
    }))));
    renderAssistant();
    await generateWithMemo();
    const titleBox = screen.getByRole('textbox', { name: A.fieldTitle });
    const applyTitle = screen.getByRole('button', { name: A.applyTitle });
    expect(titleBox).toHaveValue(sample);
    expect(applyTitle).toBeDisabled();
    const clipped = '長すぎたため、60 字で切った見本です。このままでは入れられません。欄で直すと入れられます。';
    expect(screen.getByText(clipped)).toBeInTheDocument();
    expect(titleBox).toHaveAccessibleDescription(clipped);
    expect(screen.getByRole('textbox', { name: A.fieldTags })).toHaveValue('a, b, c, d, e');
    expect(screen.getByRole('button', { name: A.applyTags })).toBeDisabled();
    expect(screen.getByText('案のタグが上限 (5 個・1 つ 24 字) を超えたため、切った見本です。このままでは入れられません。欄で直すと入れられます。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: A.applyDesc })).toBeDisabled();
    expect(screen.getByText(A.empty)).toBeInTheDocument();
    // X の投稿文の見本はコピーできるが、X では開かない。
    expect(screen.getByText('長すぎたため、120 字で切った見本です。欄で直してから使ってください。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: A.copyX })).toBeEnabled();
    expect(screen.queryByRole('link', { name: A.openX })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: A.openX })).toBeDisabled();
    const checks = screen.getByRole('region', { name: A.checksHeading });
    expect(within(checks).getByText('確認候補が上限 (5 個・1 つ 100 字) を超えたため、切って見せています。')).toBeInTheDocument();
    fireEvent.click(applyTitle);
    expect(updates).toEqual([]);

    // 直して見本と同じ文に戻すと、また止まる (見本のまま入れない)。
    fireEvent.change(titleBox, { target: { value: `${sample}x` } });
    expect(screen.getByText('長すぎるため入れられません (60 字まで・いま 61 字)。欄で短くすると入れられます。')).toBeInTheDocument();
    expect(applyTitle).toBeDisabled();
    fireEvent.change(titleBox, { target: { value: sample } });
    expect(applyTitle).toBeDisabled();
    fireEvent.change(titleBox, { target: { value: 'あ'.repeat(60) } });
    expect(applyTitle).toBeEnabled();
    fireEvent.click(applyTitle);
    expect(updates).toEqual([{ title: 'あ'.repeat(60) }]);

    fireEvent.change(screen.getByRole('textbox', { name: A.fieldTags }), { target: { value: 'a, b, c, d, e, f' } });
    expect(screen.getByText('タグは 5 個まで・1 つ 24 字までです。欄で直すと入れられます。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: A.applyTags })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: A.fieldTags }), { target: { value: 'a, b' } });
    fireEvent.click(screen.getByRole('button', { name: A.applyTags }));
    expect(updates.at(-1)).toEqual({ tags: 'a, b' });
  });

  it('server の parseDraft が長すぎた案から作る形を受けると、見本を見せて 3 つとも入れない (PR 1 との境目)', async () => {
    const draft = parseDraft({
      title: 'あ'.repeat(80),
      desc: 'い'.repeat(250),
      tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      en: 'e'.repeat(500),
      x: 'x'.repeat(200),
      checks: Array.from({ length: 8 }, (_, index) => `確認 ${index}`),
    });
    expect(draft).toBeDefined();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(draft)));
    renderAssistant();
    await generateWithMemo();
    expect(screen.getByRole('textbox', { name: A.fieldTitle })).toHaveValue('あ'.repeat(60));
    for (const name of [A.applyTitle, A.applyDesc, A.applyTags, A.openX]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(within(screen.getByRole('region', { name: A.checksHeading })).getAllByRole('listitem')).toHaveLength(5);
  });

  it('上限を超えた値のまま fits:false が来ても入れない (長さの理由を出す)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(draftOf({ title: { value: 'あ'.repeat(61), fits: false } }))));
    renderAssistant();
    await generateWithMemo();
    expect(screen.getByRole('button', { name: A.applyTitle })).toBeDisabled();
    expect(screen.getByText('長すぎるため入れられません (60 字まで・いま 61 字)。欄で短くすると入れられます。')).toBeInTheDocument();
  });

  it('画面の上限は保存の上限と同じ (商品名 60・説明 200)', () => {
    expect(ASSISTANT_TITLE_MAX).toBe(MAX_HOSTED_TITLE_LEN);
    expect(ASSISTANT_DESC_MAX).toBe(MAX_HOSTED_DESC_LEN);
  });

  it('確認候補は販売文の外に「出品者向けの確認」として並べる', async () => {
    renderAssistant();
    await generateWithMemo();
    const checks = screen.getByRole('region', { name: A.checksHeading });
    expect(within(checks).getAllByRole('listitem').map((item) => item.textContent)).toEqual(COO_WORLD_DRAFT.checks);
    for (const field of [A.fieldTitle, A.fieldDesc, A.fieldEn, A.fieldX]) {
      expect(within(checks).queryByRole('textbox', { name: field })).not.toBeInTheDocument();
    }
  });
});

describe('ListingAssistant: コピーと X', () => {
  it('英語の紹介と X の投稿文はコピーする (入れるボタンは無い)', async () => {
    renderAssistant();
    await generateWithMemo();
    fireEvent.click(screen.getByRole('button', { name: A.copyEn }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COO_WORLD_DRAFT.en));
    expect(await screen.findByRole('button', { name: A.copied })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: A.fieldX }), { target: { value: '直した投稿文' } });
    fireEvent.click(screen.getByRole('button', { name: A.copyX }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('直した投稿文'));
    expect(updates).toEqual([]);
  });

  it('コピーに失敗したら案内する (フォームは変えない)', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderAssistant();
    await generateWithMemo();
    fireEvent.click(screen.getByRole('button', { name: A.copyEn }));
    expect(await screen.findByRole('alert')).toHaveTextContent(A.copyFailed);
  });

  it('X で開くは本文だけの intent (HandleShareButton と同じ形・新しいタブ)', async () => {
    renderAssistant();
    await generateWithMemo();
    const link = screen.getByRole('link', { name: A.openX });
    expect(link).toHaveAttribute('href', `https://twitter.com/intent/tweet?text=${encodeURIComponent(COO_WORLD_DRAFT.x)}`);
    expect(link.getAttribute('href')).not.toContain('&url=');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.change(screen.getByRole('textbox', { name: A.fieldX }), { target: { value: 'い'.repeat(121) } });
    expect(screen.queryByRole('link', { name: A.openX })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: A.openX })).toBeDisabled();
    expect(screen.getByText('長すぎます (120 字まで・いま 121 字)。欄で短くしてから使ってください。')).toBeInTheDocument();
  });
});

describe('ListingAssistant: 失敗', () => {
  const cases: [string, number, Record<string, unknown> | null, string][] = [
    ['未認証', 401, { ok: false, error: 'unauthenticated' }, A.errors.unauthenticated],
    ['運営者でない', 403, { ok: false, error: 'forbidden' }, A.errors.forbidden],
    ['別の origin', 403, { ok: false, error: 'cross_site_request' }, A.errors.forbidden],
    ['フラグ OFF', 404, { ok: false, error: 'not_found' }, A.errors.notFound],
    ['欄が保存できない値', 400, { ok: false, error: 'invalid_facts' }, A.errors.invalidFacts],
    ['画像が読めない', 400, { ok: false, error: 'invalid_image' }, A.errors.invalidImage],
    ['メモが長い', 400, { ok: false, error: 'invalid_memo' }, 'メモは 500 字までです。'],
    ['メモも画像も無い', 400, { ok: false, error: 'memo_or_image_required' }, A.errors.memoOrImageRequired],
    ['本文の形', 400, { ok: false, error: 'invalid_body' }, A.errors.invalidRequest],
    ['大きすぎる', 413, { ok: false, error: 'payload_too_large' }, A.errors.tooLarge],
    ['画像が大きすぎる', 413, { ok: false, error: 'image_too_large' }, A.errors.tooLarge],
    ['JSON でない', 415, { ok: false, error: 'unsupported_media_type' }, A.errors.invalidRequest],
    ['安全の判定', 422, { ok: false, error: 'blocked' }, A.errors.blocked],
    ['自前の日次の上限 (待ち時間つき)', 429, { ok: false, error: 'rate_limited', retryAfterSec: 3 * 3600 + 60 }, '今日の回数の上限に達しました。約 3 時間後にお試しください。'],
    ['自前の日次の上限 (待ち時間なし)', 429, { ok: false, error: 'rate_limited' }, A.errors.rateLimited],
    ['Google の無料枠 (待ち時間つき)', 429, { ok: false, error: 'quota_exceeded', retryAfterSec: 17 }, 'Google の無料枠の上限に達しました。17 秒後にお試しください。'],
    ['Google の無料枠 (分)', 429, { ok: false, error: 'quota_exceeded', retryAfterSec: 125 }, 'Google の無料枠の上限に達しました。3 分後にお試しください。'],
    ['Google の無料枠 (待ち時間なし)', 429, { ok: false, error: 'quota_exceeded' }, A.errors.quotaExceeded],
    ['崩れた応答', 502, { ok: false, error: 'bad_response' }, A.errors.badResponse],
    ['途中で切れた', 502, { ok: false, error: 'truncated' }, A.errors.truncated],
    ['キー未設定', 503, { ok: false, error: 'not_configured' }, A.errors.notConfigured],
    ['Google に届かない', 503, { ok: false, error: 'unavailable' }, A.errors.unavailable],
    ['セッションの保存先', 503, { ok: false, error: 'session_storage_unavailable' }, A.errors.unavailable],
    ['時間切れ', 504, { ok: false, error: 'timeout' }, A.errors.timeout],
    ['本文が JSON でない 504 (Vercel)', 504, null, A.errors.timeout],
    ['本文が JSON でない 413 (Vercel)', 413, null, A.errors.tooLarge],
    ['知らない code', 500, { ok: false, error: 'boom' }, '案を作れませんでした (boom)。'],
    ['200 でも案の形が崩れている', 200, { ok: true, draft: { title: 'x' } }, A.errors.badResponse],
  ];

  it.each(cases)('%s (%i): 短い文と「入力と直前の案はそのまま」を出し、フォームと直前の案を保つ', async (_label, status, body, message) => {
    renderAssistant();
    await generateWithMemo();
    fireEvent.click(screen.getByRole('button', { name: A.applyTitle }));
    const formBefore = { ...latestForm };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      body === null ? new Response('<html>error</html>', { status }) : jsonResponse(body, status),
    );
    fireEvent.click(screen.getByRole('button', { name: A.regenerate }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(A.errorKeep);
    expect(latestForm).toEqual(formBefore);
    expect(memoBox()).toHaveValue('Coo World向けの木目調スタンドライト');
    expect(screen.getByRole('textbox', { name: A.fieldTitle })).toHaveValue(COO_WORLD_DRAFT.title);
    expect(screen.getByRole('button', { name: A.regenerate })).toBeEnabled();
  });

  it('通信の失敗も同じく案内し、次に押したときに文を消して送り直す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(okResponse()));
    renderAssistant();
    fireEvent.change(memoBox(), { target: { value: 'メモ' } });
    fireEvent.click(generateButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(A.errors.network);
    expect(latestForm).toEqual(existingProductForm());
    fireEvent.click(generateButton());
    await screen.findByRole('heading', { name: A.resultHeading });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('en の待ち時間は複数形で出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, error: 'quota_exceeded', retryAfterSec: 1 }, 429)));
    renderAssistant(existingProductForm(), 'en');
    fireEvent.change(screen.getByRole('textbox', { name: 'Memo (up to 500 characters)' }), { target: { value: 'memo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The Google free tier limit has been reached. Try again in 1 second.');
  });
});
