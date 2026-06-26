import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1e40af',
          light: '#3b82f6',
          dark: '#1e3a8a',
        },
      },
      // 影は「面の浮き」を表す統一トークン。フラットな border+shadow-sm から、
      // 低く柔らかい多層シャドウへ寄せて上質な奥行きを与える (引き算: 境界線への依存を減らす)。
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        'card-hover':
          '0 6px 16px -6px rgb(15 23 42 / 0.12), 0 2px 6px -2px rgb(15 23 42 / 0.06)',
        lift: '0 14px 40px -12px rgb(15 23 42 / 0.18)',
      },
    },
  },
  plugins: [],
};

export default config;
