import { describe, it, expect } from 'vitest';
import {
  HANDLE_THEMES,
  isHandleTheme,
  resolveHandleTheme,
  handleViewTheme,
  handlePageTheme,
  handlePreviewBackground,
} from '@/lib/handleTheme';

const ACCENT = '#2563eb';

describe('resolveHandleTheme', () => {
  it('accepts each known theme', () => {
    for (const th of HANDLE_THEMES) {
      expect(resolveHandleTheme(th)).toBe(th);
    }
  });
  it('falls back unknown / non-string / undefined to clean (never throws)', () => {
    expect(resolveHandleTheme('neon')).toBe('clean');
    expect(resolveHandleTheme('')).toBe('clean');
    expect(resolveHandleTheme(undefined)).toBe('clean');
    expect(resolveHandleTheme(null)).toBe('clean');
    expect(resolveHandleTheme(42)).toBe('clean');
    expect(resolveHandleTheme({})).toBe('clean');
  });
});

describe('isHandleTheme', () => {
  it('is a precise type guard', () => {
    expect(isHandleTheme('night')).toBe(true);
    expect(isHandleTheme('CLEAN')).toBe(false);
    expect(isHandleTheme(1)).toBe(false);
  });
});

describe('handleViewTheme', () => {
  it('clean returns no inline overrides so the current className path is used (pixel parity)', () => {
    const tk = handleViewTheme(ACCENT, 'clean');
    expect(tk.inkColor).toBeUndefined();
    expect(tk.bioColor).toBeUndefined();
    expect(tk.linkStyle).toBeUndefined();
    expect(tk.dark).toBe(false);
    expect(tk.handleColor).toBe(ACCENT);
    expect(tk.socialVariant).toBe('default');
    // clean avatar ring は現行 component と同一の値であること (mock 近似ではない)。
    expect(tk.avatarRing).toBe(
      `0 0 0 4px #ffffff, 0 0 0 6px ${ACCENT}33, 0 16px 36px -12px ${ACCENT}59`,
    );
  });
  it('night is dark with light ink/bio + dark social variant', () => {
    const tk = handleViewTheme(ACCENT, 'night');
    expect(tk.dark).toBe(true);
    expect(tk.inkColor).toBe('#f8fafc');
    expect(tk.bioColor).toBe('#cbd5e1');
    expect(tk.handleColor).toBe('#93c5fd');
    expect(tk.socialVariant).toBe('dark');
    expect(tk.linkStyle).toBeDefined();
  });
  it('bold fills links with the accent color', () => {
    const tk = handleViewTheme(ACCENT, 'bold');
    expect(tk.linkStyle?.backgroundColor).toBe(ACCENT);
    expect(tk.linkStyle?.color).toBe('#ffffff');
  });
  it('every theme provides a featured style', () => {
    for (const th of HANDLE_THEMES) {
      expect(handleViewTheme(ACCENT, th).featuredStyle).toBeDefined();
    }
  });
});

describe('handlePageTheme', () => {
  it('clean keeps the current top wash (not full-viewport, not dark)', () => {
    const pt = handlePageTheme(ACCENT, 'clean');
    expect(pt.dark).toBe(false);
    expect(pt.full).toBe(false);
    expect(pt.background).toBe(
      `radial-gradient(125% 70% at 50% 0%, ${ACCENT}29 0%, ${ACCENT}0d 32%, transparent 68%)`,
    );
  });
  it('night is dark and covers the full viewport', () => {
    const pt = handlePageTheme(ACCENT, 'night');
    expect(pt.dark).toBe(true);
    expect(pt.full).toBe(true);
    expect(pt.background).toContain('#0f172a');
  });
  it('non-clean light themes are opaque and full (cover body bg)', () => {
    for (const th of ['gradient', 'bold', 'outline', 'soft'] as const) {
      const pt = handlePageTheme(ACCENT, th);
      expect(pt.full).toBe(true);
      expect(pt.dark).toBe(false);
    }
  });
});

describe('handlePreviewBackground', () => {
  it('clean is undefined (keeps bg-white preview)', () => {
    expect(handlePreviewBackground(ACCENT, 'clean')).toBeUndefined();
  });
  it('non-clean themes return a background', () => {
    for (const th of ['gradient', 'bold', 'outline', 'night', 'soft'] as const) {
      expect(typeof handlePreviewBackground(ACCENT, th)).toBe('string');
    }
  });
});
