// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// npm に出す 2 つの package は CHANGELOG.md を tarball に同梱する (package.json の files)。
// version だけ上げて CHANGELOG の節を書き忘れると、利用者が入れた版の説明が同梱物のどこにも無い。
// ここで見るのは「package.json の version と同じ版の見出しがある」ことだけ。見出しの日付
// (「unreleased」のままかどうか) は見ない: 版を上げる PR は publish の前に通すので、日付まで
// 求めるとその PR が必ず落ちる。日付は docs/RELEASE_x402_packages.md の手順で確定する。
describe('published packages document their own version in the bundled CHANGELOG', () => {
  it.each(['x402-sdk', 'x402-mcp'])('packages/%s: CHANGELOG.md has a heading for package.json version', (dir) => {
    const root = resolve(process.cwd(), 'packages', dir);
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string; files: string[] };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.files).toContain('CHANGELOG.md');
    const headings = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('## '))
      // 見出しは「## 0.11.1 — 2026-11-12」か、古い節の「## 0.8.1」。版の部分だけを取り出す。
      .map((line) => line.slice(3).split(' ')[0]);
    expect(headings).toContain(pkg.version);
  });
});
