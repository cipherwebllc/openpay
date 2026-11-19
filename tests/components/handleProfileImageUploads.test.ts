// プロフのリンクの行の id (components/handle-profile-builder/imageUploads の deriveLinkRowIds)。下書きの行には id が無い
// (保存と下書きの形を変えない) ので、描画のたびに前の行と比べて決める。並べ替え・削除・追加・行の書き換え (ラベル・URL・
// 画像・注目) で、同じ行は同じ id のまま・消えた行の id は残らない・新しい行は新しい id。
import { describe, expect, it } from 'vitest';
import { deriveLinkRowIds } from '@/components/handle-profile-builder/imageUploads';

type Row = { label: string; url: string; imageUrl?: string; featured?: boolean; kind?: 'heading' };

function ids() {
  let n = 0;
  return () => `new${++n}`;
}

const A: Row = { label: 'A', url: 'https://a.example' };
const B: Row = { label: 'B', url: 'https://b.example' };
const C: Row = { label: 'C', url: 'https://c.example' };
const PREV_IDS = ['a', 'b', 'c'];

describe('deriveLinkRowIds', () => {
  it('並べ替え (同じ object を動かす) は id も一緒に動く', () => {
    expect(deriveLinkRowIds([A, B, C], PREV_IDS, [B, A, C], ids())).toEqual(['b', 'a', 'c']);
    expect(deriveLinkRowIds([A, B, C], PREV_IDS, [C, A, B], ids())).toEqual(['c', 'a', 'b']);
  });

  it('削除 (filter) は残った行の id を保ち、消した行の id は残さない', () => {
    expect(deriveLinkRowIds([A, B, C], PREV_IDS, [B, C], ids())).toEqual(['b', 'c']);
    expect(deriveLinkRowIds([A, B, C], PREV_IDS, [A, C], ids())).toEqual(['a', 'c']);
    expect(deriveLinkRowIds([A, B, C], PREV_IDS, [A, B], ids())).toEqual(['a', 'b']);
  });

  it('追加は新しい id', () => {
    const D: Row = { label: '', url: '' };
    expect(deriveLinkRowIds([A, B], ['a', 'b'], [A, B, D], ids())).toEqual(['a', 'b', 'new1']);
  });

  it('行の書き換え (その位置に作り直した object) は同じ行として id を引き継ぐ', () => {
    const B2 = { ...B, label: 'B2' };
    expect(deriveLinkRowIds([A, B, C], PREV_IDS, [A, B2, C], ids())).toEqual(['a', 'b', 'c']);
    const C2 = { ...C, imageUrl: 'https://img.example/c.png' };
    expect(deriveLinkRowIds([A, B, C], PREV_IDS, [A, B, C2], ids())).toEqual(['a', 'b', 'c']);
  });

  it('注目の切り替え (見出し以外の行をすべて作り直す) でも、どの行も id を引き継ぐ', () => {
    const heading: Row = { kind: 'heading', label: 'H', url: '' };
    const next = [{ ...A, featured: false }, heading, { ...C, featured: true }];
    expect(deriveLinkRowIds([A, heading, C], ['a', 'h', 'c'], next, ids())).toEqual(['a', 'h', 'c']);
  });

  it('別の位置へ動いた行は、その位置の行の id を引き継がない (動いた行が自分の id を持っていく)', () => {
    // A を末尾へ動かし、同時に先頭に新しい行 (実際の画面では起きない組み合わせ)。A の id は A に付き、新しい行は新しい id。
    const D: Row = { label: 'D', url: '' };
    expect(deriveLinkRowIds([A, B], ['a', 'b'], [D, B, A], ids())).toEqual(['new1', 'b', 'a']);
  });

  it('同じ object が 2 回並んでも、id は 1 つの行にだけ付く', () => {
    expect(deriveLinkRowIds([A, B], ['a', 'b'], [A, A], ids())).toEqual(['a', 'b']);
  });

  it('前の行が無い (最初の描画の後に初めて入る) と全部新しい id', () => {
    expect(deriveLinkRowIds([], [], [A, B], ids())).toEqual(['new1', 'new2']);
  });
});
