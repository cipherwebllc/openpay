'use client';

// お店の端末のガス用ウォレットの状態 (鍵の有無・POL 残高・ガス価格) と操作 (作る・消す・残りの POL を戻す)。
// 鍵は lib/storeGasWallet.ts が端末の localStorage にだけ置く。ここでは RPC (残高/ガス価格の読み取りと
// 署名済み tx の送信) にだけ通信し、鍵そのものはどこにも送らない。

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { transportForChain } from '@/lib/chains';
import {
  createStoreGasWallet,
  loadStoreGasWallet,
  removeStoreGasWallet,
  storeGasWalletChain,
  withdrawableAmount,
  type CreateStoreGasWalletResult,
  type StoredStoreGasWallet,
} from '@/lib/storeGasWallet';

export type WithdrawResult =
  | { ok: true; hash: Hex }
  | { ok: false; reason: 'no_wallet' | 'invalid_address' | 'same_address' | 'insufficient' | 'send_failed' };

export function useStoreGasWallet() {
  const chain = storeGasWalletChain();
  const publicClient = useMemo(
    () => createPublicClient({ chain, transport: transportForChain(chain.id) }),
    [chain],
  );
  const [wallet, setWallet] = useState<StoredStoreGasWallet | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // localStorage は描画後にだけ読む (server と初回 client の描画を揃える)。
  useEffect(() => {
    setWallet(loadStoreGasWallet());
    setHydrated(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try {
      const [b, g] = await Promise.all([
        publicClient.getBalance({ address: wallet.address }),
        publicClient.getGasPrice(),
      ]);
      setBalance(b);
      setGasPrice(g);
      setReadFailed(false);
    } catch {
      // RPC の一時的な失敗。残高を 0 と見せず「読めなかった」と出す (偽の残高を表示しない)。
      setReadFailed(true);
    }
  }, [publicClient, wallet]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback((): CreateStoreGasWalletResult => {
    const result = createStoreGasWallet();
    if (result.ok) {
      setWallet(result.wallet);
      setBalance(null);
    }
    return result;
  }, []);

  const remove = useCallback(() => {
    removeStoreGasWallet();
    setWallet(null);
    setBalance(null);
    setGasPrice(null);
  }, []);

  const withdraw = useCallback(
    async (rawTo: string): Promise<WithdrawResult> => {
      if (!wallet) return { ok: false, reason: 'no_wallet' };
      const trimmed = rawTo.trim();
      if (!isAddress(trimmed, { strict: false })) return { ok: false, reason: 'invalid_address' };
      const to: Address = getAddress(trimmed);
      if (to.toLowerCase() === wallet.address.toLowerCase()) {
        return { ok: false, reason: 'same_address' };
      }
      setBusy(true);
      try {
        const account = privateKeyToAccount(wallet.privateKey);
        const [current, gas, fees] = await Promise.all([
          publicClient.getBalance({ address: wallet.address }),
          publicClient.estimateGas({ account, to, value: 1n }),
          publicClient.estimateFeesPerGas(),
        ]);
        const value = withdrawableAmount(current, gas, fees.maxFeePerGas);
        if (value <= 0n) return { ok: false, reason: 'insufficient' };
        const walletClient = createWalletClient({
          account,
          chain,
          transport: transportForChain(chain.id),
        });
        const hash = await walletClient.sendTransaction({
          to,
          value,
          gas,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        return { ok: true, hash };
      } catch {
        return { ok: false, reason: 'send_failed' };
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [chain, publicClient, refresh, wallet],
  );

  return {
    chain,
    hydrated,
    wallet,
    balance,
    gasPrice,
    readFailed,
    busy,
    refresh,
    create,
    remove,
    withdraw,
  };
}
