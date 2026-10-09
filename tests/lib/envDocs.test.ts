// 掟 9 (env を足したら .env.local.example と README の env テーブルを同時更新) の自動フェンス。
//
// これまで掟 9 は人手の規律だけで守られており、実際に README の env テーブルは
// コードが読む変数の大半を落としていた (2026-09-02 レビュー F11)。ここでは
// アプリのコードが実際に読む `process.env.X` を単一の真実として抽出し、
//   (1) .env.local.example に列があること
//   (2) README の env テーブルに行 (またはワイルドカード行) があること
// を強制する。どちらかを忘れた PR は CI で落ちる。
//
// 走査対象は app/ 全体・components/・hooks/・lib/ と、ルート直下で env を読む
// instrumentation*.ts / middleware.ts / next.config.mjs (第 7 回レビュー E9: 以前は lib/ と app/api/
// だけで、instrumentation-client.ts の Sentry サンプリング 3 件が README から漏れていた)。
// 配布パッケージ (packages/) は .env.local.example ではなく各パッケージの README が正本なので、
// 末尾の describe で別に検査する。
//
// テーブル行は `NEXT_PUBLIC_*_RPC_URL` のようなワイルドカード表記を許す (既存の書式)。
// ワイルドカードは第 1 列 (変数名セル) に書かれたものだけを見る — 説明文中の `NEXT_PUBLIC_*`
// のような散文を拾うと、フェンスが何も検出しなくなるため。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

// プラットフォームが与える変数 (OpenPay の設定ではない) は文書化対象外。
// CI = GitHub Actions / Vercel が build 時に立てる・NEXT_RUNTIME = Next.js が instrumentation に渡す。
const PLATFORM_PROVIDED = new Set(['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'CI', 'NEXT_RUNTIME']);

// ルート直下で env を読みうるファイル (存在するものだけ走査する。無いものはこの repo に無いだけ)。
const ROOT_ENV_READERS = [
  'instrumentation.ts',
  'instrumentation-client.ts',
  'middleware.ts',
  'proxy.ts',
  'next.config.mjs',
  'next.config.ts',
];

function sourceFiles(dir: string, ext = /\.tsx?$/): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(rel, ext));
    } else if (ext.test(entry.name)) {
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

function envKeysIn(
  files: readonly string[],
  pattern = /process\.env\.([A-Z][A-Z0-9_]*)/g,
  platform = PLATFORM_PROVIDED,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    const source = stripComments(readFileSync(resolve(root, file), 'utf8'));
    for (const m of source.matchAll(pattern)) {
      const key = m[1];
      if (platform.has(key)) continue;
      const list = found.get(key);
      if (list) list.push(file);
      else found.set(key, [file]);
    }
  }
  return found;
}

const appSourceFiles = [
  ...sourceFiles('app'),
  ...sourceFiles('components'),
  ...sourceFiles('hooks'),
  ...sourceFiles('lib'),
  ...ROOT_ENV_READERS.filter((f) => existsSync(resolve(root, f))),
];
const referenced = envKeysIn(appSourceFiles);
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
    // ルート直下 (instrumentation-client.ts) も走査できていること (E9 の回帰検出)
    expect(referenced.get('NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE')).toContain('instrumentation-client.ts');
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

// 配布パッケージが読む env は、利用者が見るのは各パッケージの README なので、そちらを正本にする
// (第 7 回レビュー E9: packages/ は以前どのフェンスにも入っていなかった)。
describe('packages/ の env ドキュメント (各パッケージの README が正本)', () => {
  // 実行環境が与える変数 (ホームディレクトリ等) は対象外。
  const PACKAGE_PLATFORM = new Set(['HOME', 'PATH', 'USERPROFILE', 'NODE_ENV']);

  it('openpay-x402-mcp が読む env は README の Environment テーブル (第 1 列) にある', () => {
    // MCP は `process.env` を注入可能な `env` として引き回すので `env.X` の形も読む。
    const keys = [
      ...envKeysIn(
        sourceFiles('packages/x402-mcp/src', /\.mjs$/),
        /\benv\.([A-Z][A-Z0-9_]*)/g,
        PACKAGE_PLATFORM,
      ).keys(),
    ].sort();
    expect(keys.length).toBeGreaterThan(5);
    expect(keys).toContain('SIGNER_MODE');

    const readme = readFileSync(resolve(root, 'packages/x402-mcp/README.md'), 'utf8').split('\n');
    const start = readme.findIndex((l) => l.trim() === '## Environment');
    expect(start).toBeGreaterThan(-1);
    const length = readme.slice(start + 1).findIndex((l) => l.startsWith('## '));
    const documented = new Set(
      readme
        .slice(start, length === -1 ? readme.length : start + 1 + length)
        .filter((l) => l.startsWith('|'))
        .flatMap((l) => [...(l.split('|')[1] ?? '').matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1])),
    );
    expect(documented.size).toBeGreaterThan(10);
    const missing = keys.filter((k) => !documented.has(k));
    expect(missing, `packages/x402-mcp/README.md の Environment テーブルに未記載の env: ${missing.join(', ')}`).toEqual([]);
  });

  it('openpay-x402-sdk (src + examples) が読む env は README で説明されている', () => {
    const keys = [
      ...envKeysIn(
        [...sourceFiles('packages/x402-sdk/src', /\.(m?js|ts)$/), ...sourceFiles('packages/x402-sdk/examples', /\.(m?js|ts)$/)],
        /process\.env\.([A-Z][A-Z0-9_]*)/g,
        PACKAGE_PLATFORM,
      ).keys(),
    ].sort();
    expect(keys.length).toBeGreaterThan(0);
    const readme = readFileSync(resolve(root, 'packages/x402-sdk/README.md'), 'utf8');
    const missing = keys.filter((k) => !readme.includes(`\`${k}\``));
    expect(missing, `packages/x402-sdk/README.md に未記載の env: ${missing.join(', ')}`).toEqual([]);
  });
});
