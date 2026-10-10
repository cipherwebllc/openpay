import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 第 7 回レビュー E4 (user 裁定 R4): lockfile 全体の再解決 PR を自動 merge すると、推移的依存の
// 差し替え (install script 付きの新規パッケージを含む) が人の目を通らずに main に入る。
// merge は CLAUDE.md どおり user の明示で行う。
describe('renovate.json supply-chain guards', () => {
  const config = JSON.parse(readFileSync(resolve(process.cwd(), 'renovate.json'), 'utf8')) as {
    lockFileMaintenance?: { enabled?: boolean; automerge?: boolean };
    vulnerabilityAlerts?: { automerge?: boolean };
    minimumReleaseAge?: string;
    automerge?: boolean;
    packageRules?: Array<{ description?: string; automerge?: boolean }>;
  };

  it('lockFileMaintenance は PR を作るだけで自動 merge しない', () => {
    expect(config.lockFileMaintenance?.enabled).toBe(true);
    expect(config.lockFileMaintenance?.automerge).toBe(false);
  });

  it('vulnerabilityAlerts も自動 merge しない (受容判断は audit-gate の allowlist と docs §7)', () => {
    expect(config.vulnerabilityAlerts?.automerge).toBe(false);
  });

  it('公開直後の version は取り込まない (minimumReleaseAge)', () => {
    expect(config.minimumReleaseAge).toMatch(/^[1-9]\d* days?$/);
  });

  it('どの更新も自動 merge しない (merge は CLAUDE.md どおり user の明示)', () => {
    expect(config.automerge).not.toBe(true);
    const autoMerged = (config.packageRules ?? []).filter((rule) => rule.automerge === true).map((rule) => rule.description);
    expect(autoMerged).toEqual([]);
  });
});
