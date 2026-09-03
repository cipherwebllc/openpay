// 掟 9 (env を足したら .env.local.example と README の env テーブルを同時更新) の自動フェンス。
//
// これまで掟 9 は人手の規律だけで守られており、実際に README の env テーブルは
// コードが読む変数の大半を落としていた (2026-09-02 レビュー F11)。ここでは
// lib/ と app/api/ が実際に読む `process.env.X` を単一の真実として抽出し、
//   (1) .env.local.example に列があること
//   (2) README の env テーブルに行 (またはワイルドカード行) があること
// を強制する。どちらかを忘れた PR は CI で落ちる。
//
// テーブル行は `NEXT_PUBLIC_*_RPC_URL` のようなワイルドカード表記を許す (既存の書式)。
// ワイルドカードは第 1 列 (変数名セル) に書かれたものだけを見る — 説明文中の `NEXT_PUBLIC_*`
// のような散文を拾うと、フェンスが何も検出しなくなるため。

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

// プラットフォームが与える変数 (OpenPay の設定ではない) は文書化対象外。
const PLATFORM_PROVIDED = new Set(['NODE_ENV', 'VERCEL']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(rel));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

// コメント中の例示 (`process.env.NEXT_PUBLIC_FOO` / `process.env.X402_*`) を拾わないよう、
// 走査前に行コメント・ブロックコメントを落とす。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function envKeysIn(files: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    const source = stripComments(readFileSync(resolve(root, file), 'utf8'));
    for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      const key = m[1];
      if (PLATFORM_PROVIDED.has(key)) continue;
      const list = found.get(key);
      if (list) list.push(file);
      else found.set(key, [file]);
    }
  }
  return found;
}

const referenced = envKeysIn([...sourceFiles('lib'), ...sourceFiles('app/api')]);
const allKeys = [...referenced.keys()].sort();

const exampleSource = readFileSync(resolve(root, '.env.local.example'), 'utf8');
const exampleKeys = new Set(
  [...exampleSource.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
);

const readmeLines = readFileSync(resolve(root, 'README.md'), 'utf8').split('\n');
const tableStart = readmeLines.findIndex((l) => l.trim() === '## Environment variables');
const tableEndOffset = readmeLines
  .slice(tableStart + 1)
  .findIndex((l) => l.startsWith('## '));
const tableLines = readmeLines.slice(
  tableStart,
  tableEndOffset === -1 ? readmeLines.length : tableStart + 1 + tableEndOffset,
);
// 変数名セル (第 1 列) の `` `KEY` `` だけをパターンとして採る。
const readmePatterns = [
  ...new Set(
    tableLines
      .filter((l) => l.startsWith('|'))
      .flatMap((l) =>
        [...(l.split('|')[1] ?? '').matchAll(/`([A-Z][A-Z0-9_*]*)`/g)].map(
          (m) => m[1],
        ),
      ),
  ),
];

function matchesPattern(key: string, pattern: string): boolean {
  if (!pattern.includes('*')) return pattern === key;
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(key);
}

function documentedInReadme(key: string): boolean {
  return readmePatterns.some((p) => matchesPattern(key, p));
}

describe('env ドキュメントのドリフト検出 (掟 9)', () => {
  it('抽出そのものが壊れていない (env キーを十分な数見つけている)', () => {
    expect(tableStart).toBeGreaterThan(-1);
    expect(allKeys.length).toBeGreaterThan(100);
    expect(readmePatterns.length).toBeGreaterThan(20);
    // lib/env.ts の代表キーが抽出できていること (正規表現の回帰検出)
    expect(allKeys).toContain('NEXT_PUBLIC_NETWORK_ENV');
    expect(allKeys).toContain('RELAYER_PRIVATE_KEY');
  });

  it('コードが読む env は全て .env.local.example にある', () => {
    const missing = allKeys.filter((k) => !exampleKeys.has(k));
    expect(
      missing,
      `.env.local.example に未記載の env: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('コードが読む env は全て README の env テーブルにある', () => {
    const missing = allKeys.filter((k) => !documentedInReadme(k));
    expect(
      missing,
      `README の env テーブルに未記載の env: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('README のワイルドカード行は少なくとも 1 つの実キーに対応する (死んだ行を残さない)', () => {
    const dead = readmePatterns.filter(
      (p) => p.includes('*') && !allKeys.some((k) => matchesPattern(k, p)),
    );
    expect(dead, `対応する env が無いワイルドカード行: ${dead.join(', ')}`).toEqual(
      [],
    );
  });
});
