// プラカード印刷の wiring フェンス。
//
// MobileOrderPlacardModal は印刷時、印刷専用ポスターを document.body 直下へ portal
// (.placard-print-root) し、body に openpay-printing-placard を付与する。実際の「ポスター1枚
// だけ印刷」隠蔽は app/globals.css の @media print が「body 直下の .placard-print-root 以外を
// display:none」にして行う。この component ↔ CSS の文字列契約が崩れる (片方だけリネーム/typo)
// と、印刷は silent に壊れる (全ページ印刷 or 何も出ない)。jsdom には印刷/レイアウトエンジンが
// 無く @media print の実出力は検証できない (LARP pattern 7) ため、せめて文字列契約をここで固定。
//
// 経緯: 当初は受領レシートと同じ visibility:hidden 方式だったが、fixed モーダル + 長い背景ページ
// で「同じポスターが複数ページに複製」される実機バグが出たため、portal + display:none 方式に変更。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const BODY_CLASS = 'openpay-printing-placard';
const PRINT_ROOT = 'placard-print-root';

describe('プラカード印刷 wiring フェンス (component ↔ globals.css 契約)', () => {
  const component = read('components/MobileOrderPlacardModal.tsx');
  const css = read('app/globals.css');

  it('component は印刷時 body クラスを付け、印刷ポスターを body へ portal する', () => {
    expect(component).toContain(`'${BODY_CLASS}'`); // PRINT_BODY_CLASS 定義
    expect(component).toContain(PRINT_ROOT); // portal の className
    expect(component).toContain('createPortal'); // body 直下への portal
  });

  it('globals.css は印刷時に body 直下の .placard-print-root 以外を display:none する', () => {
    const printBlocks = css.match(/@media print\s*\{[\s\S]*?\n\}/g) ?? [];
    const placardBlock = printBlocks.find(
      (b) => b.includes(BODY_CLASS) && b.includes(PRINT_ROOT),
    );
    expect(placardBlock).toBeTruthy();
    // コントラクト: body.<class> 直下の .placard-print-root 以外を display:none。
    expect(placardBlock!).toMatch(
      new RegExp(`body\\.${BODY_CLASS}\\s*>\\s*\\*:not\\(\\.${PRINT_ROOT}\\)`),
    );
    expect(placardBlock!).toContain('display: none');
  });

  it('受領レシート印刷とは別ネームスペース (セレクタ衝突しない)', () => {
    // レシートは openpay-printing-receipt / data-receipt-printing を使う。プラカードが誤って
    // レシートのネームスペースを使うと両者が干渉するため、混線していないことを固定。
    expect(component).not.toContain('openpay-printing-receipt');
    expect(component).not.toContain('data-receipt-printing');
  });
});
