// 文中の https URL の切り分け (lib/textLinks.ts)。2026-10-21: /guide/sell の Arc の注意で、文の途中の
// 「(https://…/arc-payout) で…」の後ろの文章までリンク先に入り 404 になった。
import { describe, expect, it } from 'vitest';
import { splitTextLinks } from '@/lib/textLinks';

describe('splitTextLinks', () => {
  it('文末の URL はそのままリンク', () => {
    expect(splitTextLinks('例: https://raw.githubusercontent.com/a/b/main/x.mjs')).toEqual([
      { kind: 'text', text: '例: ' },
      { kind: 'link', href: 'https://raw.githubusercontent.com/a/b/main/x.mjs' },
    ]);
  });

  it('かっこ内の URL は閉じかっこの手前で終わり、後ろの文章はリンクに入れない (ja)', () => {
    expect(splitTextLinks('「Arc の売上を受け取る」ページ (https://open-pay.jp/ja/discovery/arc-payout) で引き出します (署名 1 回)。')).toEqual([
      { kind: 'text', text: '「Arc の売上を受け取る」ページ (' },
      { kind: 'link', href: 'https://open-pay.jp/ja/discovery/arc-payout' },
      { kind: 'text', text: ') で引き出します (署名 1 回)。' },
    ]);
  });

  it('英文: かっこと末尾の句読点は含めない', () => {
    expect(splitTextLinks('page (https://open-pay.jp/en/discovery/arc-payout) and see https://example.com/x.')).toEqual([
      { kind: 'text', text: 'page (' },
      { kind: 'link', href: 'https://open-pay.jp/en/discovery/arc-payout' },
      { kind: 'text', text: ') and see ' },
      { kind: 'link', href: 'https://example.com/x' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('全角のかっこ・句読点の手前でも終わる', () => {
    expect(splitTextLinks('（https://open-pay.jp/ja/guide/sell）、次へ。')).toEqual([
      { kind: 'text', text: '（' },
      { kind: 'link', href: 'https://open-pay.jp/ja/guide/sell' },
      { kind: 'text', text: '）、次へ。' },
    ]);
  });

  it('URL が無ければ文章だけ', () => {
    expect(splitTextLinks('リンクなし')).toEqual([{ kind: 'text', text: 'リンクなし' }]);
  });
});
