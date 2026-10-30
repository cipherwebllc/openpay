// @vitest-environment node
// scripts/check-lua-bundle.mjs の「連結」検査 (scripts/lib/luaBundleComposition.mjs) の単体テスト。
// minifier は 1 文字の変数名を関数ごとに使い回すので、CAS の中の変数はその場所から見えている宣言で値を求める
// (ファイルのどこかの同名の定義で通すと、CAS の中の変数が空でも green になる・Codex の指摘)。
import { describe, expect, it } from 'vitest';
import { hasComposition } from '../../scripts/lib/luaBundleComposition.mjs';

const AFTER = "if checked and claim==-5 then restoreBlocked='url_taken' end; end; end; ";
const FRAGMENT =
  "if (not hidden) or (ARGV[4]=='violation' and failures>=3) or (ARGV[5]=='block' and authFailures>=6) " +
  'then o.pendingFirstVerification=nil end; ';
const SAVE = "redis.call('SET',KEYS[1],cjson.encode(o)); ";
const q = (value: string) => JSON.stringify(value);
// 本番のバンドルと同じ形の定数 (閾値は String(n) のまま残る)。
const FRAGMENT_EXPR =
  q("if (not hidden) or (ARGV[4]=='violation' and failures>=") + '+String(3)+' +
  q(") or (ARGV[5]=='block' and authFailures>=") + '+String(6)+' +
  q(') then o.pendingFirstVerification=nil end; ');
const check = (source: string) => hasComposition(source, AFTER, FRAGMENT);

describe('hasComposition (check-lua-bundle の連結検査)', () => {
  it('Codex の再現: 別の関数の P が正しい断片でも、CAS の中の P が空なら不合格', () => {
    const source =
      `function unrelated(){let P=${FRAGMENT_EXPR};return P}` +
      `function cas(){let P="";return ${q('local c; ' + AFTER)}+P+${q(SAVE)}}`;
    expect(check(source)).toBe(false);
  });

  it('畳み込まれた形 (文字列と String(n) の連結) は合格', () => {
    const source =
      `const J=${q('local c; ' + AFTER + "if (not hidden) or (ARGV[4]=='violation' and failures>=")}+String(3)+` +
      `${q(") or (ARGV[5]=='block' and authFailures>=")}+String(6)+` +
      `${q(') then o.pendingFirstVerification=nil end; ' + SAVE)};`;
    expect(check(source)).toBe(true);
  });

  it('変数の形 (本番のバンドルと同じ webpack の module の中の "+I+G+") は合格', () => {
    const source =
      `"use strict";exports.modules={1805:(e,t,r)=>{r.d(t,{A:()=>J});` +
      `let I=${FRAGMENT_EXPR},G=${q(SAVE)},J=${q('local c; ' + AFTER)}+I+G+${q('if before and not hidden then end; ')}}};`;
    expect(check(source)).toBe(true);
  });

  it('変数の値が断片と違う (閾値・nil 代入の欠落) なら不合格', () => {
    for (const wrong of [FRAGMENT.replace('failures>=3', 'failures>=2'), FRAGMENT.replace(' o.pendingFirstVerification=nil', '')]) {
      const source = `let I=${q(wrong)},J=${q(AFTER)}+I+${q(SAVE)};`;
      expect(check(source)).toBe(false);
    }
  });

  it.each([
    ['関数の中の P が外の P を隠す (中が空)', `let P=${FRAGMENT_EXPR};function cas(){let P="";return ${q(AFTER)}+P}`, false],
    ['関数の中の P が外の P を隠す (中が正しい)', `let P="";function cas(){let P=${FRAGMENT_EXPR};return ${q(AFTER)}+P}`, true],
    ['ブロックの P が外の P を隠す (中が正しい)', `let P="";{let P=${FRAGMENT_EXPR};x=${q(AFTER)}+P}`, true],
    ['ブロックの P が外の P を隠す (中が空)', `let P=${FRAGMENT_EXPR};{let P="";x=${q(AFTER)}+P}`, false],
    ['引数の P は値をたどらない', `let P=${FRAGMENT_EXPR};function cas(P){return ${q(AFTER)}+P}`, false],
    ['var の宣言が使う場所より後', `function cas(){var J=${q(AFTER)}+P;var P=${FRAGMENT_EXPR}}`, false],
    ['関数の本文の直下に var が 1 つだけなら値をたどる', `function cas(){var P=${FRAGMENT_EXPR};var J=${q(AFTER)}+P}`, true],
    // 重複した var は、どの初期化式が実行されたかを追わずに不合格 (使う場所より前の最も近い宣言も使わない)。
    ['同じ関数に var が 2 つ (後ろが正しくても)', `function cas(){var P="";var P=${FRAGMENT_EXPR};var J=${q(AFTER)}+P}`, false],
    ['局所の String は値を求めない', `const String=()=>"9";let I=${FRAGMENT_EXPR};x=${q(AFTER)}+I`, false],
  ])('%s', (_name, source, expected) => {
    expect(check(source)).toBe(expected);
  });

  // Codex 3 回目 (1): 宣言の後の書き換え。値は初期化式だけで決めるので、書き換えがあれば値を求めない。
  it.each([
    ['代入', 'P=""'],
    ['複合代入', 'P+=""'],
    ['分割代入 (配列)', '[P]=[""]'],
    ['分割代入 (object)', '({P}={P:""})'],
    ['++', 'P++'],
    ['入れ子の関数の中の代入', '(()=>{P=""})()'],
  ])('書き換え (%s) のある変数は値を求めない', (_name, write) => {
    expect(check(`function cas(){let P=${FRAGMENT_EXPR};${write};return ${q(AFTER)}+P+${q(SAVE)}}`)).toBe(false);
  });

  it('同じ名前でも別の宣言 (内側の P) への書き込みは数えない', () => {
    expect(check(`function cas(){let P=${FRAGMENT_EXPR};function g(){let P=1;P=2}return ${q(AFTER)}+P}`)).toBe(true);
  });

  // Codex 3 回目 (2): 正しい連結が 1 か所あっても、別の場所の壊れた連結を隠さない。
  it('after を含む連結はすべて断片が続くこと (1 か所でも欠ければ不合格)', () => {
    expect(check(`let I=${FRAGMENT_EXPR};x=${q(AFTER)}+I+${q(SAVE)};y=${q(AFTER)}+""+${q(SAVE)}`)).toBe(false);
    expect(check(`let I=${FRAGMENT_EXPR};x=${q(AFTER)}+I+${q(SAVE)};y=${q(AFTER)}+I`)).toBe(true);
  });

  // Codex 3 回目 (3): 条件の中の var。どの初期化式が実行されたかは追わない。
  it.each([
    ['if の中の 2 つ目の var', `function cas(){var P="";if(false){var P=${FRAGMENT_EXPR}}return ${q(AFTER)}+P}`],
    ['if の中の 1 つだけの var', `function cas(){if(true){var P=${FRAGMENT_EXPR}}return ${q(AFTER)}+P}`],
    ['try の中の var', `function cas(){try{var P=${FRAGMENT_EXPR}}catch(e){}return ${q(AFTER)}+P}`],
    ['ラベルの中の var', `function cas(){a:{var P=${FRAGMENT_EXPR}}return ${q(AFTER)}+P}`],
  ])('%s は値を求めない', (_name, source) => {
    expect(check(source)).toBe(false);
  });

  it('after が無い・連結されていない (別の文の文字列) なら不合格', () => {
    expect(check(`let I=${FRAGMENT_EXPR};`)).toBe(false);
    expect(check(`let I=${FRAGMENT_EXPR};const a=${q(AFTER)};const b=I;`)).toBe(false);
  });
});
