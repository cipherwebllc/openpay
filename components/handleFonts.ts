// @handle プロフィールの字体 (serif / rounded) を当てる class 名。字体本体は handleFonts.css の
// @font-face (public/fonts/handle/ を self-host・unicode-range で分割) — next/font/google は build 時に
// Google から CSS を取りに行き、取得失敗で build ごと落ちるため使わない。CSS はこの module を
// import するルート (HandleProfile / HandleProfileBuilder) にだけ載る。
import './handleFonts.css';
import type { HandleFont } from '@/lib/handle';

export function handleFontClass(font: HandleFont | undefined): string | undefined {
  switch (font) {
    case 'serif':
      return 'handle-font-serif';
    case 'rounded':
      return 'handle-font-rounded';
    default:
      return undefined;
  }
}
