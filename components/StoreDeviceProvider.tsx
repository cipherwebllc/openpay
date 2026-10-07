'use client';

// 「お店の端末で送る」(店員向けの名前は「お店がガス代を肩代わりして送る」・呼び名の対応は lib/storeDevicePayment.ts 冒頭) の
// 状態を、作成ページの両タブ (レジ・決済QR) の外に 1 つだけ持つ (plans/store-gas-wallet.md §19)。
//
// 作成ページはタブを切り替えると各タブの部品を外す (unmount)。状態を部品の中に持つと、署名を受け取って送っている最中に
// タブを切り替えて戻ったとき、送信は裏で続いているのに新しい部品は「何もしていない」状態で始まり、同じ会計の QR を
// もう一度出せてしまう (二重払いの種)。ここに置けば、送信・結果の表示・「次の QR を出せない間」はタブをまたいで続く。
//
// Provider の外 (部品の単体テスト・単独の描画) では、useStoreDeviceMode を呼んだ部品が自分の状態で動く (今までと同じ)。
// Provider の中では、部品側の状態は使わない (通信も effect も起こさない)。

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { storeDeviceChainId } from '@/lib/storeDevicePayment';
import { resolveDeployment, type TokenDeployment } from '@/lib/tokens';
import { useStoreDeviceRegister, useStoreDeviceToggle } from '@/hooks/useStoreDeviceRegister';

export type StoreDeviceMode = {
  /** 「お店がガス代を肩代わりして送る」を選んでいるか (端末ごと)。 */
  on: boolean;
  setOn: (on: boolean) => void;
  /** ガス用ウォレットのアドレス (パネルが知らせる・undefined = まだ分からない / null = 無い)。 */
  gasAddress: Address | null | undefined;
  setGasAddress: (address: Address | null) => void;
  chainId: number;
  deployment: TokenDeployment | undefined;
  forwarder: Address | null;
  feeReceiver: Address | null;
  /** この端末・設定で使えない理由。 */
  blocked: 'no_locks' | 'config' | null;
  /** 選んでいて、この端末・設定で使える (会計ごとの条件は呼び出し側で見る)。 */
  enabled: boolean;
  device: ReturnType<typeof useStoreDeviceRegister>;
};

const StoreDeviceContext = createContext<StoreDeviceMode | null>(null);

function useStoreDeviceModeState(active: boolean): StoreDeviceMode {
  const [on, setOn] = useStoreDeviceToggle(active && env.enableStoreGasWallet);
  const [gasAddress, setGasAddress] = useState<Address | null | undefined>(undefined);
  const [hasWebLocks, setHasWebLocks] = useState(false);
  useEffect(() => {
    // 使わない実体 (Provider の中で部品側が呼んだもの)・flag OFF は状態を変えない (余計な描画をしない)。
    if (!active || !env.enableStoreGasWallet) return;
    setHasWebLocks(typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function');
  }, [active]);
  // ガス用ウォレットのアドレスは自分でも読む (レジのパネルを開いていないタブで再読み込みしても、前のタブの
  // 受け渡しの締め切りと送った支払いの結果の確認を始める = 送っている途中の支払いを隠さない)。パネルが先に
  // 知らせていればそちらを使う (作った・消した直後の値)。鍵は読まない。
  useEffect(() => {
    if (!active || !env.enableStoreGasWallet) return;
    let cancelled = false;
    void import('@/lib/storeGasWallet').then(({ loadStoreGasWallet }) => {
      if (cancelled) return;
      const w = loadStoreGasWallet();
      const address = w.state === 'ok' ? w.info.address : null;
      setGasAddress((prev) => (prev === undefined ? address : prev));
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  const chainId = storeDeviceChainId();
  const deployment = resolveDeployment('jpyc', chainId);
  const forwarder = env.enableStoreGasWallet ? jpycForwarderFor(chainId) : null;
  const feeReceiver =
    env.enableStoreGasWallet && isAddress(env.feeReceiver) ? getAddress(env.feeReceiver) : null;
  const blocked: 'no_locks' | 'config' | null = !hasWebLocks
    ? 'no_locks'
    : !forwarder || !feeReceiver || !deployment
      ? 'config'
      : null;
  const enabled =
    active && env.enableStoreGasWallet && on && blocked === null && !!gasAddress && !!deployment;
  // 送った支払いの結果の確認は、送る設定 (on)・ガス用ウォレット・Web Locks と関係なく続ける (行方を隠さない)。
  const monitor = active && env.enableStoreGasWallet && !!forwarder && !!feeReceiver && !!deployment;
  const device = useStoreDeviceRegister({
    enabled,
    monitor,
    chainId,
    token: deployment?.address ?? ('0x0000000000000000000000000000000000000000' as Address),
    forwarder,
    feeReceiver,
    gasAddress: gasAddress ?? null,
  });
  return {
    on,
    setOn,
    gasAddress,
    setGasAddress,
    chainId,
    deployment,
    forwarder,
    feeReceiver,
    blocked,
    enabled,
    device,
  };
}

export function StoreDeviceProvider({ children }: { children: ReactNode }) {
  const value = useStoreDeviceModeState(true);
  return <StoreDeviceContext.Provider value={value}>{children}</StoreDeviceContext.Provider>;
}

/** 作成ページでは Provider の状態 (両タブで 1 つ)。Provider の外では呼び出した部品の状態。 */
export function useStoreDeviceMode(): StoreDeviceMode {
  const shared = useContext(StoreDeviceContext);
  // Provider の有無は描画の間で変わらない (hook の呼び出し順は一定)。Provider の中では active=false で何もしない。
  const local = useStoreDeviceModeState(shared === null);
  return shared ?? local;
}
