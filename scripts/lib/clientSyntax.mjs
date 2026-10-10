// build 後の client chunk (.next/static/**/*.js) に、Next の既定のブラウザターゲットより新しい構文が残っていないかを
// 調べる純関数 (scripts/check-client-syntax.mjs が使う・tests/scripts/check-client-syntax.test.ts が検査する)。
//
// 動機 (2026-10 本番 Sentry `SyntaxError: Unexpected token '{'`): Next は node_modules の構文を既定のターゲットへ
// 下げない。intl-messageformat (next-intl 経由) のクラスの static 初期化ブロック (ES2022) がそのまま [locale] の layout
// の chunk に入り、static ブロックを読めないブラウザ (Safari / iOS 16.4 未満・Chrome 94 未満・Firefox 93 未満) では
// chunk ごと読み込みに失敗して全ページの JS が止まっていた。vitest / dev / 新しいブラウザの e2e は全部通るので、
// ビルド成果物を見る以外に検出手段が無い (check-lua-bundle.mjs と同じ型)。
//
// 第三者の parser は足さない (CLAUDE.md 掟 16)。代わりに小さな字句走査をする:
//   - コメントは空白として扱う (`static/*x*/{` `static//x⏎{` も static ブロック)。
//   - 文字列・template の文字列部分・正規表現リテラルの中身は飛ばす (`"{static{"` `/{static{/` は当たらない)。
//     template の `${…}` の内側はコードとして走査する。
//   - `/` が正規表現の始まりか割り算かは直前のトークンで決める (識別子・数値・文字列・`)` `]` `}` の後は割り算。
//     ただし if / while / for / with の `(…)` の後と、ブロックを閉じる `}` の後は正規表現)。
//   - `static` (`.static` のようなプロパティ名を除く) の次のトークンが `{` なら static ブロック。
// 走査が同期を失った形 (閉じていない文字列・コメント・正規表現・template・括弧、対応しない閉じ括弧) は error として
// 返し、呼び出し側は fail させる (読み違えた範囲に static ブロックが隠れて偽 green になるのを防ぐ・fail-closed)。

// 直後の `/` を正規表現として読むキーワード (式が続く)。
const EXPRESSION_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'yield', 'await', 'extends',
]);
// 直後の `{` がブロック、`/` が正規表現になるキーワード。
const BLOCK_KEYWORDS = new Set(['else', 'do', 'try', 'finally']);
// `(…)` の後に文 (正規表現で始まりうる) が続くキーワード。
const STATEMENT_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
// 直前がこれらなら `{` はブロック (閉じた後の `/` は正規表現)。それ以外の記号の後の `{` はオブジェクトリテラル。
const BLOCK_AFTER_PUNCT = new Set([')', ';', '{', '}', '=>']);
const CLOSER = { ')': '(', ']': '[', '}': '{' };

const isIdentStart = (c) => /[A-Za-z_$\\]/.test(c) || (c > '\u007f' && !/\s/.test(c));
const isIdentPart = (c) => /[\w$\\]/.test(c) || (c > '\u007f' && !/\s/.test(c));
const isLineTerminator = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;

function position(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return {
    line: source.slice(0, index).split('\n').length,
    column: index - lineStart + 1,
    sample: source.slice(Math.max(0, index - 60), index + 40).replace(/\s+/g, ' '),
  };
}

/** コメントの終わりの位置 (i は `/` の位置)。閉じていなければ -1。 */
function commentEnd(source, i) {
  if (source[i + 1] === '/') {
    let j = i + 2;
    while (j < source.length && !isLineTerminator(source[j])) j++;
    return j;
  }
  const end = source.indexOf('*/', i + 2);
  return end === -1 ? -1 : end + 2;
}

/** 空白とコメントを飛ばした次の位置 (閉じていないコメントはそこで止まる = 本体の走査が error にする)。 */
function skipTrivia(source, i) {
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const end = commentEnd(source, i);
      if (end === -1) return i;
      i = end;
      continue;
    }
    return i;
  }
}

/**
 * source を字句走査し、クラスの static 初期化ブロックの位置と、走査が同期を失った位置を返す。
 * line / column は 1 始まりで、ブラウザ (Sentry) が報告する `{` の位置に合わせる。error があればそこで走査をやめる。
 * @param {string} source
 * @returns {{ staticBlocks: Array<{ line: number, column: number, sample: string }>,
 *   error: null | { message: string, line: number, column: number, sample: string } }}
 */
export function scanClientSource(source) {
  const staticBlocks = [];
  // 開いている ( [ { と template の ${ (閉じる位置の判定と、閉じた後の `/` の読み方を持つ)。
  const stack = [];
  // 直前のトークン: regexAfter = 次の `/` を正規表現として読むか。value = 記号やキーワードそのもの (識別子は '')。
  let prev = { regexAfter: true, value: '', start: true };
  const fail = (message, index) => ({ staticBlocks, error: { message, ...position(source, index) } });
  const n = source.length;
  let i = 0;
  if (source.startsWith('#!')) while (i < n && !isLineTerminator(source[i])) i++;

  // template の文字列部分を読む (j は `` ` `` の直後か `${…}` を閉じる `}` の直後)。
  const templateChunk = (j, opener) => {
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        j += 2;
      } else if (c === '`') {
        prev = { regexAfter: false, value: '`' };
        return j + 1;
      } else if (c === '$' && source[j + 1] === '{') {
        stack.push({ open: '${', at: j });
        prev = { regexAfter: true, value: '${' };
        return j + 2;
      } else {
        j++;
      }
    }
    return -opener - 1;
  };

  while (i < n) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const end = commentEnd(source, i);
      if (end === -1) return fail('閉じていないコメント', i);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c) {
        if (source[j] === '\\') {
          // escape (CRLF の行継続は 3 文字)
          j += source[j + 1] === '\r' && source[j + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (source[j] === '\n' || source[j] === '\r') return fail('閉じていない文字列', i);
        j++;
      }
      if (j >= n) return fail('閉じていない文字列', i);
      i = j + 1;
      prev = { regexAfter: false, value: c };
      continue;
    }
    if (c === '`') {
      const next = templateChunk(i + 1, i);
      if (next < 0) return fail('閉じていない template', i);
      i = next;
      continue;
    }
    if (c === '/') {
      if (!prev.regexAfter) {
        i++;
        prev = { regexAfter: true, value: '/' };
        continue;
      }
      let j = i + 1;
      let inClass = false;
      for (;; j++) {
        if (j >= n || isLineTerminator(source[j])) return fail('閉じていない正規表現 (割り算との読み分けの誤りを含む)', i);
        const r = source[j];
        if (r === '\\') j++;
        else if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      j++;
      while (j < n && isIdentPart(source[j])) j++;
      i = j;
      prev = { regexAfter: false, value: '/re/' };
      continue;
    }
    if (isIdentStart(c) || (c === '#' && i + 1 < n && isIdentStart(source[i + 1]))) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      const property = c === '#' || prev.value === '.' || prev.value === '?.';
      if (word === 'static' && !property) {
        const k = skipTrivia(source, j);
        if (source[k] === '{') staticBlocks.push(position(source, k));
      }
      i = j;
      prev = property
        ? { regexAfter: false, value: '' }
        : { regexAfter: EXPRESSION_KEYWORDS.has(word) || BLOCK_KEYWORDS.has(word), value: word, word: true };
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(source[i + 1] ?? ''))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(source);
      i += m ? m[0].length : 1;
      while (i < n && isIdentPart(source[i])) i++;
      prev = { regexAfter: false, value: '' };
      continue;
    }
    if (c === '(' || c === '[') {
      stack.push({ open: c, at: i, statement: c === '(' && prev.word === true && STATEMENT_PAREN_KEYWORDS.has(prev.value) });
      i++;
      prev = { regexAfter: true, value: c };
      continue;
    }
    if (c === '{') {
      const block = prev.start === true
        || BLOCK_AFTER_PUNCT.has(prev.value)
        || (prev.word === true && !EXPRESSION_KEYWORDS.has(prev.value));
      stack.push({ open: '{', at: i, block });
      i++;
      prev = { regexAfter: true, value: '{' };
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (c === '}' && top?.open === '${') {
        const next = templateChunk(i + 1, top.at);
        if (next < 0) return fail('閉じていない template', top.at);
        i = next;
        continue;
      }
      if (top?.open !== CLOSER[c]) return fail(`対応しない ${c}`, i);
      i++;
      prev = { regexAfter: c === ')' ? top.statement : c === '}' ? top.block : false, value: c };
      continue;
    }
    // 記号。`/` の読み分けに効く複数文字の記号だけを 1 トークンにする。
    const two = source.slice(i, i + 2);
    if (two === '=>' || two === '++' || two === '--' || (two === '?.' && !/\d/.test(source[i + 2] ?? ''))) {
      i += 2;
      prev = { regexAfter: two === '=>', value: two };
      continue;
    }
    i++;
    prev = { regexAfter: true, value: c };
  }
  const open = stack.pop();
  if (open) return fail(open.open === '${' ? '閉じていない template (${…})' : `閉じていない ${open.open}`, open.at);
  return { staticBlocks, error: null };
}
