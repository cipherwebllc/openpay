import type { ImageUploadMimeType } from '@/lib/images/purpose';

// 本文の先頭 byte で JPEG / PNG を見分ける (宣言した Content-Type を信じない)。中身の完全なデコードはしない — 偽装した
// byte 列が置けても、配るのは Blob の別 origin (*.public.blob.vercel-storage.com) で、宣言した image/jpeg か image/png
// としてだけ。OpenPay の origin では実行されない (受け入れる限界)。

const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length > magic.length && magic.every((byte, index) => bytes[index] === byte);
}

export function sniffImageType(bytes: Uint8Array): ImageUploadMimeType | null {
  if (startsWith(bytes, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(bytes, PNG_MAGIC)) return 'image/png';
  return null;
}
