// GitHub Actions workflow (.github/workflows/*.yml) を `yaml` (eemeli/yaml・devDependency) で読む共通部。
// 使うのは CI の検査 2 つ: ci-wait の期待集合と workflow のドリフト検査 (scripts/lib/ciWaitWorkflows.mjs) と、
// 依存の install の手順の検査 (scripts/lib/workflowRun.mjs)。どちらも「読んだ値から規則を判定する」ので、
// GitHub の解釈とこの読み取りがずれうる形は値にせず problems として返す (fail-closed・呼び出し側が unsupported / throw にする)。
//
// 以前は依存を足さずに行指向の読み取りを手書きしていて (インデントの推測・引用符・継続行の扱い)、読み残し・読み違えの
// 指摘が繰り返し出た。YAML として読むのは `yaml` に任せ、ここでは検査に使ってよい文書かどうかだけを確かめる:
//   - 制御文字 (先頭の BOM と CRLF の CR を除く): 単独の CR・U+0085 / U+2028 / U+2029 は YAML 1.1 系の parser では改行で、
//     `yaml` (YAML 1.2) では文字なので、GitHub と行の分かれ方がずれうる。NUL 等の C0 / C1・途中の BOM も読まない。
//   - `yaml` のエラー・警告 (タブのインデント・揃わないインデント・閉じない引用符・複数ドキュメント・重複キー
//     (uniqueKeys) 等): 1 つでもあれば読まない (部分的に読めた値を使わない)。
//   - ディレクティブ (`%YAML` / `%TAG`): `%YAML 1.1` で `on:` が真偽値の key になる等、読み方が変わるので読まない。
//     解決後の tags は既定の prefix を再宣言した `%TAG !! tag:yaml.org,2002:` と区別できないので、CST の directive の
//     存在そのものを見る (値は比べない)。
//   - アンカー / エイリアス / タグ: 今の workflow に無い形 (GitHub と `yaml` で展開・解決の仕方がずれうる) なので読まない。
//   - key: 文字列の scalar だけ (引用符の有無は問わない)。`<<` (YAML 1.1 のマージ key) と、数値・真偽値・null・
//     collection の key は読まない。`${{` を含む key も読まない: GitHub は key の中の式も展開する (actions/runner の
//     TemplateReader) ので、`"${{ 'npm_config_registry' }}":` や `"${{ 'run' }}":` が実行時には別の key になる。
//     式は評価しない。
//   - トップレベルは mapping。

import { Parser, isAlias, isMap, isPair, isScalar, parseDocument, visit } from 'yaml';

/** 検査に使わない制御文字か (C0 の \t \n 以外・DEL・C1 (U+0085 を含む)・U+2028 / U+2029・途中の BOM)。CR は呼び出し側が見る。 */
function isControlChar(code) {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

/** 先頭の BOM を除いた本文の制御文字を探す (CR は直後が LF = CRLF のときだけ許す)。 */
function controlCharacterProblem(source) {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      line++;
      continue;
    }
    if ((code === 0x0d && text[i + 1] !== '\n') || isControlChar(code)) {
      return `document: control character (U+${code.toString(16).toUpperCase().padStart(4, '0')} at line ${line})`;
    }
  }
  return null;
}

/** key として読めない理由 (読めれば null)。 */
function keyProblem(key) {
  if (!isScalar(key) || typeof key.value !== 'string') return `non-string key (${key === null ? 'empty' : String(key)})`;
  if (key.value === '<<') return 'merge key (<<)';
  if (key.value.includes('${{')) return `expression in key (${key.value})`;
  return null;
}

/**
 * workflow の YAML を読み、検査に使ってよければ値 (トップレベルの mapping を JS の object にしたもの) を返す。
 * 使えなければ理由 (`document: …`) の一覧を返す (部分的に読めた値は返さない)。
 * @param {string} source
 * @returns {{ data: Record<string, unknown> } | { problems: string[] }}
 */
export function readWorkflowYaml(source) {
  const control = controlCharacterProblem(source);
  if (control) return { problems: [control] };
  const doc = parseDocument(source, { version: '1.2', uniqueKeys: true, strict: true, merge: false });
  const parseProblems = [...doc.errors, ...doc.warnings].map((e) => `document: ${e.code} (line ${e.linePos?.[0]?.line ?? '?'})`);
  if (parseProblems.length > 0) return { problems: parseProblems };
  const problems = [];
  for (const token of new Parser().parse(source)) {
    if (token.type === 'directive') problems.push(`document: directive (${token.source})`);
  }
  // visit は値の無い pair の値 (`key:`・`? key`) にも null で来る。null の key は pair の側で見る
  visit(doc, (_key, node) => {
    if (node === null) return;
    if (isAlias(node)) {
      problems.push(`document: alias (*${node.source})`);
    } else if (isPair(node)) {
      const problem = keyProblem(node.key);
      if (problem) problems.push(`document: ${problem}`);
    } else {
      if (node.anchor) problems.push(`document: anchor (&${node.anchor})`);
      if (node.tag) problems.push(`document: tag (${node.tag})`);
    }
  });
  if (problems.length > 0) return { problems };
  if (!isMap(doc.contents)) return { problems: ['document: the top level is not a mapping'] };
  return { data: doc.toJS() };
}

/** 値が mapping (YAML の map を JS にした plain object) か。 */
export function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
