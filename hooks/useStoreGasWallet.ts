'use client';

// お店の端末のガス用ウォレットの状態 (保存状態・POL 残高・ガス価格) と操作 (作る・消す・残りの POL を戻す)。
// 鍵は lib/storeGasWallet.ts が端末の localStorage にだけ置き、ここでは state にも戻り値にも載せない
// (送る直前に readStoreGasWalletKey で読む)。通信は RPC (残高/ガス価格/コードの読み取りと署名済み tx の
// 送信) だけで、鍵そのものはどこにも送らない。作る・消す・送るは Web Locks で別タブと直列化する。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { transportForChain } from '@/lib/chains';
import {
  STORE_GAS_WITHDRAW_GAS,
  createStoreGasWallet,
  loadStoreGasWallet,
  readStoreGasWalletKey,
  removeStoreGasWallet,
  storeGasWalletChain,
  withStoreGasWalletLock,
  withdrawableAmount,
  type CreateStoreGasWalletResult,
  type StoreGasWalletState,
} from '@/lib/storeGasWallet';

export type WithdrawRejectReason =
  | 'no_wallet'
  | 'invalid_address'
  | 'zero_address'
  | 'same_address'
  | 'contract_recipient'
  | 'insufficient'
  | 'read_failed';

export type WithdrawStatus =
  | { phase: 'idle' }
  | { phase: 'sending' }
  // 送った (hash あり)・確定待ち
  | { phase: 'pending'; hash: Hex }
  | { phase: 'confirmed'; hash: Hex }
  | { phase: 'reverted'; hash: Hex }
  // 送ったかどうか・確定したかどうかが分からない (通信断・確定待ちの時間切れ)。失敗扱いにしない。
  | { phase: 'unknown'; hash?: Hex }
  | { phase: 'rejected'; reason: WithdrawRejectReason };

// 確定待ちの上限 (Polygon は通常数秒)。超えたら「確認中」として残高の更新を促す。
const RECEIPT_TIMEOUT_MS = 90_000;

export function useStoreGasWallet() {
  const chain = storeGasWalletChain();
  const publicClient = useMemo(
    () => createPublicClient({ chain, transport: transportForChain(chain.id) }),
    [chain],
  );
  const [walletState, setWalletState] = useState<StoreGasWalletState | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [withdrawStatus, setWithdrawStatus] = useState<WithdrawStatus>({ phase: 'idle' });
  // タブ内の多重押しを止める (state の反映前に 2 回目が走らないよう ref で持つ)。
  const inFlight = useRef(false);
  // 「不明」の状態を refresh から読むための写し (refresh の依存を増やさない)。
  const unknownRef = useRef<{ hash?: Hex } | null>(null);

  // localStorage は描画後にだけ読む (server と初回 client の描画を揃える)。
  useEffect(() => {
    setWalletState(loadStoreGasWallet());
  }, []);

  const address = walletState?.state === 'ok' ? walletState.info.address : null;

  useEffect(() => {
    unknownRef.current =
      withdrawStatus.phase === 'unknown' ? { hash: withdrawStatus.hash } : null;
  }, [withdrawStatus]);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const [b, g] = await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.getGasPrice(),
      ]);
      setBalance(b);
      setGasPrice(g);
      setReadFailed(false);
    } catch {
      // RPC の一時的な失敗。残高を 0 と見せず「読めなかった」と出す (偽の残高を表示しない)。
      setReadFailed(true);
      return;
    }
    // 「不明」の出口: hash があれば receipt で確定/取り消しを確かめる。hash が無い (送信中に切れた) ときは
    // 残高を読めた時点で解除する (残高が残っていれば「消す」の確認で先に戻すよう出る)。
    if (unknownRef.current) {
      const pendingHash = unknownRef.current.hash;
      if (!pendingHash) {
        unknownRef.current = null;
        setWithdrawStatus({ phase: 'idle' });
        return;
      }
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: pendingHash });
        unknownRef.current = null;
        setWithdrawStatus(
          receipt.status === 'success'
            ? { phase: 'confirmed', hash: pendingHash }
            : { phase: 'reverted', hash: pendingHash },
        );
      } catch {
        // まだ見つからない。不明のまま (消せないまま) にする。
      }
    }
  }, [publicClient, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (): Promise<CreateStoreGasWalletResult> => {
    const result = await withStoreGasWalletLock(async () => createStoreGasWallet());
    setWalletState(loadStoreGasWallet());
    setBalance(null);
    return result;
  }, []);

  // 送金が確定していない間 (送信中・確定待ち・不明) は消せない (POL が残ったまま鍵を失わないため)。
  const removeBlocked =
    withdrawStatus.phase === 'sending' ||
    withdrawStatus.phase === 'pending' ||
    withdrawStatus.phase === 'unknown';

  const remove = useCallback(async (): Promise<boolean> => {
    if (removeBlocked) return false;
    const removed = await withStoreGasWalletLock(async () => removeStoreGasWallet());
    // 消えたかどうかは保存状態を読み直して決める (消せなかったのに「未作成」に戻さない)。
    setWalletState(loadStoreGasWallet());
    if (removed) {
      setBalance(null);
      setGasPrice(null);
      setWithdrawStatus({ phase: 'idle' });
    }
    return removed;
  }, [removeBlocked]);

  const withdraw = useCallback(
    async (rawTo: string): Promise<WithdrawStatus> => {
      // 送信中・確定待ち・不明の間は何もしない (状態を上書きすると「消せない」が外れ、届いたか分からない
      // 送金の鍵を消せてしまう)。
      if (
        inFlight.current ||
        withdrawStatus.phase === 'sending' ||
        withdrawStatus.phase === 'pending' ||
        withdrawStatus.phase === 'unknown'
      ) {
        return withdrawStatus;
      }
      const reject = (reason: WithdrawRejectReason): WithdrawStatus => {
        const s: WithdrawStatus = { phase: 'rejected', reason };
        setWithdrawStatus(s);
        return s;
      };
      if (!address) return reject('no_wallet');
      const trimmed = rawTo.trim();
      // 大文字小文字が混ざるときは checksum を検証する (打ち間違いの宛先に送らない)。
      if (!isAddress(trimmed)) return reject('invalid_address');
      const to: Address = getAddress(trimmed);
      if (to === zeroAddress) return reject('zero_address');
      if (to.toLowerCase() === address.toLowerCase()) return reject('same_address');
      inFlight.current = true;
      setWithdrawStatus({ phase: 'sending' });
      try {
        // ロックは「鍵を読む → 署名 → 送る」までに限る (確定待ちの間に別タブの操作を止めない)。
        const sent = await withStoreGasWalletLock(
          async (): Promise<{ hash: Hex } | WithdrawStatus> => {
            // 別タブで作り直された等で鍵が変わっていたら送らない。
            const key = readStoreGasWalletKey(address);
            if (!key) return reject('no_wallet');
            let value: bigint;
            let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
            try {
              const [code, current, estimated] = await Promise.all([
                publicClient.getCode({ address: to }),
                publicClient.getBalance({ address }),
                publicClient.estimateFeesPerGas(),
              ]);
              // 戻し先はウォレット (EOA) に限る (コントラクトは受け取りの処理でガスが 21,000 を超えうる)。
              if (code && code !== '0x') return reject('contract_recipient');
              fees = estimated;
              value = withdrawableAmount(current, STORE_GAS_WITHDRAW_GAS, fees.maxFeePerGas);
            } catch {
              return reject('read_failed');
            }
            if (value <= 0n) return reject('insufficient');
            try {
              const walletClient = createWalletClient({
                account: privateKeyToAccount(key),
                chain,
                transport: transportForChain(chain.id),
              });
              const hash = await walletClient.sendTransaction({
                to,
                value,
                gas: STORE_GAS_WITHDRAW_GAS,
                maxFeePerGas: fees.maxFeePerGas,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
              });
              return { hash };
            } catch {
              // 送信の途中で切れた等。届いたかどうか分からないので失敗とは言わない。
              const s: WithdrawStatus = { phase: 'unknown' };
              setWithdrawStatus(s);
              return s;
            }
          },
        );
        if ('phase' in sent) return sent;
        const { hash } = sent;
        setWithdrawStatus({ phase: 'pending', hash });
        let final: WithdrawStatus;
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            timeout: RECEIPT_TIMEOUT_MS,
          });
          final =
            receipt.status === 'success'
              ? { phase: 'confirmed', hash }
              : { phase: 'reverted', hash };
        } catch {
          final = { phase: 'unknown', hash };
        }
        setWithdrawStatus(final);
        return final;
      } finally {
        inFlight.current = false;
        void refresh();
      }
    },
    [address, chain, publicClient, refresh, withdrawStatus],
  );

  return {
    chain,
    hydrated: walletState !== null,
    walletState,
    address,
    balance,
    gasPrice,
    readFailed,
    withdrawStatus,
    removeBlocked,
    refresh,
    create,
    remove,
    withdraw,
  };
}
