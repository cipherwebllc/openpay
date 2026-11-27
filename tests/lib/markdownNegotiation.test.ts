import { describe, expect, it } from 'vitest';
import { prefersMarkdown } from '@/lib/markdownNegotiation';

describe('prefersMarkdown', () => {
  it('Markdown だけを求めたら true', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown; charset=utf-8')).toBe(true);
    expect(prefersMarkdown('TEXT/MARKDOWN')).toBe(true);
  });

  it('Markdown を HTML 以上に好めば true (同じ q は Markdown)', () => {
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
    expect(prefersMarkdown('text/html, text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, */*')).toBe(true);
  });

  it('ブラウザの Accept (text/markdown を含まない) は false', () => {
    expect(
      prefersMarkdown(
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      ),
    ).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
  });

  it('HTML のほうを好む・q=0・読めない q・空は false', () => {
    expect(prefersMarkdown('text/html, text/markdown;q=0.5')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=abc')).toBe(false);
    expect(prefersMarkdown('')).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
  });
});
