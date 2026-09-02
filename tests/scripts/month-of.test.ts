// scripts/lib/month-of.mjs — scripts/metrics-report.mjs の集計月キー生成。
// 旧実装 (d.setUTCMonth(d.getUTCMonth() + offset)) は「日」を保ったまま月をずらすため、
// 月末に実行すると先月が翌月へ繰り上がり、別の月の metrics キーを読んでいた。
import { describe, expect, it } from 'vitest';

type MonthOf = (offset?: number, now?: Date) => string;

async function loadMonthOf(): Promise<MonthOf> {
  const mod = (await import('@/scripts/lib/month-of.mjs')) as { monthOf: MonthOf };
  return mod.monthOf;
}

describe('scripts/lib/month-of.mjs', () => {
  it('offset 0 は当月・-1 は先月を返す (月中)', async () => {
    const monthOf = await loadMonthOf();
    const now = new Date(Date.UTC(2026, 7, 15)); // 2026-08-15
    expect(monthOf(0, now)).toBe('2026-08');
    expect(monthOf(-1, now)).toBe('2026-07');
  });

  it('31 日に実行しても先月が繰り上がらない (2026-03-31 → 2026-02)', async () => {
    const monthOf = await loadMonthOf();
    const now = new Date(Date.UTC(2026, 2, 31)); // 2026-03-31
    expect(monthOf(0, now)).toBe('2026-03');
    expect(monthOf(-1, now)).toBe('2026-02'); // 旧実装は 2026-03 を返していた
  });

  it('年をまたぐ offset も正しい (2026-01-31 → 2025-12)', async () => {
    const monthOf = await loadMonthOf();
    const now = new Date(Date.UTC(2026, 0, 31));
    expect(monthOf(-1, now)).toBe('2025-12');
    expect(monthOf(1, now)).toBe('2026-02');
  });
});
