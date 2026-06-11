// 自前 JPYC EIP-3009 リレイヤー。Gelato sponsoredCall の代わりに、運営の relayer EOA が
// transferWithAuthorization を直接 broadcast し POL ガスを負担する (Gelato のプラン課金・
// 第三者依存を排除)。route が viem client から下記の I/O を組んで inject し、jpycRelay の
// DI コア (submitSponsoredCall / pollTask) に渡す。詳細・段階計画は memory:jpyc-eip3009。
//
// 安全設計 (Codex review 反映):
//  - submit は broadcast "前" の失敗 (資金不足 / gas 見積 revert / RPC) で throw する。コアは
//    それを relay_error に変換し client は standard mode へ安全に fallback できる (tx 未送信)。
//  - pollReceipt は broadcast "後" なので、timeout / RPC 断を 'error' ではなく 'pending' に
//    倒す。'error' にすると client が standard へ fallback し、後から tx が確定すると二重支払い
//    になる (Codex #4)。一度 broadcast したら success/reverted/pending のみを返す。
//  - relayer 鍵が持つのは POL (native gas) のみ。顧客署名済の authorization を中継するだけで
//    顧客資金は動かせない (from/to/value は顧客が署名済)。漏洩時の被害は POL 残高に限定。

import type { Address, Hex } from 'viem';
import type { RelayTaskOutcome } from './jpycRelay';

// relayer の native (POL) 残高がこれ未満なら submit 前に弾く (broadcast せず relay_error)。
export const MIN_RELAYER_BALANCE_WEI = 10n ** 16n; // 0.01 native (POL)
// 1 tx の gas 上限。見積に +20% バッファした上で、異常値を防ぐハードキャップ。
// 直接 transferWithAuthorization は ~80–120k だが、forwarder.settle は receiveWithAuthorization
// + safeTransfer×2 で実測 ~250–300k (Amoy fork で確認)。両経路を賄うため 500k に設定。
export const RELAYER_GAS_CAP = 500_000n;
// receipt 待ちの timeout。超過は broadcast 済のため 'pending' を返す (error にしない)。
export const RELAYER_RECEIPT_TIMEOUT_MS = 60_000;
// nonce 衝突 (並行 submit が同一 pending nonce を取得) 時の再試行回数。各リトライは fresh nonce で
// re-sign / re-send。衝突した自 tx は mempool に未到達なので、二重送金にはならない (B3)。
export const RELAYER_NONCE_RETRIES = 2;

// viem client から組む I/O を注入する (テストでは fake を渡す)。関数注入なので client の
// 型ジェネリクスに縛られず unit test で全分岐を担保できる。
export type SelfHostIo = {
  // relayer EOA の native 残高 (wei)。
  getBalance: () => Promise<bigint>;
  // tx の gas 見積。revert する tx はここで throw → broadcast 前なので relay_error。
  estimateGas: (target: Address, data: Hex) => Promise<bigint>;
  // pending を含む次の nonce。並行 submit の衝突検知/リトライに使う (B3)。
  getPendingNonce: () => Promise<number>;
  // pre-sign: raw tx + その hash + 署名された maxFeePerGas を返す。broadcast "前" に txHash を
  // 確定させることで送信応答が喪失 (timeout) しても hash を poll でき、relay_error→standard
  // fallback による二重送金を避けられる (B3 の肝)。maxFeePerGas は B5 赤字判定 (実際に署名された
  // fee で gas-cost ceiling を評価する) に使う。
  signTx: (
    target: Address,
    data: Hex,
    gas: bigint,
    nonce: number,
  ) => Promise<{ raw: Hex; hash: Hex; maxFeePerGas: bigint }>;
  // pre-signed raw tx を broadcast。送信エラーは throw (submitSelfHost が分類)。返り値 hash は
  // 信用せず、常に pre-signed の canonical hash を poll する (P2)。
  sendRawTransaction: (raw: Hex) => Promise<Hex>;
  // txHash の receipt を confirmations>=1 で待つ。timeout/断は throw (pollSelfHost が pending 化)。
  // transactionHash は replacement 検出用 (待っていた hash と異なれば別 tx の置換)。
  waitForReceipt: (
    hash: Hex,
  ) => Promise<{ status: 'success' | 'reverted'; transactionHash: Hex }>;
};

// submit に渡すオプション。
//  - maxGasCostWei: B5 gas-cost ceiling (赤字防止)。0/undefined はスキップ。
//  - isAuthorizationUsed: 「この authorization が既に on-chain で執行済か」を返す callback。
//    送信エラー時 (collision/fatal) に再確認し、執行済なら fallback せず pending に倒すための
//    「serialized owner の証明」(Codex P0/P1)。未提供なら collision は retry、fatal は relay_error。
//  - lowBalanceWei / onLowBalance: 残高はあるが watermark を下回ったら submit 前に発火する事前警告。
//    relayer_unfunded は枯渇"後"の事後検知なので、その手前で operator に補充を促すため。0/未提供で無効。
export type SubmitSelfHostOpts = {
  maxGasCostWei?: bigint;
  isAuthorizationUsed?: () => Promise<boolean>;
  lowBalanceWei?: bigint;
  onLowBalance?: (balanceWei: bigint) => void;
};

// 送信エラーの分類 (B3)。安全側 default は 'uncertain' (broadcast したか不明 → hash を poll → pending)。
//  - 'collision': nonce が別 tx に取られ、自 tx (この nonce) は mempool 未到達 → fresh nonce で再試行。
//  - 'known'    : 自 tx が既に mempool に在る → その hash を poll。
//  - 'fatal'    : node が明確に拒否し mempool 未到達が確実 → relay_error で standard へ fallback 可。
//  - 'uncertain': timeout / 接続断 / 不明 → broadcast したか不確定。再試行も fallback もせず poll。
export type SendErrorClass = 'collision' | 'known' | 'fatal' | 'uncertain';

export function classifySendError(message: string): SendErrorClass {
  const m = message.toLowerCase();
  // nonce 衝突 (自 tx は未 broadcast・別 tx が先にその nonce を消費)。
  if (
    m.includes('nonce too low') ||
    m.includes('nonce is too low') ||
    m.includes('replacement transaction underpriced') ||
    m.includes('replacement underpriced')
  ) {
    return 'collision';
  }
  // 自 tx が既に mempool に在る (重複 broadcast)。
  if (
    m.includes('already known') ||
    m.includes('already imported') ||
    m.includes('known transaction') ||
    m.includes('transaction already exists')
  ) {
    return 'known';
  }
  // node の明確な拒否 (検証で弾かれ mempool 未到達が確実 → fallback 安全)。
  if (
    m.includes('insufficient funds') ||
    m.includes('intrinsic gas too low') ||
    m.includes('exceeds block gas limit') ||
    m.includes('gas limit reached') ||
    m.includes('invalid sender')
  ) {
    return 'fatal';
  }
  // それ以外 (timeout / 接続断 / 不明) は broadcast 不確定。安全側に倒し poll → pending。
  return 'uncertain';
}

// submit: 残高チェック → gas 見積 (+20%・cap) → pending nonce 取得 → pre-sign (B5 ceiling) → sendRaw。
// 返り値 taskId は常に pre-signed の canonical txHash (送信応答値は信用しない・P2)。
// 二重支払い防止の原則: 「自 authorization が執行されていない」と証明できる場合のみ throw=relay_error
// (standard へ安全に fallback)。証明できない不確定は hash を返し pollSelfHost で pending 化する。
export async function submitSelfHost(
  io: SelfHostIo,
  target: Address,
  data: Hex,
  opts: SubmitSelfHostOpts = {},
): Promise<{ taskId: string }> {
  const balance = await io.getBalance();
  if (balance < MIN_RELAYER_BALANCE_WEI) {
    // pre-submit サーキットブレーカ。tx は出さない → client は standard へ安全に fallback。
    throw new Error('relayer_unfunded');
  }
  // 残高はあるが watermark 未満 → 枯渇前に事前警告 (operator が補充できるよう・上の throw は事後検知)。
  // 警告は純粋に additive: callback (logger/telemetry) が throw しても正当な relay を中断させない。
  if (opts.lowBalanceWei && opts.onLowBalance && balance < opts.lowBalanceWei) {
    try {
      opts.onLowBalance(balance);
    } catch {
      // 低残高警告の失敗は無視し relay 本処理を継続 (telemetry が決済を壊さないため)
    }
  }
  // 見積が revert で throw した場合も broadcast 前 → 上位 (コア) で relay_error。
  const estimated = await io.estimateGas(target, data);
  const buffered = estimated + estimated / 5n; // +20%
  const gas = buffered > RELAYER_GAS_CAP ? RELAYER_GAS_CAP : buffered;

  // authorization が既に on-chain で執行済か。RPC が throw した場合は 'unknown' (判定不能) を返し、
  // 呼出側で保守的に pending へ倒す (callback の RPC エラーが relay_error→fallback に化けて二重
  // 送金窓を再び開くのを防ぐ・Codex P0)。checker 未提供は 'unused' (従来挙動)。
  const authState = async (): Promise<'used' | 'unused' | 'unknown'> => {
    if (!opts.isAuthorizationUsed) return 'unused';
    try {
      return (await opts.isAuthorizationUsed()) ? 'used' : 'unused';
    } catch {
      return 'unknown';
    }
  };

  // nonce 衝突は fresh nonce で再試行。各試行は pre-sign (hash 確定) → sendRaw。
  let lastHash: Hex | undefined;
  for (let attempt = 0; attempt <= RELAYER_NONCE_RETRIES; attempt++) {
    const nonce = await io.getPendingNonce();
    const { raw, hash, maxFeePerGas } = await io.signTx(target, data, gas, nonce);
    lastHash = hash;

    // B5 赤字防止: 実際に署名された maxFeePerGas で gas-cost ceiling を評価。超過は send 前なので
    // throw → relay_error → client は standard へ fallback (顧客が自分で gas を払う)。未設定はスキップ。
    if (opts.maxGasCostWei && opts.maxGasCostWei > 0n) {
      const cost = gas * maxFeePerGas;
      if (cost > opts.maxGasCostWei) {
        throw new Error(
          `gas_price_too_high: cost=${cost} cap=${opts.maxGasCostWei}`,
        );
      }
    }

    try {
      await io.sendRawTransaction(raw);
      // 送信受理。node 返却 hash は信用せず canonical pre-signed hash を poll (P2)。
      return { taskId: hash };
    } catch (e) {
      const cls = classifySendError(e instanceof Error ? e.message : String(e));
      if (cls === 'known') {
        // 自 tx は既に mempool。canonical hash を poll。
        return { taskId: hash };
      }
      if (cls === 'collision') {
        // 自 tx (この nonce) は submission で拒否され mempool 未到達。ただし「この authorization が
        // 既に別 tx で執行済」可能性を排除するため authState を再確認 (P0)。used/unknown (執行済 or
        // 判定不能) は再試行/fallback せず pending に倒す。unused のみ fresh nonce で再試行 (別
        // authorization が nonce を取った通常ケース)。
        if ((await authState()) !== 'unused') return { taskId: hash };
        continue;
      }
      if (cls === 'fatal') {
        // node の明確な検証拒否 (insufficient funds 等) は mempool 未到達。ただし誤分類で実は
        // broadcast 済の可能性に備え authState を確認 (P1)。used/unknown→pending / unused (mempool
        // 未到達が確実) のみ relay_error で fallback。
        if ((await authState()) !== 'unused') return { taskId: hash };
        throw e;
      }
      // uncertain: broadcast したか不明。再試行 / fallback せず canonical hash を poll → timeout で pending。
      return { taskId: hash };
    }
  }
  // 全リトライが collision (= 各試行は mempool 未到達)。証明なしに relay_error→fallback すると
  // 万一の二重送金リスクがあるため、保守的に canonical hash を poll → pending に倒す (P0)。
  return { taskId: (lastHash ?? `0x${'0'.repeat(64)}`) as Hex };
}

// poll: receipt を待つ。timeout/RPC 断は broadcast 済なので 'pending' (二重支払い回避)。
export async function pollSelfHost(
  io: SelfHostIo,
  taskId: string,
): Promise<RelayTaskOutcome> {
  const hash = taskId as Hex;
  try {
    const receipt = await io.waitForReceipt(hash);
    // P0: replacement 検出。viem は同一 nonce の置換 tx の receipt を返しうる。受領 receipt が
    // 待っていた hash と異なる (= 別 tx が置換) 場合、その status を自 authorization の結果として
    // 信用しない → pending (自 tx の最終状態は不明)。txHash は置換 tx の方を返す: canonical
    // hash は nonce が置換で消費され永遠に mine されない (explorer で Not Found) ため、KV 記録と
    // 202 応答の追跡ポインタは実際に nonce を消費した tx を指す (fee-bump 同 payload で執行
    // 済みか cancel かは receipt 側で判別できる)。
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      return { state: 'pending', txHash: receipt.transactionHash };
    }
    return receipt.status === 'success'
      ? { state: 'success', txHash: hash }
      : { state: 'reverted', txHash: hash };
  } catch {
    // broadcast 済で最終状態不明 (timeout / RPC 断)。error にすると fallback で二重送金しうる
    // ため pending を返す。顧客には「確認待ち」を表示し Explorer で追跡させる。
    return { state: 'pending', txHash: hash };
  }
}
