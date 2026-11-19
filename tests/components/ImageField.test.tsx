// 共通の画像の欄 (components/ImageField.tsx)。アップロード (lib/images/uploadClient) は mock して、応答の時を test が決める。
// 選ぶ・外す・URL で指定する・失敗で元の画像を保つ・二重送信の防ぎ・やめた後と unmount の後の古い応答を捨てる・busy を親へ。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import type { ImageUploadResult } from '@/lib/images/uploadClient';

const uploadImageFile = vi.hoisted(() => vi.fn());
vi.mock('@/lib/images/uploadClient', () => ({ uploadImageFile }));

import { ImageField } from '@/components/ImageField';

const T = ja.ImageField;
const OLD = 'https://images.example/old.png';
const NEW = 'https://teststore.public.blob.vercel-storage.com/v1/k/product/n.jpg';

type Deferred = { resolve: (value: ImageUploadResult) => void; signal: AbortSignal };
let pending: Deferred[];

function Harness({
  initial = OLD,
  onBusyChange,
  onChangeSpy,
}: {
  initial?: string;
  onBusyChange?: (busy: boolean) => void;
  onChangeSpy?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ImageField
        id="test-image"
        label="表紙の画像 (任意)"
        urlLabel="画像 URL (任意)"
        value={value}
        onChange={(next) => {
          onChangeSpy?.(next);
          setValue(next);
        }}
        purpose="product"
        onBusyChange={onBusyChange}
        urlMaxLength={512}
      />
      <span data-testid="value">{value}</span>
      <button type="button" onClick={() => setValue('https://images.example/from-elsewhere.png')}>
        ほかから替える
      </button>
    </>
  );
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function choose(container: HTMLElement, name = 'photo.jpg') {
  fireEvent.change(fileInput(container), { target: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });
}

const value = () => screen.getByTestId('value').textContent;

beforeEach(() => {
  pending = [];
  uploadImageFile.mockImplementation(
    (_file: Blob, _purpose: string, signal: AbortSignal) =>
      new Promise<ImageUploadResult>((resolve) => pending.push({ resolve, signal })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ImageField', () => {
  it('今の画像のプレビュー・画像を選ぶ・外す・閉じた「URL で指定する ›」を出す (file の欄は JPEG・PNG・WebP)', () => {
    const { container } = renderWithIntl(<Harness />);
    expect(screen.getByRole('group', { name: '表紙の画像 (任意)' })).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', OLD);
    expect(container.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByRole('button', { name: T.choose })).toBeEnabled();
    expect(screen.getByRole('button', { name: T.remove })).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: T.useUrl });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('画像 URL (任意)')).not.toBeInTheDocument();
    expect(fileInput(container)).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    // 可視テキストの無い aria-label を付けない (掟 8)。
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
  });

  it('選んだ画像を product の用途で送り、届いた URL を入れる (その間は busy・選ぶを止める)', async () => {
    const onBusyChange = vi.fn();
    const { container } = renderWithIntl(<Harness onBusyChange={onBusyChange} />);
    choose(container);
    expect(uploadImageFile).toHaveBeenCalledWith(expect.any(File), 'product', expect.any(AbortSignal));
    expect(await screen.findByRole('status')).toHaveTextContent(T.uploading);
    expect(screen.getByRole('button', { name: T.choose })).toBeDisabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => pending[0].resolve({ ok: true, url: NEW }));
    expect(value()).toBe(NEW);
    expect(container.querySelector('img')).toHaveAttribute('src', NEW);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('外すと空にする', () => {
    const { container } = renderWithIntl(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: T.remove }));
    expect(value()).toBe('');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(T.empty)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: T.remove })).not.toBeInTheDocument();
  });

  it('「URL で指定する ›」を押したときだけ URL の欄が開き、今の値が入っていて、書き換えられる', () => {
    renderWithIntl(<Harness />);
    const toggle = screen.getByRole('button', { name: T.useUrl });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const input = screen.getByLabelText('画像 URL (任意)');
    expect(input).toHaveValue(OLD);
    expect(input).toHaveAttribute('maxlength', '512');
    expect(input).toHaveAttribute('id', 'test-image-url');
    fireEvent.change(input, { target: { value: 'https://images.example/typed.png' } });
    expect(value()).toBe('https://images.example/typed.png');
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('画像 URL (任意)')).not.toBeInTheDocument();
  });

  it('失敗しても元の画像を保ち、code ごとの短い文を出す', async () => {
    const onChangeSpy = vi.fn();
    const { container } = renderWithIntl(<Harness onChangeSpy={onChangeSpy} />);
    choose(container);
    await act(async () => pending[0].resolve({ ok: false, error: 'image_limit' }));
    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(value()).toBe(OLD);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(T.errors.imageLimit.replace('{max}', '200'));
    expect(alert).toHaveTextContent(T.keepOriginal);
    expect(screen.getByRole('button', { name: T.choose })).toBeEnabled();
    // 値がほかから変わったら (AI の表紙など) 前の失敗の文は消す。
    fireEvent.click(screen.getByRole('button', { name: 'ほかから替える' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['too_large', T.errors.tooLarge],
    ['payload_too_large', T.errors.tooLarge],
    ['decode_failed', T.errors.invalidImage],
    ['invalid_image', T.errors.invalidImage],
    ['unsupported', T.errors.unsupported],
    ['rate_limited', T.errors.rateLimited],
    ['unauthenticated', T.errors.unauthenticated],
    ['not_found', T.errors.notAvailable],
    ['storage_unavailable', T.errors.unavailable],
    ['network', T.errors.network],
    ['unknown', T.errors.unknown],
  ] as const)('失敗 %s の文', async (error, message) => {
    const { container } = renderWithIntl(<Harness />);
    choose(container);
    await act(async () => pending[0].resolve({ ok: false, error }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('同じ tick の 2 回目は送らない (二重送信の防ぎ)', () => {
    const { container } = renderWithIntl(<Harness />);
    choose(container, 'a.jpg');
    choose(container, 'b.jpg');
    expect(uploadImageFile).toHaveBeenCalledTimes(1);
  });

  it('やめた後に届いた応答は捨てる (送信は取り消し、busy を外し、もう一度選べる)', async () => {
    const onBusyChange = vi.fn();
    const onChangeSpy = vi.fn();
    const { container } = renderWithIntl(<Harness onBusyChange={onBusyChange} onChangeSpy={onChangeSpy} />);
    choose(container);
    fireEvent.click(await screen.findByRole('button', { name: T.cancel }));
    expect(pending[0].signal.aborted).toBe(true);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    await act(async () => pending[0].resolve({ ok: true, url: NEW }));
    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(value()).toBe(OLD);
    choose(container, 'again.jpg');
    expect(uploadImageFile).toHaveBeenCalledTimes(2);
    await act(async () => pending[1].resolve({ ok: true, url: NEW }));
    expect(value()).toBe(NEW);
  });

  it('送っている間に URL を書き換えたら、届いた画像で上書きしない', async () => {
    const { container } = renderWithIntl(<Harness />);
    choose(container);
    fireEvent.click(screen.getByRole('button', { name: T.useUrl }));
    fireEvent.change(screen.getByLabelText('画像 URL (任意)'), { target: { value: 'https://images.example/typed.png' } });
    await act(async () => pending[0].resolve({ ok: true, url: NEW }));
    expect(value()).toBe('https://images.example/typed.png');
  });

  it('送っている間に値がほかから変わったら (AI の表紙・元に戻す)、届いた画像で上書きしない', async () => {
    const onBusyChange = vi.fn();
    const { container } = renderWithIntl(<Harness onBusyChange={onBusyChange} />);
    choose(container);
    fireEvent.click(screen.getByRole('button', { name: 'ほかから替える' }));
    await act(async () => pending[0].resolve({ ok: true, url: NEW }));
    expect(value()).toBe('https://images.example/from-elsewhere.png');
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('unmount の後に届いた応答は捨て、busy は false を知らせる', async () => {
    const onBusyChange = vi.fn();
    const onChange = vi.fn();
    const { container, unmount } = renderWithIntl(
      <ImageField
        id="x"
        label="L"
        urlLabel="U"
        value=""
        onChange={onChange}
        purpose="product"
        onBusyChange={onBusyChange}
        urlMaxLength={512}
      />,
    );
    choose(container);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(pending[0].signal.aborted).toBe(true);
    await act(async () => pending[0].resolve({ ok: true, url: NEW }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('表示できない画像は同じ大きさの枠と短い文に置き換える (URL を直せば描き直す)', () => {
    const { container } = renderWithIntl(<Harness />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(T.previewFailed)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: T.useUrl }));
    fireEvent.change(screen.getByLabelText('画像 URL (任意)'), { target: { value: NEW } });
    expect(container.querySelector('img')).toHaveAttribute('src', NEW);
  });
});

describe('i18n: ImageField の ja/en parity', () => {
  function deepKeys(value: unknown, prefix = ''): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      deepKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  const read = (messages: unknown, key: string) =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages);

  it('ja.ImageField と en.ImageField の deep key 集合が一致し、値はすべて非空', () => {
    expect(deepKeys(ja.ImageField).sort()).toEqual(deepKeys(en.ImageField).sort());
    for (const key of deepKeys(en.ImageField)) {
      expect(String(read(ja.ImageField, key)).trim()).not.toBe('');
      expect(String(read(en.ImageField, key)).trim()).not.toBe('');
    }
  });
});
