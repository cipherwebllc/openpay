// 画像の下ごしらえ (ブラウザだけ・依存なし)。選んだ画像を canvas に描き直す — 描き直すので、元の file の位置情報
// (EXIF の GPS など) や撮影の情報は送らない。createImageBitmap の既定 (imageOrientation: from-image) で、スマホの写真の
// 向き (EXIF) も描き直しに反映する。
// - 共通の部品 (decodeImage・scaledSize・drawToCanvas・canvasBlob) は AI 出品アシスタント
//   (components/creator-store-seller/listingAssistantImage.ts・白を敷いた JPEG・base64) とアップロードで使う。
// - prepareUploadImage はアップロード用: 長辺は用途の定数 (lib/images/purpose の IMAGE_MAX_EDGE)・拡大しない・
//   写真は JPEG (品質 0.85 → 0.6)・透過のある画像は PNG (透過を保ち、1 MiB を超えたら縮めてもう一度)。

import { IMAGE_MAX_EDGE, IMAGE_UPLOAD_MAX_BYTES, type ImagePurpose, type ImageUploadMimeType } from '@/lib/images/purpose';

export type ImagePrepareError = 'decode_failed' | 'too_large' | 'unsupported';

export type DecodeImageResult = { ok: true; bitmap: ImageBitmap } | { ok: false; error: ImagePrepareError };

/** 画像を読む。createImageBitmap の無いブラウザは unsupported、画像として読めない file は decode_failed。 */
export async function decodeImage(file: Blob): Promise<DecodeImageResult> {
  if (typeof createImageBitmap !== 'function') return { ok: false, error: 'unsupported' };
  try {
    return { ok: true, bitmap: await createImageBitmap(file) };
  } catch {
    // 画像として読めない file (PDF・壊れた画像・ブラウザが扱えない形式)。送らずに案内する。
    return { ok: false, error: 'decode_failed' };
  }
}

/** 長辺を maxEdge に収める大きさ (拡大しない・1px 未満にしない)。 */
export function scaledSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** その大きさの canvas に描く。background を渡すと先に敷く (透過の所を JPEG で黒くしない)。2d の無いブラウザは null。 */
export function drawToCanvas(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  background?: string,
): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 描いた画像に透ける所 (alpha が 255 未満の画素) があるか。 */
export function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext('2d');
  if (!context) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) return true;
  }
  return false;
}

/** アップロードの JPEG の品質: 1 回目と、1 MiB を超えたときのもう 1 回。 */
export const UPLOAD_JPEG_QUALITIES = [0.85, 0.6] as const;
/** 透過の PNG を作る回数の上限 (1 回目 + 縮めて作り直す回数)。 */
export const UPLOAD_PNG_ATTEMPTS = 3;

export type PreparedUploadImage = {
  blob: Blob;
  type: ImageUploadMimeType;
  width: number;
  height: number;
};

export type PrepareUploadImageResult =
  | { ok: true; image: PreparedUploadImage }
  | { ok: false; error: ImagePrepareError };

// 1 MiB を超えた PNG を次に作る大きさの倍率 (面積で上限に収まる見込みより 1 割小さく・一度に半分より小さくしない)。
function shrinkFactor(bytes: number): number {
  return Math.min(0.9, Math.max(0.5, Math.sqrt(IMAGE_UPLOAD_MAX_BYTES / bytes) * 0.9));
}

export async function prepareUploadImage(file: Blob, purpose: ImagePurpose): Promise<PrepareUploadImageResult> {
  const decoded = await decodeImage(file);
  if (!decoded.ok) return decoded;
  const { bitmap } = decoded;
  try {
    if (!bitmap.width || !bitmap.height) return { ok: false, error: 'decode_failed' };
    let { width, height } = scaledSize(bitmap.width, bitmap.height, IMAGE_MAX_EDGE[purpose]);
    const canvas = drawToCanvas(bitmap, width, height);
    if (!canvas) return { ok: false, error: 'unsupported' };

    // JPEG の file は透けない。ほかの形式 (PNG・WebP) は描いた画素で確かめる。
    if (file.type === 'image/jpeg' || !hasTransparency(canvas)) {
      for (const quality of UPLOAD_JPEG_QUALITIES) {
        const blob = await canvasBlob(canvas, 'image/jpeg', quality);
        // JPEG を作れないブラウザは PNG を返す (宣言と中身を食い違わせない) ので送らない。
        if (!blob || blob.type !== 'image/jpeg') return { ok: false, error: 'unsupported' };
        if (blob.size <= IMAGE_UPLOAD_MAX_BYTES) return { ok: true, image: { blob, type: 'image/jpeg', width, height } };
      }
      return { ok: false, error: 'too_large' };
    }

    // 透過を保つ PNG。1 MiB を超えたら縮めて描き直す。
    let target: HTMLCanvasElement = canvas;
    for (let attempt = 0; attempt < UPLOAD_PNG_ATTEMPTS; attempt += 1) {
      const blob = await canvasBlob(target, 'image/png');
      if (!blob || blob.type !== 'image/png') return { ok: false, error: 'unsupported' };
      if (blob.size <= IMAGE_UPLOAD_MAX_BYTES) return { ok: true, image: { blob, type: 'image/png', width, height } };
      if (attempt === UPLOAD_PNG_ATTEMPTS - 1) break;
      const factor = shrinkFactor(blob.size);
      width = Math.max(1, Math.round(width * factor));
      height = Math.max(1, Math.round(height * factor));
      const smaller = drawToCanvas(bitmap, width, height);
      if (!smaller) return { ok: false, error: 'unsupported' };
      target = smaller;
    }
    return { ok: false, error: 'too_large' };
  } catch {
    // 描き直しや読み取りの失敗 (大きすぎてメモリが足りない等) を画面の例外にせず、送らずに案内する。
    return { ok: false, error: 'decode_failed' };
  } finally {
    bitmap.close();
  }
}
