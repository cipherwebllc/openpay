// 決済 QR の中央に置く OpenPay マーク (80px PNG を data URI で inline)。
//
// **URL 参照ではなく inline なのは PNG 保存のため**: QrGenerator の downloadPng は QR の SVG を
// serialize → data: URI 化 → canvas へ描画する。外部参照 (<image href="/icon.png">) は data: URI 化した
// SVG の中で相対 URL を解決できず、保存された PNG からロゴだけが消える。data URI なら同一 SVG に
// 閉じるため、画面・印刷・SVG 保存・PNG 保存のすべてで同じ絵になる (canvas も汚染しない)。
//
// サイズは 80px / 8 色パレットで約 0.4KB。QR は level='H' (30% 誤り訂正) と併用すること —
// 中央を excavate する分の冗長性を確保できず読取率が落ちるため、level を下げてはならない。
export const QR_CENTER_MARK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABQAgMAAADzfxo+AAAADFBMVEX9/f0FV/wKCgqft+iJCGxIAAAACXBIWXMAAAsTAAALEwEAmpwYAAABT0lEQVR42r2VO27DMAyG2QhZCjSZcpQuAQroCB5sePEhfIAC6VE6qxl8BF4il+iUCwSoFMl6kH/RTOUgyJ/FhySSIufclSrZe0DOLdTILsAvEvLt4VnCo4eLhBsPWUJypEx6o3TW8EifGj7TouGOPjTcYKgjIoNhOZ6r/v02DO+SvQxeZgEvAY5goVx6iLBvghiSsNZu9V9XOEnf0n/4Pt3CWNhTVAxGbOOHYwzF0zZ58Eu72vmcNKZ6P5z20FcRjWJyj6jPKtXOp2ycC+xybFxinzO0BVo5C1POhixJS6bs898gDOm34PU2TQ31KW2rxEGHjK8DXhy8YpgMKW2oSZuQYF38Z5tU7GPit0k7rmOT3vf1kygENqIQzApZFBeTKK6gH2yKir2EkETB0n7GbeAvebzbPN7BYAOErRI2Vdh+YaPGLR02f/hMwAcFPD0/rFut4dz6OFwAAAAASUVORK5CYII=';

/** QR 表示サイズに対する中央マークの一辺の比率。読取性を優先し 17% を上限とする。 */
export const QR_CENTER_MARK_RATIO = 0.17;
