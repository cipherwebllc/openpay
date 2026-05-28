#!/usr/bin/env node
// public/landing/*.jpg を AVIF に再エンコード。
// Next/Image は AVIF を source としても受理し、配信時に WebP fallback まで自動。
// 実行後、jpg は削除し component の参照を .avif に書き換える運用。

import { readdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const DIR = new URL('../public/landing/', import.meta.url);

const files = (await readdir(DIR)).filter((f) => f.endsWith('.jpg'));

let totalBefore = 0;
let totalAfter = 0;

for (const f of files) {
  const src = join(DIR.pathname, f);
  const dst = src.replace(/\.jpg$/, '.avif');
  const beforeBuf = await readFile(src);
  const beforeSize = beforeBuf.byteLength;

  // quality=55 は AVIF の体感品質的に jpg q=85 相当、サイズは 40-60% 減を狙える定番値
  // effort=6 は encoder の探索努力 (0=最速, 9=最遅)。LP の静的 asset なので encode 時間より圧縮率重視
  const avifBuf = await sharp(beforeBuf).avif({ quality: 55, effort: 6 }).toBuffer();
  await writeFile(dst, avifBuf);
  const afterSize = avifBuf.byteLength;

  totalBefore += beforeSize;
  totalAfter += afterSize;

  const pct = ((1 - afterSize / beforeSize) * 100).toFixed(1);
  console.log(
    `${f.padEnd(36)}  ${(beforeSize / 1024).toFixed(1).padStart(7)} KB  ->  ${(
      afterSize / 1024
    )
      .toFixed(1)
      .padStart(7)} KB  (-${pct}%)`,
  );

  await unlink(src);
}

console.log(
  `\nTotal:  ${(totalBefore / 1024).toFixed(1)} KB  ->  ${(totalAfter / 1024).toFixed(1)} KB  (-${(
    (1 - totalAfter / totalBefore) *
    100
  ).toFixed(1)}%)`,
);
