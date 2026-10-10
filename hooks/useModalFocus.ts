'use client';

// aria-modal を名乗るダイアログの focus 管理を 1 つにまとめる (第 7 回レビュー D11)。
// 開いたら初期 focus・Tab / Shift+Tab は中だけを回る (lib/trapModalFocus)・Escape で閉じる・
// 閉じたら開く前の要素へ focus を戻す。以前は自前の trap (ボタンだけ・2 ボタン固定) や
// 何もしないダイアログが混在し、中身を足すと Tab が背後へ抜けていた。

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { trapModalFocus } from '@/lib/trapModalFocus';

const ARIA_MODAL = '[aria-modal="true"]';

// useModalFocus を使うモーダルどうしの上下は、開いた順のスタックで決める (DOM の順や focus の位置では決めない)。
// キーを処理するのは最上位だけ: 下も上も同じ window の keydown を受けるので、両方が処理すると Escape が
// 誰にも届かなかったり、1 回の Tab で 2 歩進んだりする。
const openDialogs: HTMLElement[] = [];

function isStacked(node: Element): boolean {
  return openDialogs.includes(node as HTMLElement);
}

// hook を使わない外のモーダル (ウォレット接続の QR = Reown AppKit の w3m-modal・body 直下の shadow DOM に
// aria-modal の card) が上に開いている間のキーは、そのモーダルに任せる。AppKit は自前で focus と Escape を扱うので、
// ここで Tab を引き戻したり Escape で下の購入ダイアログまで閉じたりすると操作できなくなる。
// focus の位置だけでは決められない: AppKit は開き直すとき card の描画前に focus を試みるので、focus が下の
// ダイアログや body に残ることがある。そこで「自分より上に、見えている aria-modal があるか」でも見る。

/** focus (キーの宛先) が外のモーダル (hook を使わない aria-modal) の中にある (shadow DOM の中も composedPath で辿る)。 */
function focusInExternalModal(event: KeyboardEvent, dialog: HTMLElement): boolean {
  for (const node of event.composedPath()) {
    if (node === dialog) return false;
    if (node instanceof Element && node.getAttribute('aria-modal') === 'true' && !isStacked(node)) return true;
  }
  return false;
}

function shadowHost(node: Element): Element | null {
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

// DOM に残したまま隠して閉じるモーダルを「開いている」と数えると、下の Tab / Escape が戻らなくなる。
// 要素自身と祖先 (shadow ホストを越えて) の hidden・display:none・inert と、要素自身の visibility を見る。
function isShown(element: Element): boolean {
  const native = typeof element.checkVisibility === 'function';
  if (native) {
    if (!element.checkVisibility({ visibilityProperty: true })) return false;
  } else {
    // visibility は子で visible に上書きできるので、要素自身の計算値だけを見る。
    const { visibility } = window.getComputedStyle(element);
    if (visibility === 'hidden' || visibility === 'collapse') return false;
  }
  for (let node: Element | null = element; node; node = node.parentElement ?? shadowHost(node)) {
    // inert は checkVisibility では分からないので、どちらでも祖先を辿って見る。
    if (node.hasAttribute('inert')) return false;
    if (!native && (node.hasAttribute('hidden') || window.getComputedStyle(node).display === 'none')) return false;
  }
  return true;
}

/** 自分より上に開いている (見えている) 外のモーダル。複数あれば文書順で最後のもの。 */
function externalModalOnTop(dialog: HTMLElement): Element | null {
  let top: Element | null = null;
  for (const child of Array.from(document.body.children)) {
    // light DOM: 自分より後ろ (上に重なる portal・中で開いた入れ子) の aria-modal。hook を使うモーダルはスタックで見る。
    const light = [...(child.matches(ARIA_MODAL) ? [child] : []), ...Array.from(child.querySelectorAll(ARIA_MODAL))]
      .filter((other) => !isStacked(other) && dialog.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
    // body 直下の要素の shadow DOM (AppKit の w3m-modal は body の末尾に置かれる・open root だけ見える)。
    const shadow = child.shadowRoot ? Array.from(child.shadowRoot.querySelectorAll(ARIA_MODAL)) : [];
    for (const other of [...light, ...shadow]) {
      if (isShown(other)) top = other;
    }
  }
  return top;
}

function isFocusable(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.tabIndex >= 0 && !element.matches(':disabled') && isShown(element);
}

function firstFocusableIn(root: Element | ShadowRoot): HTMLElement | null {
  for (const child of Array.from(root.children)) {
    if (isFocusable(child)) return child;
    const inner = (child.shadowRoot && firstFocusableIn(child.shadowRoot)) || firstFocusableIn(child);
    if (inner) return inner;
  }
  return null;
}

/**
 * 外のモーダルの入口: 自身が focus できれば自身 (AppKit の card は tabindex=0)、無ければ中で最初の操作対象。
 * 操作がすべて disabled なら、モーダル自身を tabindex=-1 にして入口にする (下のダイアログへ focus を抜けさせない)。
 */
function entryOf(modal: Element): HTMLElement | null {
  if (isFocusable(modal)) return modal;
  const inner = firstFocusableIn(modal);
  if (inner) return inner;
  if (!(modal instanceof HTMLElement)) return null;
  if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
  return modal;
}

export function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  {
    open,
    onEscape,
    initialFocusRef,
  }: {
    open: boolean;
    /** Escape で呼ぶ。省略すると Escape では閉じない (例: 署名中)。毎回最新の関数を読む。 */
    onEscape?: () => void;
    /** 開いた直後の focus 先。省略時は dialog 自身 (tabIndex={-1} を付けておく)。 */
    initialFocusRef?: RefObject<HTMLElement | null>;
  },
): void {
  // inline の関数が毎回変わっても effect を再実行しない (再実行すると復元先が dialog 内の要素に化ける)。
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const initialFocusRefRef = useRef(initialFocusRef);
  initialFocusRefRef.current = initialFocusRef;

  // useLayoutEffect: 閉じたときの後始末を描画の前に同期で行う。useEffect だと WebKit (CI の mobile-safari) で
  // focus の行き先がまだ決まらず、開いたボタンへ戻らないことがあった (ShopSettingsSheet で実測)。
  useLayoutEffect(() => {
    // cleanup 時は ref が外れている (StrictMode の擬似 unmount も含む) ので node を捕まえておく。
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement;
    openDialogs.push(dialog);
    const onKey = (e: KeyboardEvent) => {
      // 扱うのは Tab と Escape だけ。文字入力や矢印のたびに上のモーダルを探す DOM 検索を走らせない。
      if (e.key !== 'Tab' && e.key !== 'Escape') return;
      // 中の部品 (候補の一覧を閉じる入力など) や別のモーダルが処理済みのキーは、もう一度処理しない。
      if (e.defaultPrevented) return;
      // IME の変換操作 (候補の取り消し等) でダイアログを閉じない・Tab を奪わない。
      if (e.isComposing || e.keyCode === 229) return;
      // hook を使うモーダルが上に開いていれば、そちらに任せる。
      if (openDialogs[openDialogs.length - 1] !== dialog) return;
      if (focusInExternalModal(e, dialog)) return;
      const top = externalModalOnTop(dialog);
      if (top) {
        // 外のモーダルが上に開いているのに focus がその外 (下のダイアログや body) にある。Escape は上のモーダルに
        // 任せて下は閉じない。Tab は上のモーダルの入口へ移す: AppKit は Tab でも描画前に取った card (null) を
        // 見るので、移さないと focus は下のダイアログの次の要素へ進み、QR の操作に辿り着けない。
        const entry = e.key === 'Tab' ? entryOf(top) : null;
        if (entry) {
          e.preventDefault();
          entry.focus();
        }
        return;
      }
      if (e.key === 'Escape') onEscapeRef.current?.();
      trapModalFocus(e, dialog);
    };
    window.addEventListener('keydown', onKey);
    (initialFocusRefRef.current?.current ?? dialog).focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      const index = openDialogs.lastIndexOf(dialog);
      if (index >= 0) openDialogs.splice(index, 1);
      // 明示的に別の要素へ移された focus は奪わない。dialog の除去で body に落ちた場合と、
      // dialog 内に残っている場合 (StrictMode の擬似 cleanup を含む) だけ戻す。
      const active = document.activeElement;
      if (
        previousFocus instanceof HTMLElement &&
        (!active || active === document.body || dialog.contains(active))
      ) {
        previousFocus.focus();
      }
    };
    // 開閉の切替だけで走らせる (ref は安定・関数は上の ref から読む)。
  }, [open, dialogRef]);
}
