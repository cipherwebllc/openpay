'use client';

// このタブがトップの見本から入れたテーマと色 (plans/lp-polish-2026-11.md P6) を、タブごとの sessionStorage に持つ。
// 下書き (localStorage・別のタブと同期する) には入れない: 入れると、別のタブで見本から入れた印が、このタブの手入力と混ざって
// 「手付かず」に見え、持っている @handle の自動編集 (公開中の内容の読み込み) で手入力を置き換える順ができる。
// このタブの中では、再 mount (作成画面のタブの切り替え) と再読み込みでも印が残る。別のタブとは同期しない
// (別のタブでは、見本の値の入った下書きは手を入れたものと数える = 自動編集に入らない側に倒れる)。ただしブラウザの
// 「タブを複製」では sessionStorage ごとコピーされ得る (複製した時点の印を持って始まり、その後は同期しない)。

import { useCallback, useState } from 'react';
import type { HandleTheme } from '@/lib/handleThemeKey';

const STORAGE_KEY = 'openpay:landing-look-seed:v1';

export type LandingLookSeed = { theme: HandleTheme; color: string };

function readSeed(): LandingLookSeed | null {
  // sessionStorage が使えない環境 (保存を止めた設定・一部の埋め込み) では読むだけで例外になる。それでプロフのタブの描画を
  // 止めないための防御: 読めなければ、この mount は印なしで始まる (= 見本の値の入った下書きは、手を入れたものと数えるだけ)。
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    // 印は今のテーマと色 (下書きの sanitize を通った値) と比べるだけなので、壊れた値 (形の違う JSON・一覧に無いテーマ等) は
    // どれとも一致せず、すぐ消える (手付かずと数える向きには働かない)。JSON として読めないときは下の catch で印なし。
    return raw ? (JSON.parse(raw) as LandingLookSeed | null) : null;
  } catch {
    return null;
  }
}

function writeSeed(seed: LandingLookSeed | null): void {
  // 書き込みの失敗をプロフのタブの操作に波及させないための防御。失敗したときの動き:
  // - 書く (setItem) だけ失敗: 今の mount の間は state の印で判定し、再 mount・再読み込みの後は印なし (手を入れたものと数える)。
  // - 消す (removeItem) だけ失敗: 今の mount の間は印なし。再 mount の後は前に保存した古い印を読むが、今の値と違えばすぐ消す
  //   (手付かずと数えるのは、今の値が偶然その古い印と同じで、ほかが既定のときだけ)。
  try {
    if (seed) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 上のとおり。
  }
}

/** このタブの印と、印を書き換える関数 (null で消す)。プロフのタブは作成画面が ssr:false で読むので、最初の描画から読める。 */
export function useLandingLookSeed(): [LandingLookSeed | null, (seed: LandingLookSeed | null) => void] {
  const [seed, setSeed] = useState(readSeed);
  const update = useCallback((next: LandingLookSeed | null) => {
    writeSeed(next);
    setSeed(next);
  }, []);
  return [seed, update];
}
