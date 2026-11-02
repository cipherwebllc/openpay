// 注文リンクのガスレスの上限を、サーバーの relay の既定の上限と揃える。
// サーバーの値は client へ出せないので、片方だけ変えたら気づけるよう照合する。
// MAX_VALUE は読み込み時に環境変数を読むので、未設定の状態で読み込み直す (環境の値に左右されない)。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORDER_LINK_GASLESS_MAX_JPYC } from '@/lib/orderLink';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('ORDER_LINK_GASLESS_MAX_JPYC', () => {
  it('relay の既定の上限と同じ', async () => {
    vi.stubEnv('RELAY_MAX_JPYC', '');
    vi.stubEnv('GELATO_RELAY_MAX_JPYC', '');
    vi.resetModules();
    const { MAX_VALUE } = await import('@/lib/relay/relayProvider');
    expect(ORDER_LINK_GASLESS_MAX_JPYC * 10n ** 18n).toBe(MAX_VALUE);
  });
});
