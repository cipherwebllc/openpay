#!/usr/bin/env node
// @handle プロフィールの字体 (serif / rounded) を self-host する素材を作り直す。
// 入手と展開は使い捨てディレクトリで行い、展開物のスクリプトは実行しない (この script は
// package.json と CSS をデータとして読むだけ)。手順は docs/SUPPLY_CHAIN_RISKS.md
// 「依存外で同梱している第三者ファイル」。
//
//   node scripts/gen-handle-fonts.mjs <noto-serif-jp の package/> <zen-maru-gothic の package/>
//
// 入力: @fontsource-variable/noto-serif-jp の wght.css と @fontsource/zen-maru-gothic の
// 400.css / 700.css (= unicode-range つきの @font-face)。
// 出力: public/fonts/handle/ (一度消して作り直す: woff2 と OFL) と components/handleFonts.css。
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [serifPkg, maruPkg] = process.argv.slice(2);
if (!serifPkg || !maruPkg) {
  console.error('usage: node scripts/gen-handle-fonts.mjs <noto-serif-jp package dir> <zen-maru-gothic package dir>');
  process.exit(1);
}

const repo = fileURLToPath(new URL('..', import.meta.url));
const outRoot = join(repo, 'public/fonts/handle');

function pkgInfo(dir, expectedName) {
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (p.name !== expectedName) throw new Error(`${dir}: expected ${expectedName}, got ${p.name}`);
  if (p.license !== 'OFL-1.1') throw new Error(`${p.name}: license is ${p.license}, not OFL-1.1`);
  if (p.scripts && Object.keys(p.scripts).length > 0) throw new Error(`${p.name}: has scripts`);
  return p;
}

const RANGE_RE = /^U\+[0-9a-fA-F]+(?:-[0-9a-fA-F]+)?(?:,U\+[0-9a-fA-F]+(?:-[0-9a-fA-F]+)?)*$/;

function parseFaces(cssPath) {
  const css = readFileSync(cssPath, 'utf8');
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, block]) => {
    const get = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*([^;]+);`));
      if (!m) throw new Error(`${cssPath}: missing ${key}`);
      return m[1].trim();
    };
    const file = get('src').match(/url\(\.\/files\/([a-z0-9-]+\.woff2)\)/)?.[1];
    if (!file) throw new Error(`${cssPath}: no woff2 url`);
    const range = get('unicode-range').replace(/\s+/g, '');
    if (!RANGE_RE.test(range)) throw new Error(`${cssPath}: unexpected unicode-range for ${file}`);
    return { style: get('font-style'), weight: get('font-weight'), file, range };
  });
}

const serif = pkgInfo(serifPkg, '@fontsource-variable/noto-serif-jp');
const maru = pkgInfo(maruPkg, '@fontsource/zen-maru-gothic');
const serifDir = `noto-serif-jp-${serif.version}`;
const maruDir = `zen-maru-gothic-${maru.version}`;

const serifFaces = parseFaces(join(serifPkg, 'wght.css'));
const maruFaces = [...parseFaces(join(maruPkg, '400.css')), ...parseFaces(join(maruPkg, '700.css'))];
if (serifFaces.some((f) => f.weight !== '200 900' || f.style !== 'normal')) throw new Error('serif: unexpected face');
if (maruFaces.some((f) => !['400', '700'].includes(f.weight) || f.style !== 'normal')) throw new Error('rounded: unexpected face');

rmSync(outRoot, { recursive: true, force: true });

function copyFaces(faces, pkgDir, dir) {
  mkdirSync(join(outRoot, dir), { recursive: true });
  let bytes = 0;
  for (const f of faces) {
    const from = join(pkgDir, 'files', f.file);
    if (readFileSync(from).subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`${f.file}: not woff2`);
    copyFileSync(from, join(outRoot, dir, f.file));
    bytes += statSync(from).size;
  }
  return bytes;
}

const bytes = copyFaces(serifFaces, serifPkg, serifDir) + copyFaces(maruFaces, maruPkg, maruDir);
copyFileSync(join(serifPkg, 'LICENSE'), join(outRoot, 'OFL-NotoSerifJP.txt'));
copyFileSync(join(maruPkg, 'LICENSE'), join(outRoot, 'OFL-ZenMaruGothic.txt'));

// CSS 上の family 名は自前の別名 (端末に同名フォントが入っていても取り違えない)。
const SERIF_FAMILY = 'OpenPay Handle Serif';
const ROUNDED_FAMILY = 'OpenPay Handle Rounded';

const face = (family, weight, dir, f) => [
  '@font-face {',
  `  font-family: '${family}';`,
  '  font-style: normal;',
  `  font-weight: ${weight};`,
  '  font-display: swap;',
  `  src: url('/fonts/handle/${dir}/${f.file}') format('woff2');`,
  `  unicode-range: ${f.range};`,
  '}',
].join('\n');

const header = `/*
 * @handle プロフィールの字体 (serif = Noto Serif JP / rounded = Zen Maru Gothic) を self-host する。
 * 生成物 — 手で編集しない (scripts/gen-handle-fonts.mjs が作る)。入手元・更新手順は
 * docs/SUPPLY_CHAIN_RISKS.md「依存外で同梱している第三者ファイル」。
 * - ${serif.name}@${serif.version} の wght.css と ${maru.name}@${maru.version} の 400.css / 700.css から
 *   @font-face を写し、src を public/fonts/handle/ の woff2 に向けた (woff の fallback は持たない)。
 *   unicode-range は fontsource の CSS のまま。next/font/google が Google から取っていた CSS と同じ
 *   分割 (2026-10 に照合・違いは latin-ext の末尾 U+20C1-20C4 だけ)。ブラウザは表示する字を含む
 *   スライスだけを取りに行く。
 * - Noto Serif JP は可変フォント (wght 軸) 1 本を font-weight 400 / 700 の 2 組で宣言する。範囲
 *   (200 900) で宣言すると font-semibold が 600 で描かれ、静的 400/700 だった next/font/google 時代と
 *   字の太さが変わるため (2 組とも同じ URL なので取得は 1 回)。
 * - フォントは SIL Open Font License 1.1: public/fonts/handle/OFL-*.txt。
 */`;

const classes = `.handle-font-serif {
  font-family: '${SERIF_FAMILY}', 'Hiragino Mincho ProN', 'Yu Mincho', Georgia, serif;
}

.handle-font-rounded {
  font-family: '${ROUNDED_FAMILY}', 'Hiragino Maru Gothic ProN', 'BIZ UDPGothic', system-ui, sans-serif;
}
`;

const blocks = [
  ...[400, 700].flatMap((w) => serifFaces.map((f) => face(SERIF_FAMILY, w, serifDir, f))),
  ...maruFaces.map((f) => face(ROUNDED_FAMILY, f.weight, maruDir, f)),
];
const css = [header, ...blocks, classes].join('\n\n');
writeFileSync(join(repo, 'components/handleFonts.css'), css);

const woff2 = readdirSync(join(outRoot, serifDir)).length + readdirSync(join(outRoot, maruDir)).length;
console.log(`woff2 ${woff2} files / ${(bytes / 1024 / 1024).toFixed(2)} MiB, @font-face ${blocks.length}, css ${css.length} chars`);
