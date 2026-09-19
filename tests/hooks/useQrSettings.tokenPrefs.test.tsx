// token 別の (受取チェーン, 決済モード) の記憶。レジは商品プリセットを押すだけで token が暗黙に切り替わる
// (チェーン選択 UI が無い) ので、これが壊れると「USDC を Arc で受けたい店が JPYC 商品を 1 度打っただけで
// Base に戻る」「JPYC がガスレスを失う」という、店主が気づけない設定の巻き戻りになる。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// gasless 非対応の組合せを 1 つ作る (テスト環境では Arc flag が OFF で全組合せが gasless 対応のため)。
// usdc@optimism だけ standard 専用とみなす。
vi.mock('@/lib/tokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tokens')>();
  // chainId は環境 (mainnet / testnet) で変わるので slug から引く。
  const standardOnly = actual.deploymentForSlug('usdc', 'optimism').chainId;
  return {
    ...actual,
    isGaslessSupported: (d: { symbol: string; chainId: number }) =>
      !(d.symbol === 'usdc' && d.chainId === standardOnly),
  };
});

import {
  rememberTokenPrefs,
  switchTokenKeepingPrefs,
  useQrSettings,
  type QrSettings,
} from '@/hooks/useQrSettings';

const KEY = 'openpay:qr-settings:v2';

async function loaded(seed: Record<string, unknown>): Promise<QrSettings> {
  window.localStorage.setItem(KEY, JSON.stringify(seed));
  const { result } = renderHook(() => useQrSettings());
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  return result.current.settings;
}

describe('tokenPrefs (token 別の chain / payMode の記憶)', () => {
  beforeEach(() => window.localStorage.clear());

  it('旧 schema (tokenPrefs 無し) は空 = 従来動作', async () => {
    const s = await loaded({ token: 'jpyc', chain: 'polygon' });
    expect(s.tokenPrefs).toEqual({});
  });

  it('USDC の非既定チェーンは JPYC を経由しても戻ってくる', async () => {
    const usdc = await loaded({ token: 'usdc', chain: 'arbitrum', payMode: 'standard' });
    const jpyc = switchTokenKeepingPrefs(usdc, 'jpyc');
    // 記憶が無い JPYC は従来どおり既定チェーン + 現在の payMode。
    expect(jpyc).toMatchObject({ token: 'jpyc', chain: 'polygon', payMode: 'standard' });
    expect(jpyc.tokenPrefs.usdc).toEqual({ chain: 'arbitrum', payMode: 'standard' });
    const back = switchTokenKeepingPrefs(jpyc, 'usdc');
    expect(back).toMatchObject({ token: 'usdc', chain: 'arbitrum', payMode: 'standard' });
  });

  it('JPYC のガスレスと非既定チェーンは USDC (standard) を経由しても失われない', async () => {
    const jpyc = await loaded({ token: 'jpyc', chain: 'kaia', payMode: 'gasless' });
    const usdc = { ...switchTokenKeepingPrefs(jpyc, 'usdc'), chain: 'arbitrum' as const, payMode: 'standard' as const };
    const back = switchTokenKeepingPrefs(usdc, 'jpyc');
    expect(back).toMatchObject({ token: 'jpyc', chain: 'kaia', payMode: 'gasless' });
    // 離れた USDC 側の選択も記憶されている。
    expect(back.tokenPrefs.usdc).toEqual({ chain: 'arbitrum', payMode: 'standard' });
  });

  it('同じ token への切替は何も変えない (同一参照)', async () => {
    const s = await loaded({ token: 'usdc', chain: 'arbitrum' });
    expect(switchTokenKeepingPrefs(s, 'usdc')).toBe(s);
  });

  it('gasless 非対応の組合せへ戻るときは standard に倒す (URL parser に拒否される QR を出さない)', async () => {
    // 記憶が gasless のまま残っていても (旧データ・対応状況の変化)、復元時に standard へ。
    const jpyc = await loaded({
      token: 'jpyc',
      chain: 'polygon',
      payMode: 'gasless',
      tokenPrefs: { usdc: { chain: 'optimism', payMode: 'gasless' } },
    });
    // sanitize の時点で倒れている。
    expect(jpyc.tokenPrefs.usdc).toEqual({ chain: 'optimism', payMode: 'standard' });
    expect(switchTokenKeepingPrefs(jpyc, 'usdc')).toMatchObject({ chain: 'optimism', payMode: 'standard' });
    // 記憶が無く現在の payMode (gasless) を引き継ぐ経路でも同じ。
    const noMemory = { ...jpyc, tokenPrefs: {} };
    const viaDefault = switchTokenKeepingPrefs(noMemory, 'usdc');
    expect(viaDefault).toMatchObject({ chain: 'base', payMode: 'gasless' }); // base は対応 → そのまま
  });

  it('token に対して無効なチェーン・不正な payMode の記憶は既定へ丸めず捨てる', async () => {
    const s = await loaded({
      token: 'jpyc',
      chain: 'polygon',
      tokenPrefs: {
        usdc: { chain: 'kaia', payMode: 'standard' }, // Kaia に native USDC は無い
        jpyc: { chain: 'base', payMode: 'gasless' }, // JPYC は Base に無い
        btc: { chain: 'base', payMode: 'gasless' },
      },
    });
    expect(s.tokenPrefs).toEqual({});
    const t = await loaded({ token: 'jpyc', chain: 'polygon', tokenPrefs: { usdc: { chain: 'arbitrum', payMode: 'direct' } } });
    expect(t.tokenPrefs).toEqual({});
    const u = await loaded({ token: 'jpyc', chain: 'polygon', tokenPrefs: 'junk' });
    expect(u.tokenPrefs).toEqual({});
  });

  it('rememberTokenPrefs は現在の token だけを書き足す', async () => {
    const s = await loaded({
      token: 'usdc',
      chain: 'arbitrum',
      payMode: 'standard',
      tokenPrefs: { jpyc: { chain: 'kaia', payMode: 'gasless' } },
    });
    expect(rememberTokenPrefs(s)).toEqual({
      jpyc: { chain: 'kaia', payMode: 'gasless' },
      usdc: { chain: 'arbitrum', payMode: 'standard' },
    });
  });
});
