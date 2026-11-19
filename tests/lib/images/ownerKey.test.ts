// @vitest-environment node
// 画像の置き場の path (lib/images/ownerKey)・先頭 byte の見分け (lib/images/sniff)・server の設定 (lib/images/config)。
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageBlobPath, imageOwnerKey, imageOwnerPrefix, newImageId } from '@/lib/images/ownerKey';
import { sniffImageType } from '@/lib/images/sniff';
import {
  imageBlobStoreConfigured,
  imageOwnerSecret,
  imageUploadAllowedFor,
  imageUploadAvailableFor,
  imageUploadMode,
} from '@/lib/images/config';
import { IMAGE_PURPOSES, isImagePurpose } from '@/lib/images/purpose';
import { secondsUntilNextUtcDay } from '@/lib/images/dailyCap';

const SECRET = 'test-image-owner-secret-0123456789abcdef';
const ADDRESS = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('imageOwnerKey', () => {
  it('HMAC-SHA256(秘密, openpay:image-owner:v1: + 小文字のアドレス) の先頭 128 bit を base64url の 22 文字にする', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`openpay:image-owner:v1:${ADDRESS.toLowerCase()}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    expect(imageOwnerKey(ADDRESS, SECRET)).toBe(expected);
    expect(imageOwnerKey(ADDRESS, SECRET)).toMatch(BASE64URL_22);
  });

  it('同じアドレスなら同じ・大文字小文字を同じにする', () => {
    expect(imageOwnerKey(ADDRESS, SECRET)).toBe(imageOwnerKey(ADDRESS, SECRET));
    expect(imageOwnerKey(ADDRESS.toLowerCase(), SECRET)).toBe(imageOwnerKey(ADDRESS, SECRET));
    expect(imageOwnerKey(`0x${ADDRESS.slice(2).toUpperCase()}`, SECRET)).toBe(imageOwnerKey(ADDRESS, SECRET));
  });

  it('秘密が違えば違う・アドレスが違えば違う・生のアドレスを含まない', () => {
    expect(imageOwnerKey(ADDRESS, `${SECRET}x`)).not.toBe(imageOwnerKey(ADDRESS, SECRET));
    expect(imageOwnerKey('0x2222222222222222222222222222222222222222', SECRET)).not.toBe(imageOwnerKey(ADDRESS, SECRET));
    expect(imageOwnerKey(ADDRESS, SECRET).toLowerCase()).not.toContain(ADDRESS.slice(2, 10).toLowerCase());
  });
});

describe('imageBlobPath', () => {
  it('v1/<ownerKey>/<purpose>/<id>.<jpg|png> の形で、短い (注文リンクの URL と QR に入る)', () => {
    const ownerKey = imageOwnerKey(ADDRESS, SECRET);
    const id = newImageId();
    expect(id).toMatch(BASE64URL_22);
    const jpg = imageBlobPath(ownerKey, 'product', id, 'image/jpeg');
    expect(jpg).toBe(`v1/${ownerKey}/product/${id}.jpg`);
    expect(jpg.startsWith(imageOwnerPrefix(ownerKey))).toBe(true);
    expect(imageBlobPath(ownerKey, 'storefront', id, 'image/png')).toBe(`v1/${ownerKey}/storefront/${id}.png`);
    // 一番長い用途でも 3 + 22 + 1 + 10 + 1 + 22 + 4 = 63 文字。
    for (const purpose of IMAGE_PURPOSES) {
      expect(imageBlobPath(ownerKey, purpose, id, 'image/jpeg').length).toBeLessThanOrEqual(63);
    }
  });

  it('id は毎回違う', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newImageId()));
    expect(ids.size).toBe(100);
  });

  it('用途は決めた 6 つだけ', () => {
    expect(IMAGE_PURPOSES).toEqual(['product', 'avatar', 'cover', 'link', 'preset', 'storefront']);
    expect(isImagePurpose('product')).toBe(true);
    for (const value of ['', 'Product', '../product', 'banner', null, 1]) expect(isImagePurpose(value)).toBe(false);
  });
});

describe('sniffImageType', () => {
  const withTail = (magic: number[]) => new Uint8Array([...magic, 0x00, 0x10]);
  it('先頭 byte で JPEG と PNG を見分け、ほかは null', () => {
    expect(sniffImageType(withTail([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffImageType(withTail([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe('server の設定', () => {
  it('段階は admin / all だけを読み、ほかは off (不正な値は 1 回だけ警告し、値を写さない)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [raw, mode] of [
      [undefined, 'off'],
      ['', 'off'],
      ['off', 'off'],
      ['admin', 'admin'],
      ['all', 'all'],
      ['ALL', 'off'],
      ['secret-looking-value', 'off'],
    ] as const) {
      vi.stubEnv('IMAGE_UPLOAD_MODE', raw);
      expect(imageUploadMode()).toBe(mode);
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-looking-value');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ALL');
  });

  it('秘密は 32 byte 以上だけ・Blob の store は空白を除いて空でないこと', () => {
    vi.stubEnv('IMAGE_OWNER_KEY_SECRET', 'x'.repeat(31));
    expect(imageOwnerSecret()).toBeNull();
    vi.stubEnv('IMAGE_OWNER_KEY_SECRET', 'x'.repeat(32));
    expect(imageOwnerSecret()).toBe('x'.repeat(32));
    vi.stubEnv('BLOB_STORE_ID', ' ');
    expect(imageBlobStoreConfigured()).toBe(false);
    vi.stubEnv('BLOB_STORE_ID', 'store_abc');
    expect(imageBlobStoreConfigured()).toBe(true);
  });

  it('admin は ADMIN_WALLETS の運営者だけ (空なら誰も)・all は全員・off は誰も', () => {
    vi.stubEnv('ADMIN_WALLETS', ADDRESS.toLowerCase());
    expect(imageUploadAllowedFor('admin', ADDRESS)).toBe(true);
    expect(imageUploadAllowedFor('admin', '0x2222222222222222222222222222222222222222')).toBe(false);
    expect(imageUploadAllowedFor('all', '0x2222222222222222222222222222222222222222')).toBe(true);
    expect(imageUploadAllowedFor('off', ADDRESS)).toBe(false);
    vi.stubEnv('ADMIN_WALLETS', '');
    expect(imageUploadAllowedFor('admin', ADDRESS)).toBe(false);
  });

  it('画面に出すか (imageUploadAvailableFor) は段階・権限・秘密・Blob のすべて', () => {
    vi.stubEnv('IMAGE_UPLOAD_MODE', 'admin');
    vi.stubEnv('ADMIN_WALLETS', ADDRESS);
    vi.stubEnv('IMAGE_OWNER_KEY_SECRET', SECRET);
    vi.stubEnv('BLOB_STORE_ID', 'store_abc');
    expect(imageUploadAvailableFor(ADDRESS)).toBe(true);
    vi.stubEnv('BLOB_STORE_ID', '');
    expect(imageUploadAvailableFor(ADDRESS)).toBe(false);
  });

  it('Retry-After は次の UTC 日までの秒数', () => {
    expect(secondsUntilNextUtcDay(Date.UTC(2026, 10, 19, 23, 0, 0))).toBe(3600);
    expect(secondsUntilNextUtcDay(Date.UTC(2026, 10, 19, 0, 0, 0))).toBe(86_400);
  });
});
