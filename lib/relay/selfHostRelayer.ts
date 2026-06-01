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
  // 現在の gas 価格 (wei)。B5 の赤字防止 (gas-cost ceiling) 判定に使う。
  getGasPrice: () => Promise<bigint>;
  // pending を含む次の nonce。並行 submit の衝突検知/リトライに使う (B3)。
  getPendingNonce: () => Promise<number>;
  // pre-sign: raw tx + その hash を返す。broadcast "前" に txHash を確定させることで、
  // 送信応答が喪失 (timeout) しても hash を poll でき、relay_error→standard fallback による
  // 二重送金を避けられる (B3 の肝)。
  signTx: (
    target: Address,
    data: Hex,
    gas: bigint,
    nonce: number,
  ) => Promise<{ raw: Hex; hash: Hex }>;
  // pre-signed raw tx を broadcast し txHash を返す。送信エラーは throw (submitSelfHost が分類)。
  sendRawTransaction: (raw: Hex) => Promise<Hex>;
  // txHash の receipt を confirmations>=1 で待つ。timeout/断は throw (pollSelfHost が pending 化)。
  waitForReceipt: (hash: Hex) => Promise<{ status: 'success' | 'reverted' }>;
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

// submit: 残高チェック → gas 見積 (+20%・cap) → pending nonce 取得 → pre-sign → sendRaw。
// 返り値 taskId は (pre-signed) txHash。broadcast "前" の明確な失敗 (低残高 / 見積 revert /
// node 拒否 / 全リトライ衝突=未送信) のみ throw し、コアに relay_error を返させて standard へ
// 安全に fallback させる。送信応答が不確定なら hash を返し、pollSelfHost で pending 化する。
export async function submitSelfHost(
  io: SelfHostIo,
  target: Address,
  data: Hex,
  opts: { maxGasCostWei?: bigint } = {},
): Promise<{ taskId: string }> {
  const balance = await io.getBalance();
  if (balance < MIN_RELAYER_BALANCE_WEI) {
    // pre-submit サーキットブレーカ。tx は出さない → client は standard へ安全に fallback。
    throw new Error('relayer_unfunded');
  }
  // 見積が revert で throw した場合も broadcast 前 → 上位 (コア) で relay_error。
  const estimated = await io.estimateGas(target, data);
  const buffered = estimated + estimated / 5n; // +20%
  const gas = buffered > RELAYER_GAS_CAP ? RELAYER_GAS_CAP : buffered;

  // B5 赤字防止: gas-cost ceiling。回収する固定 fee を超える native コストになる高騰時は throw し、
  // broadcast 前なので relay_error → client は standard へ fallback (顧客が自分で gas を払う)。
  // ceiling 未設定 (0/undefined) はスキップ (testnet 既定)。
  if (opts.maxGasCostWei && opts.maxGasCostWei > 0n) {
    const gasPrice = await io.getGasPrice();
    const cost = gas * gasPrice;
    if (cost > opts.maxGasCostWei) {
      throw new Error(
        `gas_price_too_high: cost=${cost} cap=${opts.maxGasCostWei}`,
      );
    }
  }

  // nonce 衝突は fresh nonce で再試行。各試行は pre-sign (hash 確定) → sendRaw。
  let lastError: unknown;
  for (let attempt = 0; attempt <= RELAYER_NONCE_RETRIES; attempt++) {
    const nonce = await io.getPendingNonce();
    const { raw, hash } = await io.signTx(target, data, gas, nonce);
    try {
      const sent = await io.sendRawTransaction(raw);
      return { taskId: sent };
    } catch (e) {
      lastError = e;
      const cls = classifySendError(e instanceof Error ? e.message : String(e));
      if (cls === 'collision') {
        // 別 tx がこの nonce を消費。自 hash は未 broadcast → fresh nonce で再試行 (二重送金にならない)。
        continue;
      }
      if (cls === 'known') {
        // 自 tx は既に mempool。pre-signed hash を返し poll させる。
        return { taskId: hash };
      }
      if (cls === 'fatal') {
        // node が明確に拒否 (mempool 未到達) → throw して relay_error で fallback 可。
        throw e;
      }
      // uncertain: broadcast したか不明。再試行 / fallback せず、pre-signed hash を poll → timeout で pending。
      return { taskId: hash };
    }
  }
  // 全リトライが collision = 自 tx は一度も broadcast されていない → throw して fallback 安全。
  throw lastError instanceof Error
    ? lastError
    : new Error('nonce_collision_exhausted');
}

// poll: receipt を待つ。timeout/RPC 断は broadcast 済なので 'pending' (二重支払い回避)。
export async function pollSelfHost(
  io: SelfHostIo,
  taskId: string,
): Promise<RelayTaskOutcome> {
  const hash = taskId as Hex;
  try {
    const receipt = await io.waitForReceipt(hash);
    return receipt.status === 'success'
      ? { state: 'success', txHash: hash }
      : { state: 'reverted', txHash: hash };
  } catch {
    // broadcast 済で最終状態不明 (timeout / RPC 断)。error にすると fallback で二重送金しうる
    // ため pending を返す。顧客には「確認待ち」を表示し Explorer で追跡させる。
    return { state: 'pending', txHash: hash };
  }
}
