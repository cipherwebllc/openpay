// `<a download>` をプログラム的に発火するヘルパー。
// QrGenerator (SVG/PNG) と HistoryToolbar (CSV) が共通で使う。
//
// document を直接触るので browser 専用。SSR 環境では呼ばないこと。

export function triggerDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

/**
 * Blob を ObjectURL 経由でダウンロードする。終了後 revokeObjectURL で
 * メモリリークを回避。createObjectURL は同期で Blob を URL に変換し、
 * click 後ただちに revoke しても通常 download は完了する (browser 実装が
 * URL を内部参照として保持) — 念のため microtask の後ろで解放する。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  // a.click() は同期だが安全側に倒して queueMicrotask 後に revoke。
  queueMicrotask(() => URL.revokeObjectURL(url));
}
