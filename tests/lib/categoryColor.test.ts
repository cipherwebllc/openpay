import { describe, expect, it } from 'vitest';
import { categoryColorClasses } from '@/lib/categoryColor';

const PALETTE = [
  { border: 'border-l-emerald-400', dot: 'bg-emerald-400' },
  { border: 'border-l-sky-400', dot: 'bg-sky-400' },
  { border: 'border-l-violet-400', dot: 'bg-violet-400' },
  { border: 'border-l-amber-400', dot: 'bg-amber-400' },
  { border: 'border-l-rose-400', dot: 'bg-rose-400' },
  { border: 'border-l-cyan-400', dot: 'bg-cyan-400' },
  { border: 'border-l-fuchsia-400', dot: 'bg-fuchsia-400' },
  { border: 'border-l-lime-400', dot: 'bg-lime-400' },
];

describe('categoryColorClasses', () => {
  it('同じカテゴリー名には常に同じクラスを返す', () => {
    expect(categoryColorClasses('ドリンク')).toEqual(categoryColorClasses('ドリンク'));
  });

  it('任意のカテゴリー名を固定パレット内のクラスへ割り当てる', () => {
    for (const category of ['ドリンク', 'フード', '物販', 'Coffee', '長いカテゴリー名']) {
      expect(PALETTE).toContainEqual(categoryColorClasses(category));
    }
  });

  it('空文字はパレット先頭の色として扱う', () => {
    expect(categoryColorClasses('')).toEqual(PALETTE[0]);
  });
});
