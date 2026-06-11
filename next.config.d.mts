// next.config.mjs の型宣言 (tests/app/next-config-headers.test.ts が headers() の
// frame 保護方針を import して検証するため。tsc は allowJs なしで .mjs を解決しない)。
import type { NextConfig } from 'next';

declare const config: NextConfig;
export default config;
