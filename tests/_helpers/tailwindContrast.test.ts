import { afterEach, describe, expect, it } from 'vitest';
import { auditAllStates } from './tailwindContrast';

// helper が扱えない書き方を、黙って通さずに落とすこと (fail closed)。どれも #1034 の Codex レビュー (2 回目) が
// 「誤って通る」と示した書き方そのもの。地は完了画面と同じ emerald-700・文字は白。
function mount(inner: string): Element {
  const host = document.createElement('div');
  host.innerHTML = `<div class="bg-emerald-700 text-white">${inner}</div>`;
  document.body.appendChild(host);
  return host.firstElementChild!;
}
const failuresOf = (inner: string, options?: Parameters<typeof auditAllStates>[1]) => auditAllStates(mount(inner), options).failures;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('tailwindContrast: 扱える書き方は計算して通す', () => {
  it('白の文字・白の地のボタン (hover は emerald-50) は通る', () => {
    expect(
      failuresOf(
        '<p class="text-xs">Amount</p><button class="rounded-full bg-white px-4 text-emerald-700 hover:bg-emerald-50">Dismiss</button>',
      ),
    ).toEqual([]);
  });

  it('大きな文字 (text-3xl) は 3:1 で測る: emerald-200 / emerald-700 = 4.28:1 は通る', () => {
    expect(failuresOf('<p class="text-3xl text-emerald-200">Amount</p>')).toEqual([]);
  });
});

describe('tailwindContrast: 扱えない書き方は落とす (Codex の再現)', () => {
  it('1. important (!text-emerald-700) を黙って無視しない', () => {
    expect(failuresOf('<p class="!text-emerald-700">Amount</p>')).toContainEqual(
      expect.stringContaining('扱えない class: !text-emerald-700'),
    );
  });

  it('1. 任意の CSS ([color:#047857]) を黙って無視しない', () => {
    expect(failuresOf('<p class="[color:#047857]">Amount</p>')).toContainEqual(
      expect.stringContaining('扱えない class: [color:#047857]'),
    );
  });

  it('1. filter の class (invert) を黙って無視しない', () => {
    expect(failuresOf('<p class="invert">Amount</p>')).toContainEqual(expect.stringContaining('扱えない class: invert'));
  });

  it('1. SVG の stroke 属性 (currentColor / none 以外) を黙って無視しない', () => {
    expect(
      failuresOf('<svg class="h-5 w-5" fill="none" stroke="#047857"><path d="M0 0h1"></path></svg>'),
    ).toContainEqual(expect.stringContaining('扱えない属性: stroke="#047857"'));
  });

  it('1. SVG の <text fill> を黙って無視しない', () => {
    expect(failuresOf('<svg class="h-5 w-5"><text fill="#047857">Amount</text></svg>')).toContainEqual(
      expect.stringContaining('扱えない属性: fill="#047857"'),
    );
  });

  it('2. 同じ性質を違う値で上書きする variant が 2 つ (group-hover と hover) なら落とす', () => {
    expect(
      failuresOf('<div class="group"><button class="group-hover:text-emerald-700 hover:text-white">Pay</button></div>'),
    ).toContainEqual(expect.stringContaining('同じ性質 (color) を違う値で上書きする variant が 2 つ以上'));
  });

  it('3. button / a 以外の要素の hover: は試していないので落とす', () => {
    expect(failuresOf('<section class="hover:bg-white"><p>Amount</p></section>')).toContainEqual(
      expect.stringContaining('button / a 以外の要素の hover:'),
    );
  });

  it('4. 条件つきの opacity-0 (hover:opacity-0) を測定から逃がさない', () => {
    expect(failuresOf('<button class="hover:opacity-0">Dismiss</button>')).toContainEqual(
      expect.stringContaining('見えない文字 (opacity-0 は hover / focus で出る案内だけ): hover:opacity-0'),
    );
  });

  it('5. 画面の幅で小さくなる文字 (text-3xl sm:text-xs) は、小さい文字の 4.5:1 で測る', () => {
    expect(failuresOf('<p class="text-3xl sm:text-xs text-emerald-200">Amount</p>')).toContainEqual(
      expect.stringContaining('"Amount" 4.28:1 < 4.5:1'),
    );
  });
});

describe('tailwindContrast: opacity-0 の例外はコピーの案内だけ', () => {
  const hint = (reveal: string) =>
    `<button class="group"><span>0xabc</span><span aria-hidden="true" class="text-white opacity-0 ${reveal}">コピー</span></button>`;
  const isHint = (el: Element) => el.matches('button.group > span[aria-hidden="true"]');

  it('案内と指した要素が、hover と focus で出て測られれば通る', () => {
    expect(failuresOf(hint('group-hover:opacity-100 group-focus:opacity-100'), { revealed: isHint })).toEqual([]);
  });

  it('案内と指していなければ、同じ class でも落とす', () => {
    expect(failuresOf(hint('group-hover:opacity-100 group-focus:opacity-100'))).toContainEqual(
      expect.stringContaining('見えない文字 (opacity-0 は hover / focus で出る案内だけ): opacity-0'),
    );
  });

  it('案内でも、focus で出ない (測られない) なら落とす', () => {
    expect(failuresOf(hint('group-hover:opacity-100'), { revealed: isHint })).toContainEqual(
      expect.stringContaining('案内 "コピー" が focus のときに測られていない'),
    );
  });
});
