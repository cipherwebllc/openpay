// cross-chain executor (Gateway / CCTP / Forward) が共有する wallet・receipt・会計 callback の
// helper (R12 で execute.ts から移動・本文は分割前と同一)。module 単位の state は持たない。

import {
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { chainObjectForId } from '../chains';
import { logger } from '../logger';
import { cctpReceiptShowsMint } from './cctp';
import type { OnMerchantMint, SwitchChainFn } from './executeTypes';

// onMerchantMint を隔離して呼ぶ。会計ログ (best-effort) の例外で、確定済の merchant mint
// 後の決済 flow を中断させないため (callee は通常 void logPaymentEvent で fire-and-forget だが、
// 契約として呼出側でも throw を握り潰す)。
function fireMerchantMint(
  cb: OnMerchantMint | undefined,
  info: Parameters<OnMerchantMint>[0],
): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    /* audit ログ失敗は決済確定に影響させない */
  }
}

// switchChainAsync は wallet (MetaMask 等) が wallet_switchEthereumChain を resolve
// した時点で返るが、injected provider の eth_chainId が新 chain を報告するまでに
// 僅かな lag があることがある。viem の writeContract / sendTransaction は送信前に
// live eth_chainId を取得して current chain を assert するため、lag 中に tx を出すと
// "current chain of the wallet does not match the target chain" で abort する
// (testnet 実機: Base Sepolia 受取 → OP Sepolia 支払元の approve で再現)。
// switch 後に live chainId が target に揃うまで bounded poll してから戻すことで
// このレースを閉じる。既に target chain なら switch 自体を skip し不要な wallet
// popup を避ける (chainId は live eth_chainId なので stale walletClient closure でも
// 正しく判定できる)。
const CHAIN_SWITCH_CONFIRM_ATTEMPTS = 20;
const CHAIN_SWITCH_CONFIRM_INTERVAL_MS = 150;

export async function ensureWalletChain(
  walletClient: WalletClient,
  switchChainAsync: SwitchChainFn,
  targetChainId: number,
): Promise<void> {
  if ((await walletClient.getChainId()) === targetChainId) return;
  await switchChainAsync({ chainId: targetChainId });
  for (let attempt = 0; attempt < CHAIN_SWITCH_CONFIRM_ATTEMPTS; attempt += 1) {
    if ((await walletClient.getChainId()) === targetChainId) return;
    // 最終 attempt の後は sleep せず即 throw する (switch がこの sleep 中に landed
    // しても再 check されず誤って abort するのを防ぐ — 最後の判定は常に getChainId)。
    if (attempt < CHAIN_SWITCH_CONFIRM_ATTEMPTS - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, CHAIN_SWITCH_CONFIRM_INTERVAL_MS),
      );
    }
  }
  throw new Error(
    `cross-chain execute: wallet chain を ${targetChainId} に切り替え後も ` +
      `eth_chainId が一致しません (wallet が switch を完了していない可能性)`,
  );
}

// chainId → viem Chain object 解決。supportedChains 外なら明示的に throw して
// 「unknown chain で wallet に送ろうとして wallet が NETWORK_UNRECOGNIZED 系の
// 不可解な error を返す」事態を防ぐ。caller (useCrossChainPayment) は
// CROSS_CHAIN_TARGETS / pathEnumerator 経由で chainId を受け取るので
// 実運用では throw に到達しない (= defensive)。
function resolveChainOrThrow(
  chainId: number,
  role: 'source' | 'destination',
): Chain {
  const chain = chainObjectForId(chainId);
  if (!chain) {
    throw new Error(
      `cross-chain execute: ${role} chainId ${chainId} is not in supportedChains ` +
        `(lib/chains.ts に viem Chain を登録するか CROSS_CHAIN_TARGETS から外す)`,
    );
  }
  return chain;
}

// tx receipt を待ち、status が 'success' でなければ throw する。
// viem の waitForTransactionReceipt は tx が revert しても throw せず
// status:'reverted' の receipt を返すだけなので、明示的に検証しないと revert を
// 「成功」として扱い、未着金の決済を完了記録してしまう。
async function waitForReceiptOrThrow(
  client: PublicClient,
  hash: Hex,
  label: string,
): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(
      `cross-chain execute: ${label} tx が revert しました (status=${receipt.status}, ${hash})`,
    );
  }
  return receipt;
}

// 第 7 回レビュー A2: 宛先 mint の receipt を待ち、実際に mine された mint の hash を返す。
// viem は同じ nonce の置換 (wallet の高速化 / 取消) を見つけると置換 tx の receipt で resolve する。
// status だけ見ると取消 tx の成功を mint 成功と取り違え、会計通知を撃ち、再開記録まで消してしまう。
// receipt.transactionHash が送った hash と違うときは、置換 tx の log にこの message の mint が
// あるときだけ同内容 (高速化) として実 hash を返し、無ければ throw して再開記録を残す
// (既存の revert と同じ失敗経路・resume は送った hash を未発見として再 mint する)。
async function waitForMintReceiptOrThrow(
  client: PublicClient,
  hash: Hex,
  label: string,
  expected: { message: Hex; burnToken: Address; recipient: Address; amount: bigint },
): Promise<Hex> {
  const receipt = await waitForReceiptOrThrow(client, hash, label);
  if (receipt.transactionHash.toLowerCase() === hash.toLowerCase()) return hash;
  if (cctpReceiptShowsMint(receipt.logs, expected)) return receipt.transactionHash;
  throw new Error(
    `cross-chain execute: ${label} tx が別の tx (${receipt.transactionHash}) に置き換えられ、mint を確認できません (${hash})`,
  );
}

// 既に broadcast 済の hash が on-chain で成功確定しているかを確認する。「未発見」
// (TransactionReceiptNotFoundError = 未 mine / dropped) のみ false。それ以外の reject
// (RPC ダウン / timeout / 5xx) は transport 障害で「未着」と区別できず、false に潰すと
// landed 済 mint の再 broadcast (既消費 attestation で必ず revert・失敗表示) を誘発する
// ため throw で伝播し、resume 再試行に倒す (CR-2 と同じ区別)。
// status==='reverted' は従来どおり false (revert した mint は attestation 未消費なので
// 再 broadcast が正しい)。
async function txAlreadySucceeded(
  client: PublicClient,
  hash: Hex,
): Promise<boolean> {
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    return receipt.status === 'success';
  } catch (e) {
    if ((e as { name?: unknown })?.name === 'TransactionReceiptNotFoundError') return false;
    throw e;
  }
}

// 設定ミス (zero / dEaD placeholder) の feeReceiver へブリッジすると利用料分の USDC が
// 永久に焼失する。該当時は fee ブリッジ自体をスキップ (顧客が fee 分を保持する安全側)
// して warn (billing 側の feeReceiverConfigured ガードと同等の防御)。
const FEE_RECEIVER_BURN_ADDRESSES: ReadonlySet<string> = new Set([
  zeroAddress,
  '0x000000000000000000000000000000000000dead',
]);

function isFeeReceiverBridgeable(
  feeReceiver: Address | undefined,
  feeAmount: bigint,
): boolean {
  if (feeReceiver === undefined || feeAmount <= 0n) return false;
  if (FEE_RECEIVER_BURN_ADDRESSES.has(feeReceiver.toLowerCase())) {
    logger.warn('cross-chain.fee.burn-address-receiver', { feeReceiver });
    return false;
  }
  return true;
}

// 分割先 executor 間でだけ共有する (facade からは再 export しない = 公開 API は分割前と同じ)。
export {
  fireMerchantMint,
  isFeeReceiverBridgeable,
  resolveChainOrThrow,
  txAlreadySucceeded,
  waitForMintReceiptOrThrow,
  waitForReceiptOrThrow,
};
