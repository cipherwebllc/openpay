import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { handleFontClass } from '@/components/handleFonts';

// @handle の字体は self-host (components/handleFonts.css + public/fonts/handle/)。
// CSS と同梱 woff2 のずれ (参照先が無い = 豆腐/fallback 化、参照されない woff2 = リポの死荷重) と
// 外部 host への逆戻り (build 時の Google 取得で CI が落ちていた) をここで止める。

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'components/handleFonts.css'), 'utf8');
const FONT_DIR = join(ROOT, 'public/fonts/handle');

type Face = { family: string; weight: string; display: string; url: string; range: string };

const faces: Face[] = [...CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, block]) => {
  const get = (key: string) => block.match(new RegExp(`${key}:\\s*([^;]+);`))?.[1].trim() ?? '';
  return {
    family: get('font-family').replace(/'/g, ''),
    weight: get('font-weight'),
    display: get('font-display'),
    url: get('src').match(/url\('([^']+)'\)/)?.[1] ?? '',
    range: get('unicode-range'),
  };
});

function woff2Under(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? woff2Under(join(dir, e.name)) : e.name.endsWith('.woff2') ? [join(dir, e.name)] : [],
  );
}

function classFamilies(cls: string): string[] {
  const body = CSS.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  return (body.match(/font-family:\s*([^;]+);/)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''));
}

describe('handleFonts (self-hosted @handle fonts)', () => {
  it('serves every face from /fonts/handle/ with a unicode-range and swap', () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const f of faces) {
      expect(f.url).toMatch(/^\/fonts\/handle\/[a-z0-9.-]+\/[a-z0-9-]+\.woff2$/);
      expect(existsSync(join(ROOT, 'public', f.url))).toBe(true);
      expect(f.range).toMatch(/^U\+[0-9a-fA-F]/);
      expect(f.display).toBe('swap');
    }
    expect(CSS).not.toMatch(/https?:\/\//);
  });

  it('ships no woff2 that the CSS does not reference', () => {
    const referenced = new Set(faces.map((f) => join(ROOT, 'public', f.url)));
    expect(woff2Under(FONT_DIR).filter((p) => !referenced.has(p))).toEqual([]);
  });

  it('keeps the 400/700 weights of both families', () => {
    for (const family of ['OpenPay Handle Serif', 'OpenPay Handle Rounded']) {
      const weights = new Set(faces.filter((f) => f.family === family).map((f) => f.weight));
      expect([...weights].sort()).toEqual(['400', '700']);
    }
  });

  // 片方の weight だけスライスが欠けると、その weight の字だけ fallback になる。serif は 400 と 700 が
  // 同じ可変フォントを指すので、「参照されない woff2 が無い」だけでは 400 側の欠けを検出できない。
  it.each([
    ['OpenPay Handle Serif', 124],
    ['OpenPay Handle Rounded', 122],
  ])('%s declares the same %i slices (full unicode-range) for 400 and 700', (family, slices) => {
    const of = (weight: string) => faces.filter((f) => f.family === family && f.weight === weight);
    const [w400, w700] = [of('400'), of('700')];
    expect(w400).toHaveLength(slices);
    expect(w700).toHaveLength(slices);
    const ranges = (list: Face[]) => list.map((f) => f.range).sort();
    expect(new Set(ranges(w400)).size).toBe(slices);
    expect(ranges(w700)).toEqual(ranges(w400));
    const byRange = new Map(w400.map((f) => [f.range, f.url]));
    for (const f of w700) {
      const url400 = byRange.get(f.range)!;
      // serif は可変フォント 1 本 (同じ URL)。rounded は weight ごとの静的ファイル (同じスライス番号)。
      expect(f.url).toBe(family === 'OpenPay Handle Serif' ? url400 : url400.replace('-400-normal.', '-700-normal.'));
    }
  });

  it('bundles the OFL text for both fonts', () => {
    for (const name of ['OFL-NotoSerifJP.txt', 'OFL-ZenMaruGothic.txt']) {
      expect(readFileSync(join(FONT_DIR, name), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    }
  });

  it('maps serif/rounded to classes whose first family is the self-hosted face', () => {
    expect(handleFontClass(undefined)).toBeUndefined();
    expect(handleFontClass('sans')).toBeUndefined();
    expect(classFamilies(handleFontClass('serif')!)).toEqual([
      'OpenPay Handle Serif', 'Hiragino Mincho ProN', 'Yu Mincho', 'Georgia', 'serif',
    ]);
    expect(classFamilies(handleFontClass('rounded')!)).toEqual([
      'OpenPay Handle Rounded', 'Hiragino Maru Gothic ProN', 'BIZ UDPGothic', 'system-ui', 'sans-serif',
    ]);
  });
});
