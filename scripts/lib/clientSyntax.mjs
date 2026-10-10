// build 後の client chunk (.next/static/**/*.js) に、Next の既定のブラウザターゲットより新しい構文が残っていないかを
// 調べる純関数 (scripts/check-client-syntax.mjs が使う・tests/scripts/check-client-syntax.test.ts が検査する)。
//
// 動機 (2026-10 本番 Sentry `SyntaxError: Unexpected token '{'`): Next は node_modules の構文を既定のターゲットへ
// 下げない。intl-messageformat (next-intl 経由) のクラスの static 初期化ブロック (ES2022) がそのまま [locale] の layout
// の chunk に入り、static ブロックを読めないブラウザ (Safari / iOS 16.4 未満・Chrome 94 未満・Firefox 93 未満) では
// chunk ごと読み込みに失敗して全ページの JS が止まっていた。vitest / dev / 新しいブラウザの e2e は全部通るので、
// ビルド成果物を見る以外に検出手段が無い (check-lua-bundle.mjs と同じ型)。
//
// 第三者の parser は足さない (CLAUDE.md 掟 16)。static ブロックは「クラスの要素の境目 ({ / } / ; / 行頭) の直後の
// `static` に `{` が続く」形だけで出る (minify 後は `}static{` `{static{` `;static{`)。`static(){}` (static という名前の
// メソッド)・`static:` (プロパティ)・`static x=…` (static フィールド)・`.static{` `isstatic{` は当たらない。文字列や
// コメントの中の同じ並びも当たるが、その場合は失敗が出るだけ (黙って通ることはない) なので、表示された前後の文字列を見て
// 判断する。

// 境目の直後 (空白・改行を挟んでよい) の `static` + `{`。m フラグで行頭 (ASI で区切られた非 minify のクラス) も拾う。
const STATIC_BLOCK = /(?:[{};]|^)\s*static\s*\{/gm;

/**
 * source の中のクラスの static 初期化ブロックの位置を返す (無ければ空配列)。
 * line / column は 1 始まりで、ブラウザ (Sentry) が報告する `{` の位置に合わせる。
 * @param {string} source
 * @returns {Array<{ line: number, column: number, sample: string }>}
 */
export function findStaticBlocks(source) {
  const hits = [];
  for (const match of source.matchAll(STATIC_BLOCK)) {
    const brace = match.index + match[0].length - 1;
    const lineStart = source.lastIndexOf('\n', brace) + 1;
    hits.push({
      line: source.slice(0, brace).split('\n').length,
      column: brace - lineStart + 1,
      sample: source.slice(Math.max(0, brace - 60), brace + 40).replace(/\s+/g, ' '),
    });
  }
  return hits;
}
