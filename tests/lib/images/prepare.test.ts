// アップロード用の画像の下ごしらえ (lib/images/prepare の prepareUploadImage)。jsdom に canvas の実装は無いので、
// createImageBitmap・getContext・toBlob を差し替えて、長辺・形式の選び方 (写真は JPEG・透過は PNG)・1 MiB の扱いを確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareUploadImage, UPLOAD_JPEG_QUALITIES, UPLOAD_PNG_ATTEMPTS } from '@/lib/images/prepare';
import { IMAGE_MAX_EDGE, IMAGE_UPLOAD_MAX_BYTES, STOREFRONT_COVER_MAX_EDGE } from '@/lib/images/purpose';

const MiB = 1024 * 1024;

type Context = {
  fillStyle: string;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
};

let context: Context | null;
let alpha: number;
let blobSizes: number[];
let blobTypeOverride: string | null;
let toBlobCalls: { type: string | undefined; quality: number | undefined; width: number; height: number }[];
let close: ReturnType<typeof vi.fn>;

function stubBitmap(width: number, height: number) {
  close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })));
}

const file = (type: string) => new Blob(['x'], { type });

beforeEach(() => {
  alpha = 255;
  context = {
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      // 最後の画素の alpha だけを変える (全部を見ていることも確かめる)。
      data[data.length - 1] = alpha;
      return { data, width, height };
    }),
  };
  blobSizes = [200_000];
  blobTypeOverride = null;
  toBlobCalls = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: number,
  ) {
    toBlobCalls.push({ type, quality, width: this.width, height: this.height });
    const size = blobSizes[Math.min(toBlobCalls.length - 1, blobSizes.length - 1)];
    callback(new Blob([new Uint8Array(size)], { type: blobTypeOverride ?? type }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prepareUploadImage', () => {
  it('写真 (透けない画像) は長辺を用途の大きさに縮めて JPEG (品質 0.85)・白は敷かない・描いた画素を調べる', async () => {
    stubBitmap(4032, 3024);
    const result = await prepareUploadImage(file('image/jpeg'), 'product');
    expect(IMAGE_MAX_EDGE.product).toBe(1280);
    expect(result.ok && result.image).toMatchObject({ type: 'image/jpeg', width: 1280, height: 960 });
    expect(toBlobCalls).toEqual([{ type: 'image/jpeg', quality: UPLOAD_JPEG_QUALITIES[0], width: 1280, height: 960 }]);
    expect(context!.fillRect).not.toHaveBeenCalled();
    expect(context!.getImageData).toHaveBeenCalledWith(0, 0, 1280, 960);
    expect(context!.drawImage).toHaveBeenCalledWith(expect.objectContaining({ width: 4032 }), 0, 0, 1280, 960);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['avatar', 512],
    ['storefront', 512],
    ['link', 320],
    ['preset', 800],
    ['cover', 1280],
  ] as const)('用途 %s の長辺は %ipx・小さい画像は拡大しない', async (purpose, edge) => {
    stubBitmap(3000, 1500);
    const big = await prepareUploadImage(file('image/jpeg'), purpose);
    expect(big.ok && big.image).toMatchObject({ width: edge, height: edge / 2 });
    stubBitmap(100, 80);
    const small = await prepareUploadImage(file('image/jpeg'), purpose);
    expect(small.ok && small.image).toMatchObject({ width: 100, height: 80 });
  });

  it('長辺を渡すと用途の長辺の代わりにそれで縮める (モバイル注文の店のカバー: 用途 storefront・1280)', async () => {
    stubBitmap(3000, 1500);
    const cover = await prepareUploadImage(file('image/jpeg'), 'storefront', STOREFRONT_COVER_MAX_EDGE);
    expect(STOREFRONT_COVER_MAX_EDGE).toBe(1280);
    expect(cover.ok && cover.image).toMatchObject({ width: 1280, height: 640 });
    // 渡さなければ用途の長辺 (店のアイコン 512)。
    const icon = await prepareUploadImage(file('image/jpeg'), 'storefront');
    expect(icon.ok && icon.image).toMatchObject({ width: 512, height: 256 });
    // 小さい画像は拡大しない。
    stubBitmap(600, 300);
    const small = await prepareUploadImage(file('image/jpeg'), 'storefront', STOREFRONT_COVER_MAX_EDGE);
    expect(small.ok && small.image).toMatchObject({ width: 600, height: 300 });
  });

  it('透けない PNG・WebP は JPEG にする (描いた画素で確かめる)', async () => {
    stubBitmap(800, 600);
    for (const type of ['image/png', 'image/webp']) {
      toBlobCalls = [];
      const result = await prepareUploadImage(file(type), 'product');
      expect(result.ok && result.image.type).toBe('image/jpeg');
      expect(toBlobCalls[0].type).toBe('image/jpeg');
    }
    expect(context!.getImageData).toHaveBeenCalledWith(0, 0, 800, 600);
  });

  it.each([
    ['JPEG と宣言した (.jpg の名前の) 透過のある画像は PNG', 'image/jpeg', 0, 'image/png'],
    ['PNG と宣言した透けない画像は JPEG', 'image/png', 255, 'image/jpeg'],
    ['type の無い透過のある画像は PNG', '', 128, 'image/png'],
  ] as const)('形式は宣言ではなく描いた画素で決める: %s', async (_label, declared, pixelAlpha, expected) => {
    stubBitmap(800, 600);
    alpha = pixelAlpha;
    const result = await prepareUploadImage(file(declared), 'product');
    expect(result.ok && result.image.type).toBe(expected);
    expect(toBlobCalls[0].type).toBe(expected);
  });

  it('透過のある画像は PNG のまま (透過を保つ)', async () => {
    stubBitmap(800, 600);
    alpha = 0;
    const result = await prepareUploadImage(file('image/png'), 'product');
    expect(result.ok && result.image).toMatchObject({ type: 'image/png', width: 800, height: 600 });
    expect(toBlobCalls).toEqual([{ type: 'image/png', quality: undefined, width: 800, height: 600 }]);
    expect(context!.fillRect).not.toHaveBeenCalled();
  });

  it('JPEG が 1 MiB を超えたら品質 0.6 でもう一度・それでも超えたら too_large', async () => {
    stubBitmap(1280, 1280);
    blobSizes = [IMAGE_UPLOAD_MAX_BYTES + 1, MiB - 10];
    const retried = await prepareUploadImage(file('image/jpeg'), 'product');
    expect(toBlobCalls.map((call) => call.quality)).toEqual([0.85, 0.6]);
    expect(retried.ok && retried.image.blob.size).toBe(MiB - 10);

    toBlobCalls = [];
    blobSizes = [2 * MiB, MiB + 1];
    expect(await prepareUploadImage(file('image/jpeg'), 'product')).toEqual({ ok: false, error: 'too_large' });
    expect(toBlobCalls).toHaveLength(UPLOAD_JPEG_QUALITIES.length);
  });

  it('透過の PNG が 1 MiB を超えたら縮めて作り直す (最大 3 回)・それでも超えたら too_large', async () => {
    stubBitmap(1280, 1280);
    alpha = 10;
    blobSizes = [4 * MiB, MiB - 1];
    const shrunk = await prepareUploadImage(file('image/png'), 'product');
    expect(shrunk.ok && shrunk.image.type).toBe('image/png');
    expect(toBlobCalls[1].width).toBeLessThan(1280);
    expect(toBlobCalls[1].width).toBeGreaterThanOrEqual(640);
    expect(shrunk.ok && shrunk.image.width).toBe(toBlobCalls[1].width);

    toBlobCalls = [];
    blobSizes = [4 * MiB];
    expect(await prepareUploadImage(file('image/png'), 'product')).toEqual({ ok: false, error: 'too_large' });
    expect(toBlobCalls).toHaveLength(UPLOAD_PNG_ATTEMPTS);
    expect(toBlobCalls.every((call) => call.type === 'image/png')).toBe(true);
  });

  it('作った形式が頼んだ形式でない (JPEG を作れないブラウザ)・canvas が無い・createImageBitmap が無いときは unsupported', async () => {
    stubBitmap(800, 600);
    blobTypeOverride = 'image/png';
    expect(await prepareUploadImage(file('image/jpeg'), 'product')).toEqual({ ok: false, error: 'unsupported' });

    blobTypeOverride = null;
    context = null;
    expect(await prepareUploadImage(file('image/jpeg'), 'product')).toEqual({ ok: false, error: 'unsupported' });

    vi.stubGlobal('createImageBitmap', undefined);
    expect(await prepareUploadImage(file('image/jpeg'), 'product')).toEqual({ ok: false, error: 'unsupported' });
  });

  it('画像として読めない file・描き直しの途中の例外は decode_failed (bitmap は閉じる)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new DOMException('bad', 'InvalidStateError'); }));
    expect(await prepareUploadImage(file('application/pdf'), 'product')).toEqual({ ok: false, error: 'decode_failed' });

    stubBitmap(800, 600);
    context!.drawImage.mockImplementation(() => { throw new RangeError('out of memory'); });
    expect(await prepareUploadImage(file('image/jpeg'), 'product')).toEqual({ ok: false, error: 'decode_failed' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
