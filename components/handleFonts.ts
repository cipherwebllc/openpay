import { Noto_Serif_JP, Zen_Maru_Gothic } from 'next/font/google';
import type { HandleFont } from '@/lib/handle';

const serif = Noto_Serif_JP({
  weight: ['400', '700'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  fallback: ['Hiragino Mincho ProN', 'Yu Mincho', 'Georgia', 'serif'],
});

const rounded = Zen_Maru_Gothic({
  weight: ['400', '700'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  fallback: ['Hiragino Maru Gothic ProN', 'BIZ UDPGothic', 'system-ui', 'sans-serif'],
});

export function handleFontClass(font: HandleFont | undefined): string | undefined {
  switch (font) {
    case 'serif':
      return serif.className;
    case 'rounded':
      return rounded.className;
    default:
      return undefined;
  }
}
