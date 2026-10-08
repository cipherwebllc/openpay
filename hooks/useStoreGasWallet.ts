'use client';

// お店の端末のガス用ウォレットの状態 (保存状態・チェーンごとの残高・ガス価格) と操作 (作る・消す・残りを戻す)。
// 鍵 (アドレス) は 1 つで、対象のチェーン (lib/storeDevicePayment.ts の storeDeviceChainIds) すべてで使う。
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
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { storeDeviceChainIds, storeGasWalletChainIds } from '@/lib/storeDevicePayment';
import {
  STORE_GAS_WITHDRAW_GAS,
  createStoreGasWallet,
  loadStoreGasWallet,
  readStoreGasWalletKey,
  removeStoreGasWallet,
  requestStoreGasWalletPersistence,
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
  | { phase: 'sending'; chainId: number }
  // 送った (hash あり)・確定待ち
  | { phase: 'pending'; chainId: number; hash: Hex }
  | { phase: 'confirmed'; chainId: number; hash: Hex }
  | { phase: 'reverted'; chainId: number; hash: Hex }
  // 送ったかどうか・確定したかどうかが分からない (通信断・確定待ちの時間切れ)。失敗扱いにしない。
  | { phase: 'unknown'; chainId: number; hash?: Hex }
  | { phase: 'rejected'; reason: WithdrawRejectReason };

/**
 * チェーンごとの残高・ガス価格 (まだ読んでいなければ null・読めなかったときは readFailed で、前に読めた値は残す)。
 * active = 新しい会計に使えるチェーン (使えないチェーンも、残高があれば見せて戻せるようにする)。
 */
export type StoreGasChainState = {
  chainId: number;
  chain: Chain;
  active: boolean;
  balance: bigint | null;
  gasPrice: bigint | null;
  readFailed: boolean;
};

// 確定待ちの上限 (Polygon・Kaia・Avalanche とも通常数秒)。超えたら「確認中」として残高の更新を促す。
const RECEIPT_TIMEOUT_MS = 90_000;

export function useStoreGasWallet() {
  // 残高を読むチェーン (env から決まる・描画の間で変わらない)。新しい会計に使えるかは active で分ける。
  const chains = useMemo(() => {
    const active = storeDeviceChainIds();
    return storeGasWalletChainIds().flatMap((id) => {
      const chain = chainObjectForId(id);
      return chain ? [{ chainId: id, chain, active: active.includes(id) }] : [];
    });
  }, []);
  const clients = useMemo(
    () =>
      new Map(
        chains.map(({ chainId, chain }) => [
          chainId,
          createPublicClient({ chain, transport: transportForChain(chainId) }),
        ]),
      ),
    [chains],
  );
  const [walletState, setWalletState] = useState<StoreGasWalletState | null>(null);
  const [reads, setReads] = useState<
    Record<number, { balance: bigint | null; gasPrice: bigint | null; readFailed: boolean }>
  >({});
  const [withdrawStatus, setWithdrawStatus] = useState<WithdrawStatus>({ phase: 'idle' });
  // タブ内の多重押しを止める (state の反映前に 2 回目が走らないよう ref で持つ)。
  const inFlight = useRef(false);
  // 「不明」の状態を refresh から読むための写し (refresh の依存を増やさない)。
  const unknownRef = useRef<{ chainId: number; hash?: Hex } | null>(null);
  // 鍵の世代 (作る・消すで進める)。古い鍵の読み取りが遅れて返っても、新しい鍵の残高に書かない。
  const walletGenRef = useRef(0);

  // localStorage は描画後にだけ読む (server と初回 client の描画を揃える)。
  useEffect(() => {
    setWalletState(loadStoreGasWallet());
  }, []);

  const address = walletState?.state === 'ok' ? walletState.info.address : null;

  // 鍵があるときは、ブラウザに消されにくい保存を頼む (作った直後・開いたとき)。結果は画面の案内に使うだけ。
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    void requestStoreGasWalletPersistence().then((r) => {
      if (live) setPersisted(r);
    });
    return () => {
      live = false;
    };
  }, [address]);

  useEffect(() => {
    unknownRef.current =
      withdrawStatus.phase === 'unknown'
        ? { chainId: withdrawStatus.chainId, hash: withdrawStatus.hash }
        : null;
  }, [withdrawStatus]);

  const refresh = useCallback(async () => {
    if (!address) return;
    const gen = walletGenRef.current;
    // チェーンごとに読み、読めたチェーンから出す (1 つのチェーンの RPC 障害・遅延で他のチェーンの残高を隠さない)。
    const results = await Promise.all(
      chains.map(async ({ chainId }) => {
        const client = clients.get(chainId)!;
        let ok: { balance: bigint; gasPrice: bigint } | null = null;
        try {
          const [b, g] = await Promise.all([client.getBalance({ address }), client.getGasPrice()]);
          ok = { balance: b, gasPrice: g };
        } catch {
          // RPC の一時的な失敗。残高を 0 と見せず「読めなかった」と出し、前に読めた値は残す (消す前の
          // 「先に戻して」の注意を失わない)。
        }
        if (gen === walletGenRef.current) {
          setReads((prev) => ({
            ...prev,
            [chainId]: ok
              ? { ...ok, readFailed: false }
              : { balance: prev[chainId]?.balance ?? null, gasPrice: prev[chainId]?.gasPrice ?? null, readFailed: true },
          }));
        }
        return [chainId, { readFailed: ok === null }] as const;
      }),
    );
    if (gen !== walletGenRef.current) return;
    // 「不明」の出口: hash があれば receipt で確定/取り消しを確かめる。hash が無い (送信中に切れた) ときは
    // そのチェーンの残高を読めた時点で解除する (残高が残っていれば「消す」の確認で先に戻すよう出る)。
    const unknown = unknownRef.current;
    if (unknown) {
      const read = results.find(([id]) => id === unknown.chainId)?.[1];
      if (!read || read.readFailed) return;
      if (!unknown.hash) {
        unknownRef.current = null;
        setWithdrawStatus({ phase: 'idle' });
        return;
      }
      const client = clients.get(unknown.chainId);
      if (!client) return;
      try {
        const receipt = await client.getTransactionReceipt({ hash: unknown.hash });
        unknownRef.current = null;
        setWithdrawStatus(
          receipt.status === 'success'
            ? { phase: 'confirmed', chainId: unknown.chainId, hash: unknown.hash }
            : { phase: 'reverted', chainId: unknown.chainId, hash: unknown.hash },
        );
      } catch {
        // まだ見つからない。不明のまま (消せないまま) にする。
      }
    }
  }, [chains, clients, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (): Promise<CreateStoreGasWalletResult> => {
    const result = await withStoreGasWalletLock(async () => createStoreGasWallet());
    walletGenRef.current += 1;
    setWalletState(loadStoreGasWallet());
    setReads({});
    return result;
  }, []);

  // 送金が確定していない間 (送信中・確定待ち・不明) は消せない (ガス代のトークンが残ったまま鍵を失わないため)。
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
      walletGenRef.current += 1;
      setReads({});
      setWithdrawStatus({ phase: 'idle' });
    }
    return removed;
  }, [removeBlocked]);

  const withdraw = useCallback(
    async (chainId: number, rawTo: string): Promise<WithdrawStatus> => {
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
      const target = chains.find((c) => c.chainId === chainId);
      const publicClient = clients.get(chainId);
      if (!target || !publicClient) return reject('read_failed');
      const { chain } = target;
      const trimmed = rawTo.trim();
      // 大文字小文字が混ざるときは checksum を検証する (打ち間違いの宛先に送らない)。
      if (!isAddress(trimmed)) return reject('invalid_address');
      const to: Address = getAddress(trimmed);
      if (to === zeroAddress) return reject('zero_address');
      if (to.toLowerCase() === address.toLowerCase()) return reject('same_address');
      inFlight.current = true;
      setWithdrawStatus({ phase: 'sending', chainId });
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
              const s: WithdrawStatus = { phase: 'unknown', chainId };
              setWithdrawStatus(s);
              return s;
            }
          },
        );
        if ('phase' in sent) return sent;
        const { hash } = sent;
        setWithdrawStatus({ phase: 'pending', chainId, hash });
        let final: WithdrawStatus;
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            timeout: RECEIPT_TIMEOUT_MS,
          });
          final =
            receipt.status === 'success'
              ? { phase: 'confirmed', chainId, hash }
              : { phase: 'reverted', chainId, hash };
        } catch {
          final = { phase: 'unknown', chainId, hash };
        }
        setWithdrawStatus(final);
        return final;
      } finally {
        inFlight.current = false;
        void refresh();
      }
    },
    [address, chains, clients, refresh, withdrawStatus],
  );

  const chainStates: StoreGasChainState[] = chains.map(({ chainId, chain, active }) => ({
    chainId,
    chain,
    active,
    balance: reads[chainId]?.balance ?? null,
    gasPrice: reads[chainId]?.gasPrice ?? null,
    readFailed: reads[chainId]?.readFailed ?? false,
  }));

  return {
    chains: chainStates,
    hydrated: walletState !== null,
    walletState,
    address,
    persisted,
    withdrawStatus,
    removeBlocked,
    refresh,
    create,
    remove,
    withdraw,
  };
}
