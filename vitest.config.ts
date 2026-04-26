import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'https://test.local/',
      },
    },
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // 環境変数はモジュール評価より前にセットされる必要があるため、
    // setupFiles ではなくここで定義する。
    env: {
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
      NEXT_PUBLIC_PIMLICO_API_KEY: 'test_pimlico_key',
      NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID: 'sp_test',
      NEXT_PUBLIC_FEE_RECEIVER_ADDRESS:
        '0xdead000000000000000000000000000000001234',
      NEXT_PUBLIC_JPYC_TESTNET_ADDRESS:
        '0x0000000000000000000000000000000000000abc',
    },
  },
});
