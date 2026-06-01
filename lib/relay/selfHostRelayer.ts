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
// transferWithAuthorization は ~80–120k なので 300k で十分な余裕。
export const RELAYER_GAS_CAP = 300_000n;
// receipt 待ちの timeout。超過は broadcast 済のため 'pending' を返す (error にしない)。
export const RELAYER_RECEIPT_TIMEOUT_MS = 60_000;

// viem client から組む I/O を注入する (テストでは fake を渡す)。関数注入なので client の
// 型ジェネリクスに縛られず unit test で全分岐を担保できる。
export type SelfHostIo = {
  // relayer EOA の native 残高 (wei)。
  getBalance: () => Promise<bigint>;
  // tx の gas 見積。revert する tx はここで throw → broadcast 前なので relay_error。
  estimateGas: (target: Address, data: Hex) => Promise<bigint>;
  // tx を broadcast し txHash を返す。throw = broadcast 前の失敗。
  sendTransaction: (target: Address, data: Hex, gas: bigint) => Promise<Hex>;
  // txHash の receipt を confirmations>=1 で待つ。timeout/断は throw (pollSelfHost が pending 化)。
  waitForReceipt: (hash: Hex) => Promise<{ status: 'success' | 'reverted' }>;
};

// submit: 残高チェック → gas 見積 (+20%・cap) → broadcast。返り値 taskId は broadcast 済 txHash。
// broadcast 前の失敗 (低残高 / 見積 revert / RPC) は throw して、コアに relay_error を返させる。
export async function submitSelfHost(
  io: SelfHostIo,
  target: Address,
  data: Hex,
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
  const hash = await io.sendTransaction(target, data, gas);
  return { taskId: hash };
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
