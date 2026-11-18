// AI 出品アシスタントに送る画像の下ごしらえ (ブラウザだけ・依存なし)。選んだ画像を canvas に描き直し、長辺 1280px 以下の
// JPEG にする。描き直すので、元の file の位置情報 (EXIF の GPS など) や撮影の情報は送らない。server の上限
// (lib/store/listingAssistant の LISTING_ASSISTANT_IMAGE_MAX_BYTES = 1 MiB) を超えたら品質を下げてもう一度作り、
// それでも超えたら送らずに too_large を返す (画面が案内する)。

import { LISTING_ASSISTANT_IMAGE_MAX_BYTES, LISTING_ASSISTANT_IMAGE_MIME_TYPE } from '@/lib/store/listingAssistant';

export const LISTING_IMAGE_MAX_EDGE = 1280;
/** 1 回目の品質と、1 MiB を超えたときのもう 1 回の品質。 */
export const LISTING_IMAGE_QUALITIES = [0.85, 0.6] as const;

export type PreparedListingImage = {
  /** 標準の base64 (改行なし・data: の接頭辞なし)。 */
  data: string;
  bytes: number;
  width: number;
  height: number;
};

export type ListingImageError = 'decode_failed' | 'too_large' | 'unsupported';

export type PrepareListingImageResult =
  | { ok: true; image: PreparedListingImage }
  | { ok: false; error: ListingImageError };

function toJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, LISTING_ASSISTANT_IMAGE_MIME_TYPE, quality));
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(blob);
  });
}

export async function prepareListingImage(file: Blob): Promise<PrepareListingImageResult> {
  if (typeof createImageBitmap !== 'function') return { ok: false, error: 'unsupported' };
  let bitmap: ImageBitmap;
  try {
    // 既定の imageOrientation (from-image) で、スマホの写真の向き (EXIF) を描き直しにも反映する。
    bitmap = await createImageBitmap(file);
  } catch {
    // 画像として読めない file (PDF・壊れた画像・ブラウザが扱えない形式)。送らずに案内する。
    return { ok: false, error: 'decode_failed' };
  }
  try {
    if (!bitmap.width || !bitmap.height) return { ok: false, error: 'decode_failed' };
    const scale = Math.min(1, LISTING_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return { ok: false, error: 'unsupported' };
    // 透過の PNG をそのまま JPEG にすると透明な所が黒くなるので、白を敷いてから描く。
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    for (const quality of LISTING_IMAGE_QUALITIES) {
      const blob = await toJpegBlob(canvas, quality);
      // JPEG を作れないブラウザは PNG を返す (server は JPEG の先頭 byte だけを通す) ので送らない。
      if (!blob || blob.type !== LISTING_ASSISTANT_IMAGE_MIME_TYPE) return { ok: false, error: 'unsupported' };
      if (blob.size <= LISTING_ASSISTANT_IMAGE_MAX_BYTES) {
        return { ok: true, image: { data: await base64Of(blob), bytes: blob.size, width, height } };
      }
    }
    return { ok: false, error: 'too_large' };
  } catch {
    // 描き直しや読み取りの失敗 (大きすぎてメモリが足りない等) を画面の例外にせず、送らずに案内する (メモだけでは続けられる)。
    return { ok: false, error: 'decode_failed' };
  } finally {
    bitmap.close();
  }
}
