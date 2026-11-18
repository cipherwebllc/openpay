// 画像の下ごしらえ (components/creator-store-seller/listingAssistantImage.ts)。jsdom に canvas の実装は無いので、
// createImageBitmap・getContext・toBlob を差し替えて、縮め方・品質を下げてのもう一度・送らない場合を確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LISTING_IMAGE_MAX_EDGE,
  LISTING_IMAGE_QUALITIES,
  prepareListingImage,
} from '@/components/creator-store-seller/listingAssistantImage';
import { LISTING_ASSISTANT_IMAGE_MAX_BYTES } from '@/lib/store/listingAssistant';

const MiB = 1024 * 1024;

type Context = {
  fillStyle: string;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
};

let context: Context | null;
let blobSizes: number[];
let blobType: string;
let toBlobCalls: { type: string | undefined; quality: number | undefined; width: number; height: number }[];
let close: ReturnType<typeof vi.fn>;

function stubBitmap(width: number, height: number) {
  close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close })));
}

beforeEach(() => {
  context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  blobSizes = [200_000];
  blobType = 'image/jpeg';
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
    // 先頭は JPEG の FF D8 FF E0 (server の検査と同じ)。
    const bytes = new Uint8Array(size);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    callback(new Blob([bytes], { type: blobType }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prepareListingImage', () => {
  it('長辺 1280px に縮め、白を敷いてから描き、JPEG の base64 を返す', async () => {
    stubBitmap(4032, 3024);
    const result = await prepareListingImage(new Blob(['x'], { type: 'image/heic' }));
    expect(LISTING_IMAGE_MAX_EDGE).toBe(1280);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image).toMatchObject({ width: 1280, height: 960, bytes: 200_000 });
    expect(atob(result.image.data).slice(0, 4)).toBe('\xff\xd8\xff\xe0');
    expect(result.image.data).not.toContain(',');
    expect(context!.fillStyle).toBe('#ffffff');
    expect(context!.fillRect).toHaveBeenCalledWith(0, 0, 1280, 960);
    expect(context!.drawImage).toHaveBeenCalledWith(expect.objectContaining({ width: 4032 }), 0, 0, 1280, 960);
    expect(toBlobCalls).toEqual([{ type: 'image/jpeg', quality: LISTING_IMAGE_QUALITIES[0], width: 1280, height: 960 }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('縦長も長辺で縮め、小さい画像は拡大しない', async () => {
    stubBitmap(1000, 3000);
    const tall = await prepareListingImage(new Blob(['x']));
    expect(tall.ok && tall.image).toMatchObject({ width: 427, height: 1280 });
    stubBitmap(640, 480);
    const small = await prepareListingImage(new Blob(['x']));
    expect(small.ok && small.image).toMatchObject({ width: 640, height: 480 });
  });

  it('1 MiB を超えたら品質を下げてもう一度作る', async () => {
    stubBitmap(1280, 1280);
    blobSizes = [LISTING_ASSISTANT_IMAGE_MAX_BYTES + 1, MiB - 10];
    const result = await prepareListingImage(new Blob(['x']));
    expect(toBlobCalls.map((call) => call.quality)).toEqual([0.85, 0.6]);
    expect(result.ok && result.image.bytes).toBe(MiB - 10);
  });

  it('それでも 1 MiB を超えたら送らない (too_large)', async () => {
    stubBitmap(1280, 1280);
    blobSizes = [2 * MiB, MiB + 1];
    expect(await prepareListingImage(new Blob(['x']))).toEqual({ ok: false, error: 'too_large' });
    expect(toBlobCalls).toHaveLength(LISTING_IMAGE_QUALITIES.length);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('画像として読めない file は decode_failed', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new DOMException('bad', 'InvalidStateError'); }));
    expect(await prepareListingImage(new Blob(['%PDF']))).toEqual({ ok: false, error: 'decode_failed' });
    expect(toBlobCalls).toEqual([]);
  });

  it('JPEG を作れない (PNG が返る)・canvas が無い・createImageBitmap が無いときは unsupported', async () => {
    stubBitmap(800, 600);
    blobType = 'image/png';
    expect(await prepareListingImage(new Blob(['x']))).toEqual({ ok: false, error: 'unsupported' });

    blobType = 'image/jpeg';
    context = null;
    expect(await prepareListingImage(new Blob(['x']))).toEqual({ ok: false, error: 'unsupported' });

    vi.stubGlobal('createImageBitmap', undefined);
    expect(await prepareListingImage(new Blob(['x']))).toEqual({ ok: false, error: 'unsupported' });
  });

  it('描き直しの途中の例外は画面に投げず decode_failed にする', async () => {
    stubBitmap(800, 600);
    context!.drawImage.mockImplementation(() => { throw new RangeError('out of memory'); });
    expect(await prepareListingImage(new Blob(['x']))).toEqual({ ok: false, error: 'decode_failed' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
