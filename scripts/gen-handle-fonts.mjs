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
// 展開物は信用しない: 検査 (名前・ライセンス・scripts・版・woff2 の中身・書き込み先) をすべて
// 終えてから消して書く。検査で止まったときは既存の public/fonts/handle/ がそのまま残る。
// 書き出すのは削除の前にメモリへ読んだ中身 (入力が既存フォントを指していても、削除で読み元が
// 消えて一式を失うことがない)。
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const RANGE_RE = /^U\+[0-9a-fA-F]+(?:-[0-9a-fA-F]+)?(?:,U\+[0-9a-fA-F]+(?:-[0-9a-fA-F]+)?)*$/;

/** 書き込み先が root の内側 (root 自身は除く) にあることを確かめる。外なら中断。 */
export function assertInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write outside ${root}: ${target}`);
  }
  return target;
}

function pkgInfo(dir, expectedName) {
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (p.name !== expectedName) throw new Error(`${dir}: expected ${expectedName}, got ${p.name}`);
  if (p.license !== 'OFL-1.1') throw new Error(`${p.name}: license is ${p.license}, not OFL-1.1`);
  if (p.scripts && Object.keys(p.scripts).length > 0) throw new Error(`${p.name}: has scripts`);
  // version はディレクトリ名・URL・CSS に入る。`5.3.0/../../x` のような値で
  // public/fonts/handle/ の外へ書かせない。
  if (typeof p.version !== 'string' || !SEMVER_RE.test(p.version)) {
    throw new Error(`${p.name}: version is not plain SemVer`);
  }
  return p;
}

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

const header = (serif, maru) => `/*
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

/**
 * 展開済みの 2 package から <repo>/public/fonts/handle/ と <repo>/components/handleFonts.css を
 * 作り直す。repo は出力先のリポジトリ root (テストでは一時ディレクトリ)。
 */
export function generateHandleFonts({ serifPkg, maruPkg, repo }) {
  const outRoot = join(repo, 'public/fonts/handle');
  const serif = pkgInfo(serifPkg, '@fontsource-variable/noto-serif-jp');
  const maru = pkgInfo(maruPkg, '@fontsource/zen-maru-gothic');
  const serifDir = `noto-serif-jp-${serif.version}`;
  const maruDir = `zen-maru-gothic-${maru.version}`;

  const serifFaces = parseFaces(join(serifPkg, 'wght.css'));
  const maruFaces = [...parseFaces(join(maruPkg, '400.css')), ...parseFaces(join(maruPkg, '700.css'))];
  if (serifFaces.length === 0 || serifFaces.some((f) => f.weight !== '200 900' || f.style !== 'normal')) {
    throw new Error('serif: unexpected face');
  }
  if (maruFaces.length === 0 || maruFaces.some((f) => !['400', '700'].includes(f.weight) || f.style !== 'normal')) {
    throw new Error('rounded: unexpected face');
  }

  // 消す前に、書くものをすべて決めて検査する。
  const dirs = [serifDir, maruDir].map((dir) => assertInside(outRoot, join(outRoot, dir)));
  const copies = [
    ...serifFaces.map((f) => ({ from: join(serifPkg, 'files', f.file), to: join(outRoot, serifDir, f.file), woff2: true })),
    ...maruFaces.map((f) => ({ from: join(maruPkg, 'files', f.file), to: join(outRoot, maruDir, f.file), woff2: true })),
    { from: join(serifPkg, 'LICENSE'), to: join(outRoot, 'OFL-NotoSerifJP.txt'), woff2: false },
    { from: join(maruPkg, 'LICENSE'), to: join(outRoot, 'OFL-ZenMaruGothic.txt'), woff2: false },
  ];
  // 入力は通常ファイルだけ (シンボリックリンクは拒否)。検査した中身をそのまま保持して、削除の後に
  // このバッファから書く — 入力 (や files/ ディレクトリ) が出力先を指していても読み元を失わない。
  let bytes = 0;
  const writes = copies.map((c) => {
    assertInside(outRoot, c.to);
    if (!lstatSync(c.from).isFile()) throw new Error(`${c.from}: not a regular file`);
    const data = readFileSync(c.from);
    if (c.woff2) {
      if (data.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`${c.from}: not woff2`);
      bytes += data.length;
    } else if (!data.toString('utf8').includes('SIL OPEN FONT LICENSE Version 1.1')) {
      throw new Error(`${c.from}: not the OFL 1.1 text`);
    }
    return { to: c.to, data };
  });

  const blocks = [
    ...[400, 700].flatMap((w) => serifFaces.map((f) => face(SERIF_FAMILY, w, serifDir, f))),
    ...maruFaces.map((f) => face(ROUNDED_FAMILY, f.weight, maruDir, f)),
  ];
  const css = [header(serif, maru), ...blocks, classes].join('\n\n');

  rmSync(outRoot, { recursive: true, force: true });
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  for (const w of writes) writeFileSync(w.to, w.data);
  writeFileSync(join(repo, 'components/handleFonts.css'), css);

  return { woff2: copies.filter((c) => c.woff2).length, bytes, faces: blocks.length, cssChars: css.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [serifPkg, maruPkg] = process.argv.slice(2);
  if (!serifPkg || !maruPkg) {
    console.error('usage: node scripts/gen-handle-fonts.mjs <noto-serif-jp package dir> <zen-maru-gothic package dir>');
    process.exit(1);
  }
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const r = generateHandleFonts({ serifPkg, maruPkg, repo });
  console.log(`woff2 ${r.woff2} files / ${(r.bytes / 1024 / 1024).toFixed(2)} MiB, @font-face ${r.faces}, css ${r.cssChars} chars`);
}
