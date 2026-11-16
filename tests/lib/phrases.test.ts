// 日本語の文を文節で区切る lib/phrase/phrases.ts のテスト。
//   - upstream (BudouX v0.10.3 の parser) と同じ式であること (upstream のテストの例)
//   - この file が足している決まり (禁則・割らない語・日本語を含まない文)
//   - トップの文言を 1 字も変えないこと (つなぐと元に戻る)
//   - 置いた model と LICENSE が upstream のままであること (sha256)
//   - model が client の bundle に入らないこと ('use client' の file からたどれない)

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import model from '@/lib/phrase/budoux-ja.json';
import { PHRASE_KEEP_WORDS, createBoundaryParser, phrasesJa } from '@/lib/phrase/phrases';
import { pricingContentFor } from '@/lib/pricing';

const ROOT = resolve(__dirname, '../..');
const L = ja.Landing as Record<string, string>;
const LANDING_JA = Object.entries(L).filter((entry): entry is [string, string] => typeof entry[1] === 'string');

/** model の生の区切り (禁則と割らない語を掛ける前) で分けた塊。 */
const rawBoundaries = createBoundaryParser(model);
function rawPhrases(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const i of rawBoundaries(text)) {
    parts.push(text.slice(start, i));
    start = i;
  }
  parts.push(text.slice(start));
  return parts;
}

describe('区切りの計算は upstream (BudouX の parser) と同じ', () => {
  it('upstream の例: 「今日は天気です。」→「今日は」「天気です。」', () => {
    expect(phrasesJa('今日は天気です。')).toEqual(['今日は', '天気です。']);
    expect(rawPhrases('今日は天気です。')).toEqual(['今日は', '天気です。']);
  });

  it('upstream のテストの model: { UW4: { a: 10000 } } は「a の前」で区切る (文の頭は区切らない)', () => {
    // base = −0.5 × 10000 = −5000。a の前だけ −5000 + 10000 > 0。
    expect(createBoundaryParser({ UW4: { a: 10000 } })('abcdeabcd')).toEqual([5]);
    expect(createBoundaryParser({ UW4: { a: 10000 } })('xyz')).toEqual([]);
  });

  it('特徴は前後 3 字 (UW1〜6・BW1〜3・TW1〜4)。文の端では、切り出しの範囲が詰まる', () => {
    // 1 つの特徴だけが効く model で、どの位置の字を見ているかを固定する (重み 10 → base −5)。
    const at = (feature: string, key: string, sentence: string) => createBoundaryParser({ [feature]: { [key]: 10 } })(sentence);
    expect(at('UW1', 'a', 'abcdef')).toEqual([3]); // 3 字前
    expect(at('UW2', 'a', 'abcdef')).toEqual([2]); // 2 字前
    expect(at('UW3', 'a', 'abcdef')).toEqual([1]); // 直前
    expect(at('UW4', 'c', 'abcdef')).toEqual([2]); // 直後
    expect(at('UW5', 'c', 'abcdef')).toEqual([1]); // 2 字後
    expect(at('UW6', 'd', 'abcdef')).toEqual([1]); // 3 字後
    expect(at('BW1', 'ab', 'abcdef')).toEqual([2]);
    expect(at('BW2', 'bc', 'abcdef')).toEqual([2]);
    expect(at('BW3', 'cd', 'abcdef')).toEqual([2]);
    expect(at('TW1', 'abc', 'abcdef')).toEqual([3]);
    expect(at('TW2', 'abc', 'abcdef')).toEqual([2]);
    expect(at('TW3', 'bcd', 'abcdef')).toEqual([2]);
    expect(at('TW4', 'cde', 'abcdef')).toEqual([2]);
    // 文の頭の近くでは substring が範囲を詰める (upstream と同じ): i = 1 の TW2 は「頭から 2 字」を見る。
    expect(at('TW2', 'ab', 'abcdef')).toEqual([1]);
  });

  it('しきい値は 0 より大きい (ちょうど 0 は区切らない)・負の重みは区切りを消す', () => {
    // a の前: base −5 + 10 = 5 > 0。b の重みを足すと base が変わる: { a: 10, b: -10 } は base 0 → a の前は 10・b の前は −10。
    expect(createBoundaryParser({ UW4: { a: 10, b: -10 } })('xaxb')).toEqual([1]);
    // 重みの和が 0 になる位置 (base −5 + a 10 + UW3 の x −5 = 0) は区切らない。
    expect(createBoundaryParser({ UW4: { a: 10 }, UW3: { x: -5, y: 5 } })('xa')).toEqual([]);
  });

  it('surrogate pair (絵文字) の上位と下位の間では区切らない', () => {
    // 上位 surrogate の直後で区切りたがる model。守りが無いと i = 2 (絵文字の真ん中) で区切る。
    const parse = createBoundaryParser({ UW3: { '\uD83D': 10 } });
    expect(parse('a😀b')).toEqual([]);
    expect(phrasesJa('今日は😀天気です。').join('')).toBe('今日は😀天気です。');
    for (const part of phrasesJa('今日は😀天気です。')) expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });
});

describe('この file が足している決まり', () => {
  it('空の文は空の配列・日本語の字を含まない文は、その文 1 つだけ', () => {
    expect(phrasesJa('')).toEqual([]);
    expect(phrasesJa('JPYC payments for your shop, from ¥0 in fees.')).toEqual(['JPYC payments for your shop, from ¥0 in fees.']);
    expect(phrasesJa('1%')).toEqual(['1%']);
  });

  it('en の文言は区切らない (トップの en の全部)', () => {
    const split = Object.entries(en.Landing as Record<string, string>).filter(([, text]) => typeof text === 'string' && phrasesJa(text).length > 1);
    expect(split).toEqual([]);
  });

  it('禁則: 開き括弧の直後では区切らない (model は「なります | （ | お試しにも」と出す)', () => {
    // model の生の出力が、開き括弧の直後で区切っていること (この検査が空振りしない)。
    expect(rawPhrases(L.supportTipRequest)).toContain('（');
    expect(phrasesJa(L.supportTipRequest)).toEqual(['運営を', '持続させる', 'ため、', '応援いただけると', '励みに', 'なります', '（お試しにも', 'どうぞ）。']);
  });

  it('禁則: トップのどの文でも、塊は開き括弧で終わらず、閉じ括弧・句読点・小さいかな・長音・繰り返しの記号で始まらない', () => {
    const bad: string[] = [];
    for (const [key, text] of LANDING_JA) {
      const parts = phrasesJa(text);
      parts.forEach((part, i) => {
        if (i < parts.length - 1 && /[（「『〔【［(]$/.test(part)) bad.push(`${key}: 「${part}」で終わる`);
        if (i > 0 && /^[）」』〕】］)、。，．・：；！？!?ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー々ゝゞ]/.test(part)) bad.push(`${key}: 「${part}」で始まる`);
      });
    }
    expect(bad).toEqual([]);
  });

  it.each([
    ['閉じ括弧', '(日本居住者のみ)', ['(日本居住者のみ', ')'], ['(日本居住者のみ)']],
    ['閉じ括弧 + 句点', '8 桁まで)。', ['8 桁まで', ')。'], ['8 桁まで)。']],
    ['中点', '200 字まで・例: お店の紹介', ['200 字まで', '・例: お店の', '紹介'], ['200 字まで・例: お店の', '紹介']],
    ['全角のコロン', 'はじめての方へ：モバイルオーダー', ['はじめての', '方へ', '：モバイルオーダー'], ['はじめての', '方へ：モバイルオーダー']],
  ])('禁則: %s の直前では区切らない (model は直前に区切りを出す)', (_name, text, raw, expected) => {
    // model の生の出力が、その字の直前で区切っていること (この検査が空振りしない)。
    expect(rawPhrases(text)).toEqual(raw);
    expect(phrasesJa(text)).toEqual(expected);
  });

  it('割らない語の表は、この 6 語 (足すときは、model が語の途中で区切る文をここに足す)', () => {
    expect([...PHRASE_KEEP_WORDS]).toEqual(['しくみ', 'できます', 'として', '払い戻', 'その場', 'により']);
  });

  it.each([
    ['しくみ', 'eyebrowTech', 'しく', 'み'],
    ['できます', 'faqA1', '完結で', 'きます。'],
    ['として', 'whyItem1Body', ' 1 円と', 'して'],
    ['払い戻', 'whyItem1Body', '払い', '戻せます。'],
    ['その場', 'heroBody', 'その', '場で、'],
    ['により', 'cashTableFootnote', 'プランに', 'より'],
  ])('割らない語「%s」: model は %s で語の途中に区切りを出すが、後処理が消す', (word, key, left, right) => {
    expect(PHRASE_KEEP_WORDS).toContain(word);
    const raw = rawPhrases(L[key]);
    // model の生の出力が、語の途中で区切っていること (この検査が空振りしない)。
    const at = raw.indexOf(left);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(raw[at + 1]).toBe(right);
    // 後処理の後は、語を丸ごと含む塊がある。
    expect(phrasesJa(L[key]).some((part) => part.includes(word))).toBe(true);
  });

  it('割らない語: トップのどの文でも、表の語の途中に区切りが無い', () => {
    const bad: string[] = [];
    for (const [key, text] of LANDING_JA) {
      let offset = 0;
      const starts = new Set<number>();
      for (const part of phrasesJa(text)) {
        starts.add(offset);
        offset += part.length;
      }
      for (const word of PHRASE_KEEP_WORDS) {
        for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
          for (let i = at + 1; i < at + word.length; i++) if (starts.has(i)) bad.push(`${key}: 「${word}」の途中`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('割らない語は、語の前後の区切りを消さない', () => {
    // 「その場で、」の前 (売上は | その場で、) と後 (その場で、 | あなたの) は区切りのまま。
    const parts = phrasesJa(L.heroBody);
    expect(parts).toContain('その場で、');
    expect(parts[parts.indexOf('その場で、') - 1]).toBe('売上は');
    expect(parts[parts.indexOf('その場で、') + 1]).toBe('あなたの');
    // 語のすぐ後ろの区切り (として | 払い戻せます) も消さない。
    const why = phrasesJa(L.whyItem1Body);
    expect(why).toContain(' 1 円として');
    expect(why[why.indexOf(' 1 円として') + 1]).toBe('払い戻せます。');
  });

  it('割らない語: 同じ語が 1 つの文に 2 回出ても、どちらの途中でも区切らない', () => {
    // model の生の出力は、2 回とも語の途中で区切る (この検査が空振りしない)。
    expect(rawPhrases('支払いを完結できます。残高だけで支払いを完結できます。')).toEqual(['支払いを', '完結で', 'きます。', '残高だけで', '支払いを', '完結で', 'きます。']);
    expect(phrasesJa('支払いを完結できます。残高だけで支払いを完結できます。')).toEqual(['支払いを', '完結できます。', '残高だけで', '支払いを', '完結できます。']);
    expect(phrasesJa('売上はその場で、注文もその場で、届きます。')).toEqual(['売上は', 'その場で、', '注文も', 'その場で、', '届きます。']);
  });
});

describe('文言を 1 字も変えない', () => {
  it('トップの ja の文言 (全部) と料金の節の見出しは、塊をつなぐと元の文に戻る', () => {
    const pricing = pricingContentFor('ja');
    const texts = [...LANDING_JA.map(([, text]) => text), pricing.summaryTitle, pricing.lead];
    expect(texts.length).toBeGreaterThan(200);
    for (const text of texts) expect(phrasesJa(text).join('')).toBe(text);
    // 区切りが実際に入っている (この検査が空振りしない)。
    expect(texts.filter((text) => phrasesJa(text).length > 1).length).toBeGreaterThan(100);
  });

  it('空白・全角の空白・改行・記号も、そのまま返す', () => {
    for (const text of ['JPYC は 4、USDC は 7 チェーン。', 'JPYCとは　日本円連動のステーブルコイン。', '1 行目です。\n2 行目です。', '導入費 0 円・契約不要。今日から、ウォレット 1 つで始められます。']) {
      expect(phrasesJa(text).join('')).toBe(text);
    }
  });

  it('ヒーローの見出しの区切り (iPhone で「お店のJPYC決済を、 / 利用料0円から。」と折れる)', () => {
    expect(phrasesJa(L.heroLeadline)).toEqual(['お店の', 'JPYC決済を、', '利用料0円から。']);
  });

  it('ヒーローの本文の区切り', () => {
    expect(phrasesJa(L.heroBody)).toEqual([
      'お客様が',
      'ガス代を',
      '払う',
      '通常決済なら、',
      '利用料は',
      '0円',
      '（モバイル注文を',
      '除く）。',
      '売上は',
      'その場で、',
      'あなたの',
      'ウォレットへ',
      '届きます。',
    ]);
  });
});

describe('置いた model と LICENSE は upstream (google/budoux tag v0.10.3) のまま', () => {
  const sha256 = (file: string) => createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex');

  it('lib/phrase/budoux-ja.json = budoux/models/ja.json (20,036 byte・改行なしの 1 行)', () => {
    const bytes = readFileSync(join(ROOT, 'lib/phrase/budoux-ja.json'));
    expect(bytes.length).toBe(20036);
    expect(bytes.includes(0x0a)).toBe(false);
    expect(sha256('lib/phrase/budoux-ja.json')).toBe('1e0ed578ad0f4ac14045e5f5fddbe263962a7f5e8fe22821da0048188aa55551');
  });

  it('lib/phrase/LICENSE = Apache-2.0 の全文 (11,357 byte)', () => {
    expect(readFileSync(join(ROOT, 'lib/phrase/LICENSE')).length).toBe(11357);
    expect(sha256('lib/phrase/LICENSE')).toBe('58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd');
  });

  it('model は 13 の表 (UW1〜6・BW1〜3・TW1〜4) で、重みは全部整数', () => {
    expect(Object.keys(model).sort()).toEqual(['BW1', 'BW2', 'BW3', 'TW1', 'TW2', 'TW3', 'TW4', 'UW1', 'UW2', 'UW3', 'UW4', 'UW5', 'UW6']);
    for (const group of Object.values(model)) for (const weight of Object.values(group)) expect(Number.isInteger(weight)).toBe(true);
  });

  it('git が model の中身を変えない (.gitattributes で text の変換を外す)', () => {
    expect(readFileSync(join(ROOT, '.gitattributes'), 'utf8')).toMatch(/^lib\/phrase\/budoux-ja\.json\s+-text$/m);
  });

  it('出どころと license の表記: phrases.ts の頭と lib/phrase/README.md', () => {
    const head = readFileSync(join(ROOT, 'lib/phrase/phrases.ts'), 'utf8').split('\nimport ')[0];
    for (const text of ['github.com/google/budoux', 'javascript/src/parser.ts', 'v0.10.3', 'Copyright 2021 Google LLC', 'Apache License, Version 2.0']) expect(head).toContain(text);
    const readme = readFileSync(join(ROOT, 'lib/phrase/README.md'), 'utf8');
    for (const text of ['github.com/google/budoux', 'v0.10.3', 'budoux/models/ja.json', '1e0ed578ad0f4ac14045e5f5fddbe263962a7f5e8fe22821da0048188aa55551', 'Apache-2.0']) {
      expect(readme).toContain(text);
    }
  });
});

describe('model は server だけ (client の bundle に入れない)', () => {
  // vitest は 'server-only' を空の module に置き換える (vitest.config.ts) ので、実行では client からの import を捕まえられない。
  // source を読んで、'use client' の file から (間の file を通っても) たどれないことを見る。next build も同じ誤りで落ちる。
  const DIRS = ['app', 'components', 'hooks', 'lib', 'i18n'];
  const FORBIDDEN = ['lib/phrase/phrases.ts', 'components/Phrased.tsx'];

  function listSources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return listSources(full);
      return /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [full] : [];
    });
  }
  const files = DIRS.flatMap((dir) => listSources(join(ROOT, dir)));
  const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  const isClient = (source: string) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/.test(source);

  /** 実行時の import 先 (型だけの import は消えるので数えない)。リポの中の file だけ。 */
  function importsOf(file: string): string[] {
    const source = sources.get(file) ?? '';
    const specifiers = [
      ...[...source.matchAll(/^\s*import\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...source.matchAll(/^\s*export\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    return specifiers.flatMap((specifier) => {
      const base = specifier.startsWith('@/') ? join(ROOT, specifier.slice(2)) : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
      if (!base) return [];
      const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find((candidate) => sources.has(candidate));
      return hit ? [hit] : [];
    });
  }

  function reach(entry: string): Set<string> {
    const seen = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length > 0) {
      for (const next of importsOf(queue.pop()!)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  it("'use client' の file から、lib/phrase/phrases.ts と components/Phrased.tsx にたどれない", () => {
    const clients = files.filter((file) => isClient(sources.get(file)!));
    // client の file を実際に見ている (この検査が空振りしない)。
    expect(clients.length).toBeGreaterThan(100);
    const leaks: string[] = [];
    for (const client of clients) {
      const seen = reach(client);
      for (const forbidden of FORBIDDEN) if (seen.has(join(ROOT, forbidden))) leaks.push(`${relative(ROOT, client)} → ${forbidden}`);
    }
    expect(leaks).toEqual([]);
  });

  it('たどり方が効いている: 区切りを使うトップの節 (server) からは、model までたどれる', () => {
    const seen = reach(join(ROOT, 'components/LandingHero.tsx'));
    expect(seen.has(join(ROOT, 'components/Phrased.tsx'))).toBe(true);
    expect(seen.has(join(ROOT, 'lib/phrase/phrases.ts'))).toBe(true);
    expect(isClient(sources.get(join(ROOT, 'components/LandingHero.tsx'))!)).toBe(false);
    expect(isClient("// コメント\n'use client';\nimport x from 'y';")).toBe(true);
  });

  it("どちらの file も 'server-only' を import し、'use client' を付けない", () => {
    for (const file of FORBIDDEN) {
      const source = sources.get(join(ROOT, file))!;
      expect(source).toMatch(/^import 'server-only';$/m);
      expect(isClient(source)).toBe(false);
    }
  });
});

describe('折り方の CSS (app/globals.css)', () => {
  const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('文節で折れないブラウザだけ、区切りを入れた文を「区切りでだけ折る」(keep-all)・欄より長い塊ははみ出さずに折る (anywhere)', () => {
    const block = css.match(/@supports not \(word-break: auto-phrase\) \{\s*\.phrased \{([^}]*)\}\s*\}/);
    expect(block).not.toBeNull();
    expect(block![1].split(';').map((line) => line.trim()).filter(Boolean).sort()).toEqual(['overflow-wrap: anywhere', 'word-break: keep-all']);
  });

  it('.phrased の指定はこの 1 つだけ (文節で折れるブラウザには何も足さない・<wbr> を消さない)', () => {
    // <wbr> を display: none にすると、見出しの名前を自前で計算する道具 (Playwright) が名前に空白を入れる。
    expect(css.match(/\.phrased/g)).toHaveLength(1);
    expect(css).not.toMatch(/wbr/);
  });
});
