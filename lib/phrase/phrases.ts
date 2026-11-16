// 日本語の文を文節で区切る (server だけで動く)。
// iPhone の Safari (WebKit) と Firefox は、文節で折る CSS (word-break: auto-phrase) を持たない。そこで server が区切りを計算し、
// components/Phrased.tsx が区切りに <wbr> を入れて渡す (折り方の指定は app/globals.css の .phrased)。
//
// 出どころ: BudouX (https://github.com/google/budoux) の javascript/src/parser.ts (tag v0.10.3) を書き直したもの。
//   Copyright 2021 Google LLC
//   Licensed under the Apache License, Version 2.0 (全文は lib/phrase/LICENSE)。
//   model は同じ tag の budoux/models/ja.json を 1 byte も変えずに置いた lib/phrase/budoux-ja.json (lib/phrase/README.md)。
//
// upstream と同じ所 (createBoundaryParser): 字の境ごとに、前後 3 字の特徴 (UW1〜6・BW1〜3・TW1〜4) の重みを足し、
//   base (= 全部の重みの和 × −0.5) を足した値が 0 より大きい所を区切りにする。surrogate pair (絵文字など) の上位と下位の間では区切らない。
// この file が足している決まり (model の出力をそのまま使わない所):
//   1. 禁則: 開き括弧の直後と、閉じ括弧・句読点・小さいかな・長音・繰り返しの記号の直前では区切らない
//      (model は「なります | （ | お試しにも」と出し、狭い画面で「…なります（ / お試しにもどうぞ）。」と折れた)。
//   2. 割らない語 (PHRASE_KEEP_WORDS): 表にある語の中では区切らない (model は「その | 場」「完結で | きます」と出す)。
//   3. つないだままにする組 (PHRASE_KEEP_RUNS): 文節で折れる Chromium の折れ方を変えないために、表にある並びの中では区切らない。
//   4. 書記素 (見た目の 1 字) の途中では区切らない (結合文字・異体字セレクタ・ZWJ でつないだ絵文字)。
//   5. 日本語の字 (ひらがな・カタカナ・漢字) を含まない文は、区切らずにそのまま返す。
// どの決まりも区切りを減らすだけで、字は 1 つも変えない (返した塊をつなぐと、元の文字列に戻る)。

import 'server-only';
import jaModel from './budoux-ja.json';

/** BudouX の model の形: 特徴の名前 (UW1 など) → 字の並び → 重み。 */
export type PhraseModel = Readonly<Record<string, Readonly<Record<string, number>>>>;

// 特徴ごとの、境 i から見た切り出しの範囲 (String.prototype.substring の引数)。文の端では substring が範囲を詰める
// (upstream と同じ動き)。
const FEATURES: readonly (readonly [name: string, from: number, to: number])[] = [
  ['UW1', -3, -2],
  ['UW2', -2, -1],
  ['UW3', -1, 0],
  ['UW4', 0, 1],
  ['UW5', 1, 2],
  ['UW6', 2, 3],
  ['BW1', -2, 0],
  ['BW2', -1, 1],
  ['BW3', 0, 2],
  ['TW1', -3, 0],
  ['TW2', -2, 1],
  ['TW3', -1, 2],
  ['TW4', 0, 3],
];

/**
 * model から「区切りの位置を返す関数」を作る (upstream の Parser.parseBoundaries と同じ式)。
 * 返す位置 i は「i 字目の前で区切る」(0 < i < 文の長さ・UTF-16 の単位)。禁則と割らない語は掛けない。
 */
export function createBoundaryParser(model: PhraseModel): (sentence: string) => number[] {
  const tables = new Map<string, Map<string, number>>();
  let total = 0;
  for (const [name, group] of Object.entries(model)) {
    tables.set(name, new Map(Object.entries(group)));
    for (const weight of Object.values(group)) total += weight;
  }
  const base = -0.5 * total;
  const features = FEATURES.map(([name, from, to]) => [tables.get(name), from, to] as const);

  return (sentence) => {
    const boundaries: number[] = [];
    for (let i = 1; i < sentence.length; i++) {
      // surrogate pair の上位と下位の間。
      if ((sentence.codePointAt(i - 1) ?? 0) > 0xffff) continue;
      let score = base;
      for (const [table, from, to] of features) {
        score += table?.get(sentence.substring(i + from, i + to)) ?? 0;
      }
      if (score > 0) boundaries.push(i);
    }
    return boundaries;
  };
}

// 禁則。直後で区切らない字 (開き括弧) と、直前で区切らない字 (閉じ括弧・句読点・小さいかな・長音・繰り返しの記号)。
const NO_BREAK_AFTER = new Set([...'（「『〔【［(']);
const NO_BREAK_BEFORE = new Set([...'）」』〕】］)、。，．・：；！？!?ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー々ゝゞ']);

/**
 * 割らない語。この並びの中では区切らない (前後の区切りはそのまま)。
 * トップ (messages/ja.json の Landing) の文を model に通して、語の途中に区切りが出たものだけを載せる (表は小さく保つ)。
 *   しくみ = 「しく | み」・できます = 「完結で | きます」・として = 「1 円と | して」・払い戻 = 「払い | 戻せます」・
 *   その場 = 「その | 場で、」・により = 「プランに | より | 異なります」
 */
export const PHRASE_KEEP_WORDS: readonly string[] = ['しくみ', 'できます', 'として', '払い戻', 'その場', 'により'];

/**
 * つないだままにする組。語の途中ではないが、この並びの中では区切らない (前後の区切りはそのまま)。
 * 文節で折れる Chromium (word-break: auto-phrase) の折れ方を、区切りを入れる前と同じに保つためのもの:
 * Chromium は <wbr> の所でも折れるので、Chromium 自身が折らない所に区切りを入れると、行が変わる。
 *   機器なしで今日から = 用途のカードの本文。区切り (機器なしで | 今日から。) を入れると、Chromium の幅 390 / 430px で
 *   「…少額も、 / 機器なしで今日から。」が「…少額も、機器なしで / 今日から。」になり、最後の行が短くなる。
 * 載せるのは、撮り比べて Chromium の行が変わった所だけ。
 */
export const PHRASE_KEEP_RUNS: readonly string[] = ['機器なしで今日から'];

// ひらがな・カタカナ (U+3040〜30FF) と漢字 (U+3400〜9FFF)。
const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/;

// 書記素 (見た目の 1 字) の区切り。結合文字 (NFD の濁点・半濁点)・異体字セレクタ・ZWJ でつないだ絵文字の途中を見分ける。
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/**
 * model の生の区切り (createBoundaryParser の結果・昇順) に、この file の決まりを掛ける。区切りを減らすだけで、順は変えない。
 *   - 禁則: 開き括弧の直後と、閉じ括弧・句読点・小さいかな・長音・繰り返しの記号の直前の区切りを消す。
 *   - 割らない語・つないだままにする組: 並びの中の区切りを消す。
 *   - 書記素の途中の区切りを消す (文字は正規化しない。NFD の「か + 濁点」の間で区切ると、濁点だけが次の行の頭に落ちる)。
 */
export function refinePhraseBoundaries(text: string, boundaries: readonly number[]): number[] {
  if (boundaries.length === 0) return [];
  const inside = new Set<number>();
  for (const run of [...PHRASE_KEEP_WORDS, ...PHRASE_KEEP_RUNS]) {
    for (let at = text.indexOf(run); at !== -1; at = text.indexOf(run, at + 1)) {
      for (let i = at + 1; i < at + run.length; i++) inside.add(i);
    }
  }
  const graphemeStarts = new Set<number>();
  for (const { index } of graphemes.segment(text)) graphemeStarts.add(index);
  return boundaries.filter(
    (i) => !NO_BREAK_AFTER.has(text[i - 1]) && !NO_BREAK_BEFORE.has(text[i]) && !inside.has(i) && graphemeStarts.has(i),
  );
}

const jaBoundaries = createBoundaryParser(jaModel);

/**
 * 日本語の文を文節の塊に分ける。返した塊をつなぐと、元の文字列に戻る (字も空白も変えない)。
 * 空の文は空の配列・日本語の字を含まない文と区切りの無い文は、その文 1 つだけの配列を返す。
 */
export function phrasesJa(text: string): string[] {
  if (text === '') return [];
  if (!JAPANESE.test(text)) return [text];

  const parts: string[] = [];
  let start = 0;
  for (const i of refinePhraseBoundaries(text, jaBoundaries(text))) {
    parts.push(text.slice(start, i));
    start = i;
  }
  parts.push(text.slice(start));
  return parts;
}
