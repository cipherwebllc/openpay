import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom は matchMedia を実装しないため、既定の no-op スタブを各テスト前に用意する
// (matches=false = 非 standalone / 非モバイル)。PwaInstallHint は広く render される
// (QrGenerator / HistoryView / ScanShell) 一方で usePwaDisplayMode 経由で matchMedia を
// 呼ぶ。個別に stub したいテスト (PwaInstallHint / ScanShell) は body 内で上書きする。
beforeEach(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  // 次テストが既定 stub から始まるよう matchMedia をリセット (matches=true を残さない)。
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});
