// Tab 移動を DOM 順で制御する。初期 focus・Escape・close 時の復元は呼び出し側の契約を保つ。
export function trapModalFocus(event: KeyboardEvent, dialog: HTMLElement) {
  // IME の候補操作を奪わない (229 は isComposing が false になるブラウザの互換用)。
  if (event.key !== 'Tab' || event.isComposing || event.keyCode === 229) return;
  // Safari の既定 Tab 設定でもボタンやリンクを辿れるよう、通常の移動も自前で行う。
  event.preventDefault();

  // paywall の状態や details の開閉で対象が変わるため、Tab ごとに取り直す。
  // 対応はリンク・フォーム部品・summary・明示的な tabindex。contenteditable / iframe /
  // media[controls] / area 固有のフォーカス規則は対象外 (それぞれの selector は含めない)。
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, summary, [tabindex]',
  )).filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled')) return false;
    // visibility は子で visible に上書きできるため、要素自身の computed 値だけを見る。
    const { visibility } = window.getComputedStyle(element);
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if (node.hidden || node.hasAttribute('inert')) return false;
      if (window.getComputedStyle(node).display === 'none') return false;
      if (node instanceof HTMLDetailsElement && !node.open) {
        const summary = node.querySelector('summary');
        if (!summary?.contains(element)) return false;
      }
      if (node === dialog) break;
    }
    return true;
  });
  // 操作対象がない間も背後へ抜けず、初期 focus の dialog に留める。
  if (!focusables.length) {
    dialog.focus();
    return;
  }
  const active = document.activeElement;
  const index = active instanceof HTMLElement ? focusables.indexOf(active) : -1;
  if (index >= 0) {
    const step = event.shiftKey ? -1 : 1;
    focusables[(index + step + focusables.length) % focusables.length].focus();
    return;
  }

  // disabled 化などで一覧外になった active は、その DOM 位置から直後 / 直前を探す。
  const candidates = event.shiftKey ? focusables.slice().reverse() : focusables;
  const position = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const next = candidates.find((element) => active && (active.compareDocumentPosition(element) & position));
  (next ?? candidates[0]).focus();
}
