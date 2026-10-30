// scripts/check-lua-bundle.mjs の「連結」検査の純関数 (tests/scripts/check-lua-bundle.test.ts が検査する)。
//
// 目的: ビルド成果物の Lua (CAS) の中で、ある断片 `after` の直後に、期待する断片 `expected` が実際に連結されて
// いることを確かめる。minifier は単発の定数をその場に畳み込むか、変数のまま `"…"+X+"…"` で連結するので、
// `+` の連結を AST でたどり、変数は **使われた場所から見えている宣言** (レキシカルスコープ) を引いて値を求める。
// minifier は 1 文字の変数名を別の関数で使い回すので、ファイルのどこかにある同名の定義を拾うと、CAS の中の
// 変数が空でも別の関数の定義で通ってしまう (Codex の指摘・偽 green)。
//
// parser は既存の devDependency の typescript (tsc と tests/lib/luaTemplateFence.test.ts が使う) を使う。
// 新しい依存は足さない (CLAUDE.md 掟 16)。
//
// 値を求められる式: 文字列・数値・補間のある template・`+` の連結・括弧・`String(<値>)` (String が局所で
// 上書きされていないとき)・変数 (宣言の初期化式)。それ以外 (関数呼び出し・プロパティ・他の module からの import)
// は求められないので、そこで連結をたどるのをやめる = 期待する断片に届かなければ不合格 (fail-closed)。
//
// 偶発的な minifier の取りこぼしを見つけるための検査で、わざと騙すコードへの対策ではない。迷う形は不合格側に倒す:
//   - `after` を含む文字列は **すべて** 断片が続くこと (1 か所でも欠ければ不合格・0 か所も不合格)。
//   - 変数は、どこかで書き換えられていれば (代入・複合代入・分割代入・++ / --・for-in / for-of の左辺。入れ子の関数の
//     中も含む) 値を求めない。
//   - `var` は、同じ関数に宣言が 1 つだけで、関数の本文の直下の文にあり、使う場所より前にあるときだけ値をたどる
//     (if / ループ / try / switch / ラベルの中や、重複した宣言は追わない)。
//   - 関数の引数・catch の変数・for の変数・関数宣言・class は値を求めない。
//
// 受け入れている限界 (minifier の出力には現れない前提。現れても検査は通るので、検査の結論はそこまで):
//   - `with` と直接の `eval` によるスコープや束縛の変化。
//   - getter / setter・Proxy・`Object.defineProperty`・globalThis 経由の書き込み (識別子への代入として現れないもの)。
//   - sloppy mode の `arguments` を通した引数の書き換え (引数はそもそも値をたどらない)。
//   - 連結を含む文が実際に実行されるか (到達しないコード・条件分岐の中) は見ない。

import ts from 'typescript';

const OPAQUE = Symbol('opaque');

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) || ts.isClassStaticBlockDeclaration(node)
  );
}

function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else {
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
    }
  }
  return out;
}

function isBlockScopedList(list) {
  return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
}

// 宣言 1 つ → 値をたどれる宣言 (名前が識別子の変数宣言) か OPAQUE。
function declarationResult(declaration) {
  return ts.isIdentifier(declaration.name) ? declaration : OPAQUE;
}

// ブロック (SourceFile / Block / ModuleBlock / CaseBlock) の直下の let / const / 関数宣言 / class。
function blockScoped(scope, name) {
  const statements = ts.isCaseBlock(scope)
    ? scope.clauses.flatMap((clause) => clause.statements)
    : scope.statements;
  for (const statement of statements) {
    if (ts.isVariableStatement(statement) && isBlockScopedList(statement.declarationList)) {
      for (const declaration of statement.declarationList.declarations) {
        if (bindingNames(declaration.name).includes(name)) return declarationResult(declaration);
      }
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
      return OPAQUE;
    }
  }
  return null;
}

// 関数 (または module 全体) の中の var 宣言。入れ子の関数には入らない。値をたどるのは、宣言が 1 つだけで、
// 関数の本文 (module 全体) の直下の文にあり、使う場所より前にあるときだけ。if / ループ / try / switch / ラベルの
// 中の宣言や、同じ名前の宣言が 2 つ以上あるときは、どの初期化式が実行されたかを追わずに OPAQUE (不合格側)。
function hoistedVar(root, name, usePos) {
  const candidates = [];
  const visit = (node) => {
    if (node !== root && isFunctionLike(node)) return;
    if (ts.isVariableDeclarationList(node) && !isBlockScopedList(node)) {
      for (const declaration of node.declarations) {
        if (bindingNames(declaration.name).includes(name)) candidates.push(declaration);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return OPAQUE;
  const [declaration] = candidates;
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || statement.parent !== root || declaration.end > usePos) return OPAQUE;
  return declarationResult(declaration);
}

// 識別子が書き込みの対象か (代入・複合代入・分割代入の中・++ / --・for-in / for-of の左辺)。
function isWriteTarget(identifier) {
  let node = identifier;
  for (;;) {
    const parent = node.parent;
    if (!parent) return false;
    if (
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      return parent.left === node;
    }
    if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node) return true;
    // 分割代入の入れ物 (`[P]=…`・`({P}=…)`・`({a:P}=…)`・`[...P]=…`) をさかのぼる。
    if (
      ts.isParenthesizedExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent) || ts.isShorthandPropertyAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      node = parent;
      continue;
    }
    return false;
  }
}

// 宣言の束縛が、どこかで (入れ子の関数の中も含めて) 書き換えられているか。値は初期化式だけで決めるので、
// 書き換えがあれば値を求めない (不合格側)。同じ名前でも別の宣言に解決される書き込みは数えない。
const reassignedCache = new WeakMap();
function isReassigned(declaration) {
  if (reassignedCache.has(declaration)) return reassignedCache.get(declaration);
  const name = declaration.name.text;
  let written = false;
  const visit = (node) => {
    if (written) return;
    if (
      ts.isIdentifier(node) && node.text === name && node !== declaration.name &&
      isWriteTarget(node) && resolveBinding(node) === declaration
    ) {
      written = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  reassignedCache.set(declaration, written);
  return written;
}

// 識別子 → 見えている宣言 (変数宣言) / OPAQUE (値を求めない束縛) / null (どこにも宣言が無い = global)。
export function resolveBinding(identifier) {
  const name = identifier.text;
  const usePos = identifier.getStart();
  for (let node = identifier.parent; node; node = node.parent) {
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
      const found = blockScoped(node, name);
      if (found) return found;
    }
    if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer && ts.isVariableDeclarationList(node.initializer) &&
      isBlockScopedList(node.initializer) &&
      node.initializer.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
    ) {
      return OPAQUE;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration &&
      bindingNames(node.variableDeclaration.name).includes(name)) {
      return OPAQUE;
    }
    if (isFunctionLike(node)) {
      if (node.parameters?.some((parameter) => bindingNames(parameter.name).includes(name))) return OPAQUE;
      if (ts.isFunctionExpression(node) && node.name?.text === name) return OPAQUE;
      const found = node.body ? hoistedVar(node.body, name, usePos) : null;
      if (found) return found;
    }
    if (ts.isClassExpression(node) && node.name?.text === name) return OPAQUE;
    if (ts.isSourceFile(node)) return hoistedVar(node, name, usePos);
  }
  return null;
}

// 式の文字列としての値。求められなければ undefined。
export function staticValue(node, depth = 0) {
  if (depth > 50) return undefined;
  if (ts.isParenthesizedExpression(node)) return staticValue(node.expression, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const value = staticValue(span.expression, depth + 1);
      if (value === undefined) return undefined;
      text += value + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticValue(node.left, depth + 1);
    const right = left === undefined ? undefined : staticValue(node.right, depth + 1);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String' &&
    node.arguments.length === 1 && resolveBinding(node.expression) === null
  ) {
    const value = staticValue(node.arguments[0], depth + 1);
    return value === undefined ? undefined : String(value);
  }
  if (ts.isIdentifier(node)) {
    const binding = resolveBinding(node);
    if (!binding || binding === OPAQUE || !binding.initializer || isReassigned(binding)) return undefined;
    return staticValue(binding.initializer, depth + 1);
  }
  return undefined;
}

// `+` の連結 (左結合・括弧も可) で node の次に足される式。無ければ null。
function nextOperand(node) {
  let current = node;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  if (!parent || !ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
  if (parent.left === current) return parent.right;
  // current は右側: 1 つ上の連結の左側なら、その右側が次。
  let up = parent;
  while (up.parent && ts.isParenthesizedExpression(up.parent)) up = up.parent;
  const grand = up.parent;
  if (grand && ts.isBinaryExpression(grand) && grand.operatorToken.kind === ts.SyntaxKind.PlusToken && grand.left === up) {
    return grand.right;
  }
  return null;
}

// source の中の、文字列に含まれる `after` の **すべて** について、その直後に `expected` が (畳み込まれて / 変数で)
// 連結されているかを数える。total = `after` の出現数・failing = 断片が続かない出現数。1 か所が正しくても、別の
// 場所の連結が壊れていれば failing に数える (正しい箇所が壊れた箇所を隠さない)。
export function checkComposition(source, after, expected, fileName = 'bundle.js') {
  if (!source.includes(after)) return { total: 0, failing: 0 };
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const target = after + expected;
  let total = 0;
  let failing = 0;
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (let index = node.text.indexOf(after); index >= 0; index = node.text.indexOf(after, index + 1)) {
        total += 1;
        let segment = node.text.slice(index);
        for (let operand = nextOperand(node); operand && segment.length < target.length; operand = nextOperand(operand)) {
          const value = staticValue(operand);
          if (value === undefined) break;
          segment += value;
        }
        if (!segment.startsWith(target)) failing += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { total, failing };
}

// 1 か所以上あり、すべてに断片が続く。
export function hasComposition(source, after, expected, fileName = 'bundle.js') {
  const { total, failing } = checkComposition(source, after, expected, fileName);
  return total > 0 && failing === 0;
}
