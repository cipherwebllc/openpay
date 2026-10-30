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
// 限界 (minifier の出力では起きない前提・起きたら不合格側に倒れるか、届かないので不合格):
//   - 宣言の後の再代入 (`I=""`) は見ない。値は宣言の初期化式だけで決める。
//   - 同じ関数の中で `var` が複数回宣言されているときは、使う場所より前で最も近い宣言を使う。前に無ければ
//     求められない (実行順を追わない)。
//   - 関数の引数・catch の変数・for の変数・関数宣言・class は値を求めない (不合格側)。
//   - `with` と `eval` によるスコープの変化は扱わない。

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

// 関数 (または module 全体) の中の var 宣言。入れ子の関数には入らない。使う場所より前で最も近いものを使う。
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
  const preceding = candidates.filter((declaration) => declaration.end <= usePos);
  if (preceding.length === 0) return OPAQUE;
  return declarationResult(preceding[preceding.length - 1]);
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
    if (!binding || binding === OPAQUE || !binding.initializer) return undefined;
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

// source の中に、文字列の `after` の直後に `expected` が (畳み込まれて / 変数で) 連結された箇所があるか。
export function hasComposition(source, after, expected, fileName = 'bundle.js') {
  if (!source.includes(after)) return false;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const target = after + expected;
  let found = false;
  const visit = (node) => {
    if (found) return;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes(after)) {
      let segment = node.text.slice(node.text.indexOf(after));
      for (let operand = nextOperand(node); operand && segment.length < target.length; operand = nextOperand(operand)) {
        const value = staticValue(operand);
        if (value === undefined) break;
        segment += value;
      }
      if (segment.includes(target)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
