import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Connector } from 'wagmi';
import { useVisibleConnectors } from '@/hooks/useVisibleConnectors';

// logger を境界 mock。connector.getProvider() の throw 経路 (injected 不在) で
// logger.debug が呼ばれることを assert する。
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
import { logger } from '@/lib/logger';

type ConnectorOpts = {
  uid: string;
  name: string;
  type?: 'injected' | 'walletConnect' | 'metaMask';
  /** injected の getProvider が返す値。undefined を返すと invisibles 扱い。 */
  provider?: unknown;
  /** getProvider が throw する場合の error。 */
  throws?: Error;
};

function makeConnector(opts: ConnectorOpts): Connector {
  return {
    uid: opts.uid,
    name: opts.name,
    type: opts.type ?? 'injected',
    getProvider: vi.fn(async () => {
      if (opts.throws) throw opts.throws;
      return opts.provider;
    }),
  } as unknown as Connector;
}

beforeEach(() => {
  vi.mocked(logger.debug).mockReset();
});

// 重要: useVisibleConnectors の useEffect は deps=[raw] なので、`raw` が
// レンダーごとに新参照になると probe が無限再実行され OOM する。本番では
// wagmi の `connectors` は安定参照なので問題無いが、テストでは必ず renderHook
// の外で配列リテラルを保持してから渡す。

describe('useVisibleConnectors: 基本動作', () => {
  it('空 connectors → 空配列', () => {
    const conns: Connector[] = [];
    const { result } = renderHook(() => useVisibleConnectors(conns));
    expect(result.current).toEqual([]);
  });

  it('injected で provider あり → そのまま返る', async () => {
    const conns = [makeConnector({ uid: '1', name: 'MetaMask', provider: {} })];
    const { result } = renderHook(() => useVisibleConnectors(conns));
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].name).toBe('MetaMask');
  });

  it('非 injected (walletConnect 等) は provider 検査せずそのまま返る', async () => {
    const wc = makeConnector({
      uid: '1',
      name: 'WalletConnect',
      type: 'walletConnect',
    });
    const conns = [wc];
    const { result } = renderHook(() => useVisibleConnectors(conns));
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].name).toBe('WalletConnect');
    // 非 injected は getProvider を呼ばない (false-positive 検知)
    expect(wc.getProvider as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe('useVisibleConnectors: フィルタリング', () => {
  it('injected で getProvider() が undefined → 除外される (provider 不在)', async () => {
    const conns = [
      makeConnector({ uid: '1', name: 'PhantomGhost', provider: undefined }),
    ];
    const { result } = renderHook(() => useVisibleConnectors(conns));
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current).toHaveLength(0);
  });

  it('injected で getProvider() が throw → 除外 + logger.debug 呼出', async () => {
    const err = new Error('extension blocked');
    const conns = [makeConnector({ uid: '1', name: 'Blocked', throws: err })];
    const { result } = renderHook(() => useVisibleConnectors(conns));
    await waitFor(() =>
      expect(logger.debug).toHaveBeenCalledWith(
        'connector.provider_unavailable',
        expect.objectContaining({ name: 'Blocked', err }),
      ),
    );
    expect(result.current).toHaveLength(0);
  });

  it('同名 connector dedup (EIP-6963 で同名が複数 enumerate されるケース)', async () => {
    const a = makeConnector({ uid: '1', name: 'MetaMask', provider: { id: 'a' } });
    const b = makeConnector({ uid: '2', name: 'MetaMask', provider: { id: 'b' } });
    const c = makeConnector({ uid: '3', name: 'Rabby', provider: { id: 'c' } });
    const conns = [a, b, c];
    const { result } = renderHook(() => useVisibleConnectors(conns));
    await waitFor(() => expect(result.current).toHaveLength(2));
    // 最初に出現した MetaMask が採用 (順序保持)
    expect(result.current[0].uid).toBe('1');
    expect(result.current[1].name).toBe('Rabby');
  });

  it('混在: invisible (provider 不在) + 同名 + 別 type をすべて正しく扱う', async () => {
    const conns = [
      makeConnector({ uid: '1', name: 'MetaMask', provider: {} }),
      makeConnector({ uid: '2', name: 'MetaMask', provider: {} }), // 同名 → drop
      makeConnector({ uid: '3', name: 'Phantom', provider: undefined }), // invisible
      makeConnector({ uid: '4', name: 'WalletConnect', type: 'walletConnect' }),
    ];
    const { result } = renderHook(() => useVisibleConnectors(conns));
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((x) => x.name)).toEqual(['MetaMask', 'WalletConnect']);
  });
});

describe('useVisibleConnectors: ライフサイクル / 非同期境界', () => {
  it('unmount 直後の getProvider 完了で setState されない (abort signal が効く)', async () => {
    let deferredResolve: (v: unknown) => void = () => {};
    const slowPromise = new Promise<unknown>((r) => {
      deferredResolve = r;
    });
    const slow = {
      uid: '1',
      name: 'SlowWallet',
      type: 'injected',
      getProvider: vi.fn(() => slowPromise),
    } as unknown as Connector;
    const conns = [slow];

    const { result, unmount } = renderHook(() => useVisibleConnectors(conns));
    expect(result.current).toHaveLength(0);
    unmount();
    deferredResolve({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    // unmount 後の setState 走らず result は変化なし
    expect(result.current).toHaveLength(0);
  });

  it('connectors 配列の参照が変わると再 probe される (rerender 経路)', async () => {
    const a = makeConnector({ uid: '1', name: 'A', provider: {} });
    const b = makeConnector({ uid: '2', name: 'B', provider: {} });
    const listA = [a];
    const listAB = [a, b];
    const { result, rerender } = renderHook(
      ({ list }: { list: readonly Connector[] }) => useVisibleConnectors(list),
      { initialProps: { list: listA } },
    );
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].name).toBe('A');

    rerender({ list: listAB });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('順序保持: 渡された順で returned される (sort なし)', async () => {
    const conns = [
      makeConnector({ uid: '1', name: 'Zeta', provider: {} }),
      makeConnector({ uid: '2', name: 'Alpha', provider: {} }),
      makeConnector({ uid: '3', name: 'Mu', provider: {} }),
    ];
    const { result } = renderHook(() => useVisibleConnectors(conns));
    await waitFor(() => expect(result.current).toHaveLength(3));
    expect(result.current.map((c) => c.name)).toEqual(['Zeta', 'Alpha', 'Mu']);
  });
});
