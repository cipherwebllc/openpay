// vercel.json の cron 定義 / GitHub Actions の cron トリガー URL が、実在する App Router の
// GET ルートを指していることを固定する。
//
// cron は「叩かれない」ことが無音で成立する (Vercel も Actions も 404 を数日気付かせない) ため、
// route を rename / 削除したときに CI で落ちる唯一のフェンスとしてここに置く。

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type VercelConfig = { crons?: Array<{ path: string; schedule: string }> };

const root = process.cwd();

function routeFileFor(apiPath: string): string {
  // "/api/cron/reverify" → "app/api/cron/reverify/route.ts"
  return resolve(root, `app${apiPath}/route.ts`);
}

function exportsGet(file: string): boolean {
  const source = readFileSync(file, 'utf8');
  return /export\s+(?:async\s+function|const)\s+GET\b/.test(source) ||
    /export\s*\{[^}]*\bGET\b[^}]*\}/.test(source);
}

const vercelConfig = JSON.parse(
  readFileSync(resolve(root, 'vercel.json'), 'utf8'),
) as VercelConfig;

describe('vercel.json crons', () => {
  it('cron が 1 件以上定義されている (定義ごと消えた回帰を検出)', () => {
    expect(vercelConfig.crons?.length ?? 0).toBeGreaterThan(0);
  });

  it.each((vercelConfig.crons ?? []).map((c) => c.path))(
    '%s は GET を export する route.ts に対応する',
    (path) => {
      const file = routeFileFor(path);
      expect(existsSync(file), `${file} が存在しない`).toBe(true);
      expect(exportsGet(file), `${file} が GET を export していない`).toBe(true);
    },
  );

  it('cron の schedule は 5 フィールドの cron 式', () => {
    for (const cron of vercelConfig.crons ?? []) {
      expect(cron.schedule.trim().split(/\s+/)).toHaveLength(5);
    }
  });
});

describe('GitHub Actions reverify-cron', () => {
  const workflow = readFileSync(
    resolve(root, '.github/workflows/reverify-cron.yml'),
    'utf8',
  );

  it('叩く URL のパスも実在する GET route を指す', () => {
    const match = workflow.match(/https:\/\/[^\s/]+(\/api\/[A-Za-z0-9/_-]+)/);
    expect(match, 'workflow から API URL を抽出できない').not.toBeNull();
    const apiPath = (match as RegExpMatchArray)[1];
    const file = routeFileFor(apiPath);
    expect(existsSync(file), `${file} が存在しない`).toBe(true);
    expect(exportsGet(file), `${file} が GET を export していない`).toBe(true);
  });
});
