// アイコン生成スクリプト。source PNG (1:1 正方形) から以下を生成:
//   - public/icon-512.png       (512x512、any purpose、source をそのまま resize)
//   - public/icon-maskable.png  (512x512、full-bleed 白背景、source 中身を 70% で内側に配置)
//   - public/apple-touch-icon.png (180x180)
//   - app/favicon.ico            (32x32 PNG を ICO container で wrap、Vista+/IE6+ 対応)
//
// source は `--source <path>` で指定 (デフォルト: ~/Desktop/openpay.png)。
// 既存アセットを overwrite するため、ブランド変更時はこの script を一度回せば全サイズが揃う。
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const sourceIdx = args.indexOf('--source');
const SOURCE =
  sourceIdx >= 0 ? args[sourceIdx + 1] : join(homedir(), 'Desktop', 'openpay.png');

console.log(`source: ${SOURCE}`);

// 1) 通常アイコン (any purpose) — source をそのまま resize
await sharp(SOURCE).resize(512, 512).png().toFile(join(ROOT, 'public/icon-512.png'));
console.log('wrote public/icon-512.png');

// 2) Apple touch icon
await sharp(SOURCE)
  .resize(180, 180)
  .png()
  .toFile(join(ROOT, 'public/apple-touch-icon.png'));
console.log('wrote public/apple-touch-icon.png');

// 3) Maskable アイコン
//   - source の外側に丸枠 + 細い黒線があるため、内側 88% を crop して枠を除去
//   - 512x512 の白 canvas に 70% (= 358px) で center 配置 → 安全領域 80% 内に収まる
const meta = await sharp(SOURCE).metadata();
const cropSize = Math.round(meta.width * 0.88);
const cropOffset = Math.round((meta.width - cropSize) / 2);
const innerSize = 358; // 512 * 0.70 ≈ 358
const innerOffset = Math.round((512 - innerSize) / 2);

const innerBuf = await sharp(SOURCE)
  .extract({ left: cropOffset, top: cropOffset, width: cropSize, height: cropSize })
  .resize(innerSize, innerSize)
  .png()
  .toBuffer();

await sharp({
  create: {
    width: 512,
    height: 512,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  },
})
  .composite([{ input: innerBuf, top: innerOffset, left: innerOffset }])
  .png()
  .toFile(join(ROOT, 'public/icon-maskable.png'));
console.log('wrote public/icon-maskable.png');

// 4) favicon.ico — 32x32 PNG を ICO container に wrap
//   ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + PNG data
//   PNG-in-ICO は Vista / IE6+ 以降で標準サポート (Microsoft 仕様)
const faviconPng = await sharp(SOURCE).resize(32, 32).png().toBuffer();

const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0); // reserved
iconDir.writeUInt16LE(1, 2); // type = 1 (ICO)
iconDir.writeUInt16LE(1, 4); // image count

const iconDirEntry = Buffer.alloc(16);
iconDirEntry.writeUInt8(32, 0); // width
iconDirEntry.writeUInt8(32, 1); // height
iconDirEntry.writeUInt8(0, 2); // color palette count (0 for non-paletted)
iconDirEntry.writeUInt8(0, 3); // reserved
iconDirEntry.writeUInt16LE(1, 4); // color planes
iconDirEntry.writeUInt16LE(32, 6); // bits per pixel
iconDirEntry.writeUInt32LE(faviconPng.length, 8); // image data size
iconDirEntry.writeUInt32LE(22, 12); // offset to image data (6 + 16)

const ico = Buffer.concat([iconDir, iconDirEntry, faviconPng]);
await writeFile(join(ROOT, 'app/favicon.ico'), ico);
console.log('wrote app/favicon.ico');

console.log('done');
