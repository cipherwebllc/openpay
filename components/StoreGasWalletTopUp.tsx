'use client';

// 「接続中のウォレットから補充」: 右上で接続したお店のウォレットから、この端末のガス用ウォレットへガス代のトークン
// (POL・KAIA・AVAX) を送る。送るのはお店のウォレット (wagmi) で、ガス用ウォレットの鍵は使わない。
// 1 回で送れるのは入れておく目安の上限まで (開示どおり「少額だけ入れる」・もっと入れたいときは繰り返す)。
//
// 二重に送らない・届く途中の宛先を消さないための決まり (操作の記録は lib/storeGasTopUp.ts・タブをまたいで共有):
//   - 押した瞬間に (描画を待たず) 二度押しを止める。鍵のロックの中で、保存されている鍵が表示中の宛先と同じかを確かめ、
//     補充の記録を置く (別のタブで作り直された古いアドレスへ送らない・同じ宛先への補充を重ねない)。
//   - 記録がある間 (ウォレットで確認中・結果待ち) は次の送信・額・チェーンを変えさせず、鍵も消させない。画面を離れて
//     戻っても記録から続きを見る。確認中は 1 分ごとに記録を延ばす (画面を離れても、確認が終わるまで)。
//   - 結果は receipt で決める。確認が失敗しても途中のまま (tx へのリンクと「結果を確かめ直す」)。取引が失敗
//     (revert) しても結果として扱う。ウォレットで取り消し・ガス用ウォレット以外への置き換えなら「補充しました」と
//     言わない。
//   - 送った tx は hash が返った瞬間に記録へ残し、送り手と nonce は同じ tx から読んだ組を後から足す (画面を離れた後も
//     receipt で結果を確かめ、nonce の消費で置き換えの可能性を見る = 時間の経過で「入らなかった」と決めない・
//     hooks/useStoreGasWallet.ts)。送信の失敗は、ウォレットで断ったときだけ記録を片付け、それ以外 (送った後に応答を
//     失った可能性) は「送れたか分からない」として記録を残す (30 分で切れる)。
//   - 別のタブとの排他 (Web Locks) が無いブラウザでは補充を始めない (記録の読み書きの交差を止められない)。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { parseEther, type Address, type Hex } from 'viem';
import {
  useAccount,
  useBalance,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { nativeSymbolForChainId, txExplorerUrl } from '@/lib/chains';
import {
  hasStoreGasWalletLock,
  loadStoreGasWallet,
  storeGasFundRange,
  withStoreGasWalletLock,
} from '@/lib/storeGasWallet';
import {
  STORE_GAS_TOPUP_KEY,
  TOPUP_HEARTBEAT_MS,
  attachStoreGasTopUpHash,
  finishStoreGasTopUp,
  liveStoreGasTopUps,
  noteStoreGasTopUpSender,
  readStoreGasTopUpSender,
  reserveStoreGasTopUp,
  touchStoreGasTopUp,
  type StoreGasTopUpRecord,
} from '@/lib/storeGasTopUp';
import { isUserRejection } from '@/lib/walletErrors';
import type { StoreGasChainState } from '@/hooks/useStoreGasWallet';
import { NativeTokenLogo } from './AssetLogo';

const BTN =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand hover:text-brand-dark disabled:cursor-not-allowed disabled:opacity-50';

const AMOUNT_ID = 'store-gas-topup-amount';
const CHAIN_ID = 'store-gas-topup-chain';
// 10 進の数 (18 桁まで)。
const DECIMAL = /^\d+(\.\d{1,18})?$/;
// 記録の読み直し (別のタブの変化は storage イベントでも届く・途中の間だけ)。
const RELOAD_MS = 3_000;

type AmountCheck = { ok: true; wei: bigint } | { ok: false; reason: 'invalid' | 'too_much' };

function checkAmount(raw: string, max: string): AmountCheck {
  const v = raw.trim();
  if (!DECIMAL.test(v)) return { ok: false, reason: 'invalid' };
  const wei = parseEther(v);
  if (wei <= 0n) return { ok: false, reason: 'invalid' };
  if (wei > parseEther(max)) return { ok: false, reason: 'too_much' };
  return { ok: true, wei };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Result = { chainId: number; hash: Hex; result: 'success' | 'reverted' | 'cancelled' | 'replaced' };
// unknown = 送れたかどうか分からない (ウォレットで断った以外の失敗・記録は残る)。
type LocalError = 'wallet_changed' | 'storage' | 'busy' | 'unknown';
// 置き換えは操作 (記録の id) ごとに持つ (前の操作の置き換えを次の操作に持ち越さない)。
type Replacement = { id: string; reason: 'cancelled' | 'replaced' | 'repriced'; to: Address | null; value: bigint };
type Watched = StoreGasTopUpRecord & { hash: Hex };

export function StoreGasWalletTopUp({
  chains,
  gasAddress,
  onDone,
  onPendingChange,
}: {
  /** 新しい会計に使えるチェーン (補充先の候補)。 */
  chains: readonly StoreGasChainState[];
  gasAddress: Address;
  /** 補充の結果が出たら呼ぶ (残高の読み直し)。 */
  onDone: () => void;
  /** 補充が途中 (ウォレットで確認中・結果待ち) かを知らせる (途中は鍵を消させない)。 */
  onPendingChange?: (pending: boolean) => void;
}) {
  const t = useTranslations('RegisterMode.storeGasWallet');
  const [chainId, setChainId] = useState<number | null>(null);
  const target = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const range = target ? storeGasFundRange(target.chainId) : null;
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inFlightRef = useRef(false);
  const ownIdRef = useRef<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [localError, setLocalError] = useState<LocalError | null>(null);
  const replacedRef = useRef<Replacement | null>(null);
  const finishedRef = useRef(new Set<string>());

  // この宛先への途中の補充 (このタブ・別のタブ・画面を離れる前)。記録から続きを見る。
  const [op, setOp] = useState<StoreGasTopUpRecord | null>(null);
  // 送った tx を記録に残せなかった (端末の保存容量など) ときは、この画面で見張る (tx を見失わない)。
  const [localSent, setLocalSent] = useState<Watched | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 画面が生きているか。閉じた後に heartbeat を張らない (閉じた画面が確認中の記録を延ばし続けると、補充と鍵の削除が
  // 止まったままになる)。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    };
  }, []);
  const reload = useCallback(() => {
    const next = liveStoreGasTopUps(gasAddress)[0] ?? null;
    // 同じ記録なら同じオブジェクトのまま (読み直しのたびに描画や interval を作り直さない)。
    setOp((prev) =>
      prev && next && prev.id === next.id && prev.hash === next.hash && prev.at === next.at ? prev : next,
    );
  }, [gasAddress]);
  useEffect(() => {
    reload();
    function onStorage(e: StorageEvent) {
      if (e.key === STORE_GAS_TOPUP_KEY || e.key === null) reload();
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [reload]);
  useEffect(() => {
    if (!op) return;
    const timer = setInterval(reload, RELOAD_MS);
    return () => clearInterval(timer);
  }, [op, reload]);

  const { address: wallet, isConnected, chainId: walletChainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: balance } = useBalance({ address: wallet, chainId: target?.chainId });
  const { sendTransactionAsync } = useSendTransaction();
  // 別のタブとの排他が使えるか (描画後に読む = server と初回 client の描画を揃える)。null = まだ読んでいない。
  const [locksOk, setLocksOk] = useState<boolean | null>(null);
  useEffect(() => {
    setLocksOk(hasStoreGasWalletLock());
  }, []);
  const watching: Watched | null = op?.hash ? (op as Watched) : localSent;
  const receipt = useWaitForTransactionReceipt({
    hash: watching?.hash,
    chainId: watching?.chainId,
    onReplaced: (r) => {
      if (!watching) return;
      replacedRef.current = { id: watching.id, reason: r.reason, to: r.transaction.to, value: r.transaction.value };
      // 置き換え先の tx を記録に残す (置き換え先が失敗 = revert しても、その receipt で結果を出せる)。送り手と nonce も
      // 置き換え先のもの (同じ送り手・同じ nonce)。
      const next = {
        id: watching.id,
        address: gasAddress,
        chainId: watching.chainId,
        from: r.transaction.from,
        nonce: r.transaction.nonce,
      };
      void withStoreGasWalletLock(async () => attachStoreGasTopUpHash(next, r.transaction.hash)).then(reload);
      if (localSent?.id === watching.id) setLocalSent({ ...localSent, hash: r.transaction.hash });
    },
  });
  const publicClient = usePublicClient({ chainId: watching?.chainId });
  // 送るチェーンの RPC (送った tx の nonce を読む)。
  const sendClient = usePublicClient({ chainId: target?.chainId });

  const pending = submitting || op !== null || localSent !== null;
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  // チェーンを選び直したら、そのチェーンの目安の下限を既定額にする。
  const targetId = target?.chainId;
  const rangeMin = range?.min;
  useEffect(() => {
    if (rangeMin) setAmount(rangeMin);
  }, [targetId, rangeMin]);

  // 結果が出たら記録を片付け、1 回だけ残高を読み直す。
  const finalize = useCallback(
    async (rec: Watched, status: 'success' | 'reverted', txHash: Hex) => {
      if (finishedRef.current.has(rec.id)) return;
      finishedRef.current.add(rec.id);
      const rep = replacedRef.current?.id === rec.id ? replacedRef.current : null;
      const toGas = !!rep?.to && same(rep.to, gasAddress) && rep.value > 0n;
      const outcome: Result['result'] =
        rep?.reason === 'cancelled'
          ? 'cancelled'
          : rep?.reason === 'replaced' && !toGas
            ? 'replaced'
            : status;
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      await withStoreGasWalletLock(async () => finishStoreGasTopUp(rec.id));
      setLocalSent((cur) => (cur?.id === rec.id ? null : cur));
      setResult({ chainId: rec.chainId, hash: txHash, result: outcome });
      reload();
      onDone();
    },
    [gasAddress, reload, onDone],
  );
  const receiptData = receipt.data;
  useEffect(() => {
    if (watching && receiptData) void finalize(watching, receiptData.status, receiptData.transactionHash);
  }, [watching, receiptData, finalize]);

  // 確定の確認が失敗した (取引の失敗 = revert でも wagmi は失敗を返す・RPC の障害)。receipt を直接読み、
  // あれば結果にする (無ければ途中のまま)。
  const checkAgain = useCallback(async () => {
    if (!watching || !publicClient) return;
    try {
      const r = await publicClient.getTransactionReceipt({ hash: watching.hash });
      await finalize(watching, r.status, r.transactionHash);
    } catch {
      // まだ見つからない・読めない。途中のまま (もう一度確かめられる)。
    }
  }, [watching, publicClient, finalize]);
  const receiptFailed = receipt.isError;
  useEffect(() => {
    if (receiptFailed) void checkAgain();
  }, [receiptFailed, checkAgain]);

  if (!target || !range) return null;
  const symbol = nativeSymbolForChainId(target.chainId) ?? '';
  const check = checkAmount(amount, range.max);
  const wrongChain = isConnected && walletChainId !== target.chainId;
  const sameAddress = !!wallet && same(wallet, gasAddress);
  const insufficient = check.ok && balance !== undefined && check.wei > balance.value;
  // 排他 (Web Locks) が無いブラウザでは始めない (二重に送る・記録を失うのを止められない・G11)。
  const canSend =
    locksOk === true && isConnected && !wrongChain && !sameAddress && check.ok && !insufficient && !pending;

  async function onSend() {
    // 押した瞬間に止める (描画やロック待ちの間の二度押しで 2 回送らない)。
    if (!canSend || !check.ok || !target || inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    const sendChainId = target.chainId;
    const value = check.wei;
    setLocalError(null);
    setResult(null);
    try {
      const reserved = await withStoreGasWalletLock(async () => {
        const current = loadStoreGasWallet();
        if (current.state !== 'ok' || !same(current.info.address, gasAddress)) {
          return { ok: false as const, reason: 'wallet_changed' as const };
        }
        return reserveStoreGasTopUp(gasAddress, sendChainId);
      });
      if (!reserved.ok) {
        setLocalError(reserved.reason);
        return;
      }
      const id = reserved.id;
      ownIdRef.current = id;
      replacedRef.current = null;
      reload();
      // 確認中は記録を延ばす (画面を開いている間、確認が終わるまで)。作った直後から ref で持ち、画面を閉じたら
      // (ウォレットが応答しないままでも) cleanup で止める = 閉じた画面が記録を延ばし続けて補充と鍵の削除を永久に止めない。
      // 止めた後は、送る前に付けた「送れたか分からない」の印が期限後に警告へ回る。
      const heartbeat = setInterval(() => {
        void withStoreGasWalletLock(async () => touchStoreGasTopUp(id));
      }, TOPUP_HEARTBEAT_MS);
      heartbeatRef.current = heartbeat;
      if (!mountedRef.current) clearInterval(heartbeat);
      let keepHeartbeat = false;
      try {
        const hash = await sendTransactionAsync({ to: gasAddress, value, chainId: sendChainId });
        // hash が返った瞬間に記録へ残す (本体)。送り手と nonce は後から別に足す (下)。残せなければ一度だけやり直す。
        const attach = () =>
          withStoreGasWalletLock(async () => attachStoreGasTopUpHash({ id, address: gasAddress, chainId: sendChainId }, hash));
        const saved = (await attach()) || (await attach());
        if (!saved && mountedRef.current) {
          // tx を記録に残せない。この画面で見張り、確認中の記録を延ばし続ける (届く途中の宛先を消させない)。画面を閉じて
          // いたら延ばさない (送る前に付けた「送れたか分からない」の印が期限後に警告へ回る)。
          setLocalSent({ id, address: gasAddress, chainId: sendChainId, at: Date.now(), hash });
          keepHeartbeat = true;
        }
        // 付帯: 送った tx の送り手と nonce を同じ tx から読んで記録に足す (receipt が無くても nonce の消費で置き換えの
        // 可能性を見るため)。画面の接続先 (React の値) は使わない (ロック待ちの間に接続先が変わると、別の財布の nonce と
        // 組になる)。待たずに走らせる = 読み取りの遅れ・失敗・タブを閉じる中断が、上の hash の記録 (本体) を巻き込まない。
        // 読めなければ hooks/useStoreGasWallet.ts の読み直しが後から足す。
        if (sendClient) {
          void readStoreGasTopUpSender(sendClient, { hash }).then(async (sender) => {
            if (!sender) return;
            await withStoreGasWalletLock(async () => noteStoreGasTopUpSender(id, sender));
            if (mountedRef.current) reload();
          });
        }
      } catch (e) {
        if (isUserRejection(e)) {
          // 送っていない (ウォレットで断った)。記録を片付ける。
          await withStoreGasWalletLock(async () => finishStoreGasTopUp(id));
        } else {
          // 送れたかどうか分からない (送った後に hash の応答を失った可能性がある)。送る前に付けた「送れたか分からない」の
          // 印のまま記録を残す。30 分は同じ宛先への補充と鍵の削除を止め、その後は消す前の警告に残る (時間では消えない =
          // 届く途中の宛先の鍵を警告なしに消させない・A5/G2)。
          setLocalError('unknown');
        }
      } finally {
        if (!keepHeartbeat) {
          clearInterval(heartbeat);
          if (heartbeatRef.current === heartbeat) heartbeatRef.current = null;
        }
        reload();
      }
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  const inputError = !check.ok
    ? amount.trim() === ''
      ? null
      : check.reason === 'too_much'
        ? t('topUpError.too_much', { max: range.max, symbol })
        : t('topUpError.invalid')
    : insufficient && !pending
      ? t('topUpError.insufficient', { symbol })
      : null;
  const error = localError
    ? t(`topUpError.${localError}`)
    : locksOk === false
      ? t('topUpError.no_locks')
      : inputError;
  // 「送れたか分からない」の記録を残している間は、「ウォレットで確認してください…」を出さない (確認中ではない)。
  const unknownHere = localError === 'unknown';

  const txLink = (chain: number, hash: Hex) => (
    <a href={txExplorerUrl(chain, hash)} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
      {t('viewTx')}
    </a>
  );
  // 確認中の記録が別のタブ (または画面を離れる前) のもの。
  const approvingHere = submitting || (op !== null && !op.hash && op.id === ownIdRef.current);

  return (
    <div className="border-t border-slate-100 pt-3">
      <p className="text-sm font-semibold text-slate-800">{t('topUpTitle')}</p>
      {!isConnected ? (
        <p className="mt-1 text-xs text-slate-500">{t('topUpConnectHint')}</p>
      ) : (
        <div className="mt-1 space-y-2 text-xs">
          {chains.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor={CHAIN_ID} className="text-slate-600">
                {t('topUpChainLabel')}
              </label>
              <NativeTokenLogo chainId={target.chainId} size={16} />
              <select
                id={CHAIN_ID}
                value={target.chainId}
                disabled={pending}
                onChange={(e) => {
                  setChainId(Number(e.target.value));
                  setLocalError(null);
                  setResult(null);
                }}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-50"
              >
                {chains.map((c) => (
                  <option key={c.chainId} value={c.chainId}>
                    {c.chain.name} ({nativeSymbolForChainId(c.chainId) ?? ''})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor={AMOUNT_ID} className="flex items-center gap-1.5 text-slate-600">
              <NativeTokenLogo chainId={target.chainId} size={14} />
              {t('topUpAmountLabel', { symbol })}
            </label>
            <input
              id={AMOUNT_ID}
              type="text"
              inputMode="decimal"
              value={amount}
              disabled={pending}
              onChange={(e) => {
                setAmount(e.target.value);
                setLocalError(null);
              }}
              autoComplete="off"
              aria-invalid={!!inputError}
              className="mt-1 block w-32 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs focus:border-brand focus:outline-none disabled:opacity-50"
            />
            <p className="mt-1 text-slate-500">{t('topUpRange', { min: range.min, max: range.max, symbol })}</p>
          </div>
          {wrongChain && !pending ? (
            <button
              type="button"
              className={BTN}
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: target.chainId })}
            >
              {t('topUpSwitch', { chain: target.chain.name })}
            </button>
          ) : (
            <button type="button" className={BTN} disabled={!canSend} onClick={() => void onSend()}>
              {t('topUpSend', { amount: check.ok ? amount.trim() : '—', symbol })}
            </button>
          )}
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          {!watching && pending && !unknownHere && (
            <p role="status" className="text-slate-600">
              {approvingHere ? t('topUpConfirmInWallet') : t('topUpApprovingElsewhere')}
            </p>
          )}
          {watching &&
            (receipt.isError ? (
              <div role="alert" className="text-amber-700">
                <p>
                  {t('topUpUnknown')} {txLink(watching.chainId, watching.hash)}
                </p>
                <button type="button" className={`${BTN} mt-1`} onClick={() => void checkAgain()}>
                  {t('topUpCheckAgain')}
                </button>
              </div>
            ) : (
              <p role="status" className="text-slate-600">
                {t('topUpMining')} {txLink(watching.chainId, watching.hash)}
              </p>
            ))}
          {result && !pending && (
            <p
              role={result.result === 'success' ? 'status' : 'alert'}
              className={result.result === 'success' ? 'text-emerald-700' : 'text-red-600'}
            >
              {t(`topUpResult.${result.result}`)} {txLink(result.chainId, result.hash)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
