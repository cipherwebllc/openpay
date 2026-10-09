// Tab 移動を DOM 順で制御する。初期 focus・Escape・close 時の復元は hooks/useModalFocus が持つ
// (ダイアログはこの関数を直接呼ばず、useModalFocus を使う)。
export function trapModalFocus(event: KeyboardEvent, dialog: HTMLElement) {
  // IME の候補操作を奪わない (229 は isComposing が false になるブラウザの互換用)。
  if (event.key !== 'Tab' || event.isComposing || event.keyCode === 229) return;
  // Safari の既定 Tab 設定でもボタンやリンクを辿れるよう、通常の移動も自前で行う。
  event.preventDefault();

  // paywall の状態や details の開閉で対象が変わるため、Tab ごとに取り直す。
  // 対応はリンク・フォーム部品・summary・明示的な tabindex。contenteditable / iframe /
  // media[controls] / area 固有のフォーカス規則は対象外 (それぞれの selector は含めない)。
  const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(
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
  // ラジオは同じ name ごとに 1 つだけを Tab の停止位置にする (選択中・無ければ先頭)。ブラウザ標準と同じで、
  // グループ内は矢印キー (ブラウザ標準) で動く。全部を辿るとオプション選択などで Tab の回数が膨らむ。
  const radioStops = new Map<string, HTMLInputElement>();
  for (const element of candidates) {
    if (!isNamedRadio(element)) continue;
    const stop = radioStops.get(element.name);
    if (!stop || (!stop.checked && element.checked)) radioStops.set(element.name, element);
  }
  const focusables = candidates.filter(
    (element) => !isNamedRadio(element) || radioStops.get(element.name) === element,
  );
  // 操作対象がない間も背後へ抜けず、初期 focus の dialog に留める。
  if (!focusables.length) {
    dialog.focus();
    return;
  }
  const active = document.activeElement;
  // 停止位置でないラジオ (矢印で選ぶ前の同じグループ) にいるときは、そのグループの停止位置として数える。
  const current = isNamedRadio(active) ? radioStops.get(active.name) ?? active : active;
  const index = current instanceof HTMLElement ? focusables.indexOf(current) : -1;
  if (index >= 0) {
    const step = event.shiftKey ? -1 : 1;
    focusables[(index + step + focusables.length) % focusables.length].focus();
    return;
  }

  // disabled 化などで一覧外になった active は、その DOM 位置から直後 / 直前を探す。
  const ordered = event.shiftKey ? focusables.slice().reverse() : focusables;
  const position = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const next = ordered.find((element) => active && (active.compareDocumentPosition(element) & position));
  (next ?? ordered[0]).focus();
}

function isNamedRadio(element: Element | null): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === 'radio' && element.name !== '';
}
