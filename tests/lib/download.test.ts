import { describe, it, expect, vi, afterEach } from 'vitest';
import { downloadBlob, triggerDownload } from '@/lib/download';

describe('triggerDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a 要素を生成して href / download を set + click', () => {
    const click = vi.fn();
    const anchor = {
      href: '',
      download: '',
      click,
    } as unknown as HTMLAnchorElement;
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(anchor);
    triggerDownload('https://example.test/foo.svg', 'foo.svg');
    expect(createElement).toHaveBeenCalledWith('a');
    expect(anchor.href).toBe('https://example.test/foo.svg');
    expect(anchor.download).toBe('foo.svg');
    expect(click).toHaveBeenCalledOnce();
  });
});

describe('downloadBlob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Blob を ObjectURL 経由で download + revoke する', async () => {
    const click = vi.fn();
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement;
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    // jsdom には URL.createObjectURL が存在しないため事前定義する。
    type UrlWithBlobApi = typeof URL & {
      createObjectURL?: (b: Blob) => string;
      revokeObjectURL?: (u: string) => void;
    };
    const UrlMut = URL as UrlWithBlobApi;
    UrlMut.createObjectURL = () => '';
    UrlMut.revokeObjectURL = () => undefined;
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:fake-url');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const blob = new Blob(['hello,world\n'], { type: 'text/csv' });
    downloadBlob(blob, 'out.csv');

    expect(createUrl).toHaveBeenCalledOnce();
    expect(createUrl).toHaveBeenCalledWith(blob);
    expect(anchor.href).toBe('blob:fake-url');
    expect(anchor.download).toBe('out.csv');
    expect(click).toHaveBeenCalledOnce();

    // queueMicrotask 解放を待つ
    await Promise.resolve();
    expect(revokeUrl).toHaveBeenCalledWith('blob:fake-url');
  });
});
