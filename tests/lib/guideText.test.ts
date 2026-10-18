// lib/guideText.ts: 開示の文を文言を変えずに「要点」と「くわしく」に分ける。括弧の中の区切りでは切らない。

import { describe, expect, it } from 'vitest';
import { splitBeforeSentence, splitSentences } from '@/lib/guideText';
import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

function faqA2(messages: typeof ja): string {
  return Object.entries(LANDING_PAYMENT_FEE_VALUES).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    messages.Landing.faqA2,
  );
}

describe('splitSentences', () => {
  it('括弧の外の「。」と「. 」だけで切る', () => {
    expect(splitSentences('一。二（中。中）です。三')).toEqual(['一。', '二（中。中）です。', '三']);
    expect(splitSentences('One. Two (a. b) here. Three')).toEqual(['One.', 'Two (a. b) here.', 'Three']);
  });
});

describe('splitBeforeSentence', () => {
  it.each([
    ['ja', ja],
    ['en', en],
  ] as const)('%s: faqA2 を CCTP の文の前で分ける・つなぐと元の文 (空白を除く) に戻る', (_locale, messages) => {
    const text = faqA2(messages as typeof ja);
    const [head, tail] = splitBeforeSentence(text, 'CCTP');
    expect(head).not.toContain('CCTP');
    expect(head).toContain('Polygon');
    expect(tail.startsWith(head)).toBe(false);
    expect(tail).toContain('CCTP');
    expect(tail).toContain('Arc');
    expect((head + tail).replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('needle が無い・先頭の文にあるときは分けない', () => {
    expect(splitBeforeSentence('一。二。', 'X')).toEqual(['一。二。', '']);
    expect(splitBeforeSentence('X 一。二。', 'X')).toEqual(['X 一。二。', '']);
  });
});
