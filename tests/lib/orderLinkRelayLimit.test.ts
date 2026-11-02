// 注文リンクのガスレスの上限を、サーバーの relay の既定の上限と揃える。
// サーバーの値は client へ出せないので、片方だけ変えたら気づけるよう照合する。

import { describe, expect, it } from 'vitest';
import { ORDER_LINK_GASLESS_MAX_JPYC } from '@/lib/orderLink';
import { MAX_VALUE } from '@/lib/relay/relayProvider';

describe('ORDER_LINK_GASLESS_MAX_JPYC', () => {
  it('relay の既定の上限と同じ', () => {
    expect(ORDER_LINK_GASLESS_MAX_JPYC * 10n ** 18n).toBe(MAX_VALUE);
  });
});
