// Arc (Circle Gateway) の売上を、受取アドレスのウォレットで引き出す (plans/arc-gateway-payout.md)。
//
// x402 の Arc 決済 (Circle Gateway の Nanopayments) の売上は、受取アドレスの Gateway 残高
// (Arc・domain 26) に入る。ここはその残高を Arc → Arc で手元のウォレットへ戻すための部品。
// 署名 (BurnIntent) も受け取りの取引 (GatewayMinter.gatewayMint) も出品者のウォレットから
// 送る — OpenPay のサーバーは関与せず、鍵もガスも持たない (Circle API と Arc RPC へブラウザから直接)。
//
// 全額 = 残高 0: Gateway の burn は「額 + 実際の手数料 (≤ maxFee)」を残高から引く
// (circlefin/evm-gateway-contracts Burns.sol)。額 = 残高 − 手数料・maxFee = 手数料ちょうどで署名する。
// Circle がこの maxFee を受け付けなければ /v1/transfer が拒否する (余裕を足して再署名はしない・user 裁定)。

import { getAddress, parseAbi, parseUnits, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { chainForSlug } from '../chains';
import { deploymentForSlug } from '../tokens';
import { CIRCLE_GATEWAY_API_BASE_URL, GATEWAY_MINTER_ADDRESS, GATEWAY_WALLET_ADDRESS } from './config';
import { ensureWalletChain } from './executeShared';
import type { SwitchChainFn } from './executeTypes';
import {
  addressToBytes32,
  buildBurnIntent,
  encodeGatewayMintCalldata,
  getBurnIntentTypedData,
  readGatewayBurnIntentContext,
  requestAttestation,
} from './gateway';
import { validateGatewayAttestation } from './gatewayAttestation';
import { CIRCLE_DOMAIN_ARC, type AttestationResponse, type BurnIntent, type FetchLike } from './types';

/** Arc の chain (NEXT_PUBLIC_NETWORK_ENV に追従: mainnet 5042 / testnet 5042002)。 */
export function arcPayoutChain() {
  return chainForSlug('arc');
}

/** Arc の USDC (ERC-20 面・6 桁)。native gas と同一残高。 */
function arcUsdcAddress(): Address {
  return deploymentForSlug('usdc', 'arc').address;
}

// /v1/balances・/v1/estimate は human USDC (小数 6 桁まで) の文字列。Number や丸めを経由しない。
function parseUsdc(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`Invalid Gateway ${field}: expected an unsigned decimal with at most 6 decimal places`);
  }
  return parseUnits(value, 6);
}

export type ArcPayoutBalance =
  // pending = 精算待ち (pendingBatch)。Circle の文書に無い項目なので、応答に無ければ null (0 と決めつけない)。
  | { status: 'ok'; available: bigint; pending: bigint | null }
  | { status: 'error'; error: string };

/**
 * 受取アドレスの Arc の Gateway 残高。取れないときは status:'error' (0 と表示させない)。
 * 別の domain・別のアドレスの行が混ざった応答は信用しない。
 */
export async function readArcPayoutBalance(
  depositor: Address,
  opts: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<ArcPayoutBalance> {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? CIRCLE_GATEWAY_API_BASE_URL;
  // Circle の障害・形式違いを画面の例外にせず「取得できません」に閉じる (偽の 0 を出さない)。
  try {
    const res = await fetchImpl(`${baseUrl}/v1/balances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ domain: CIRCLE_DOMAIN_ARC, depositor }] }),
    });
    if (!res.ok) return { status: 'error', error: `Circle Gateway /v1/balances HTTP ${res.status}` };
    const json = (await res.json()) as { balances?: unknown };
    const rows = Array.isArray(json.balances) ? json.balances : [];
    if (rows.length !== 1) throw new Error('Unexpected Gateway balance rows');
    const row = rows[0] as { domain?: unknown; depositor?: unknown; balance?: unknown; pendingBatch?: unknown };
    if (row.domain !== CIRCLE_DOMAIN_ARC || typeof row.depositor !== 'string' ||
        row.depositor.toLowerCase() !== depositor.toLowerCase()) {
      throw new Error('Gateway balance row does not match the requested Arc depositor');
    }
    return {
      status: 'ok',
      available: parseUsdc(row.balance, 'balance'),
      pending: row.pendingBatch === undefined ? null : parseUsdc(row.pendingBatch, 'pendingBatch'),
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Arc → Arc の引き出し (自分宛て) の TransferSpec の見積もり用の形 (署名しない)。 */
function estimateSpec(depositor: Address, value: bigint) {
  const usdc = addressToBytes32(arcUsdcAddress());
  const self = addressToBytes32(depositor);
  return {
    version: 1,
    sourceDomain: CIRCLE_DOMAIN_ARC,
    destinationDomain: CIRCLE_DOMAIN_ARC,
    sourceContract: addressToBytes32(GATEWAY_WALLET_ADDRESS),
    destinationContract: addressToBytes32(GATEWAY_MINTER_ADDRESS),
    sourceToken: usdc,
    destinationToken: usdc,
    sourceDepositor: self,
    destinationRecipient: self,
    sourceSigner: self,
    destinationCaller: addressToBytes32('0x0000000000000000000000000000000000000000'),
    value: value.toString(),
    salt: `0x${'0'.repeat(64)}`,
    hookData: '0x',
  };
}

/**
 * Circle が Arc から引き出すときに残高から引く手数料 (atomic・6 桁)。
 *
 * /v1/estimate は forwarder なしだと「余裕込みの推奨 maxFee」(baseFee の 1.1 倍) しか返さないため、
 * 内訳 (perIntent の baseFee・transferFee) を返す `enableForwarder=true` の見積もりを読む。
 * 見積もりを読むだけで、引き出しに forwarder は使わない (受け取りの取引は出品者が自分で送る)。
 * 内訳が取れなければ投げる — 文書の 0.0035 を仮定して署名させない。
 */
export async function fetchArcPayoutFee(
  depositor: Address,
  value: bigint,
  opts: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<bigint> {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? CIRCLE_GATEWAY_API_BASE_URL;
  const res = await fetchImpl(`${baseUrl}/v1/estimate?enableForwarder=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ spec: estimateSpec(depositor, value) }]),
  });
  if (!res.ok) throw new Error(`Circle Gateway /v1/estimate HTTP ${res.status}`);
  const json = (await res.json()) as { fees?: { token?: unknown; perIntent?: unknown } };
  const perIntent = Array.isArray(json.fees?.perIntent) ? json.fees.perIntent : [];
  if (json.fees?.token !== 'USDC' || perIntent.length !== 1) throw new Error('Unexpected Gateway fee estimate');
  const fee = perIntent[0] as { domain?: unknown; baseFee?: unknown; transferFee?: unknown };
  if (fee.domain !== CIRCLE_DOMAIN_ARC) throw new Error('Gateway fee estimate is not for the Arc domain');
  return parseUsdc(fee.baseFee, 'baseFee') +
    (fee.transferFee === undefined ? 0n : parseUsdc(fee.transferFee, 'transferFee'));
}

export type ArcPayoutPlan =
  | { ok: true; value: bigint; maxFee: bigint }
  | { ok: false; reason: 'below_fee' };

/** 全額を引き出す額: 額 + 手数料 = 残高 (残高 0)。残高が手数料以下なら引き出せない。 */
export function planArcPayout(available: bigint, fee: bigint): ArcPayoutPlan {
  if (available <= fee) return { ok: false, reason: 'below_fee' };
  return { ok: true, value: available - fee, maxFee: fee };
}

/** 自分宛て・Arc → Arc の BurnIntent。受取人 = 引き出し元 = 署名者 = 接続中のアドレス。 */
export function buildArcPayoutIntent(args: {
  depositor: Address;
  value: bigint;
  maxFee: bigint;
  currentBlockHeight: bigint;
  withdrawalDelay: bigint;
  salt?: Hex;
}): BurnIntent {
  const usdc = arcUsdcAddress();
  const depositor = getAddress(args.depositor);
  return buildBurnIntent({
    sourceDomain: CIRCLE_DOMAIN_ARC,
    destinationDomain: CIRCLE_DOMAIN_ARC,
    sourceToken: usdc,
    destinationToken: usdc,
    depositor,
    recipient: depositor,
    value: args.value,
    currentBlockHeight: args.currentBlockHeight,
    withdrawalDelay: args.withdrawalDelay,
    overrides: { maxFee: args.maxFee, ...(args.salt ? { salt: args.salt } : {}) },
  });
}

/** 受け取りの取引を送るのに要る情報 (attestation は 10 分で失効し、未使用なら残高に戻る)。 */
export type ArcPayoutAttestation = {
  /** 引き出し元 = 受取人 = 署名者 (checksum)。受け取りの取引もこのアカウントから送る。 */
  depositor: Address;
  attestation: Hex;
  signature: Hex;
  /** GatewayMinter が受け取り済みかを記録する鍵 (keccak256(TransferSpec))。受け取りの成否はこれで決める。 */
  transferSpecHash: Hex;
  /** Arc のブロック高 (attestation の maxBlockHeight)。これを過ぎると gatewayMint は失敗し、残高に戻る。
   *  失効は壁時計でなくこのブロック高で判定する (Circle の文書は「10 分」)。 */
  expiresAtBlock: bigint;
  value: bigint;
  /** 送った受け取りの取引。結果が分かるまでは、送り直さずにこれの結果を確かめる。 */
  txHash?: Hex;
};

export type ArcPayoutStep = 'switching' | 'signing' | 'requesting' | 'minting' | 'confirming';

type WalletDeps = {
  walletClient: WalletClient;
  publicClient: PublicClient;
  switchChainAsync: SwitchChainFn;
  fetch?: FetchLike;
  baseUrl?: string;
};

/**
 * 全額の引き出しの前半: 残高と手数料を読み直し → Arc に切り替え → 署名 → attestation を受け取り照合する。
 * ここまでで Circle は残高を引き当てる (10 分以内に受け取りの取引が無ければ残高に戻る)。
 */
export async function requestArcPayout(
  depositor: Address,
  deps: WalletDeps & { onStep?: (step: ArcPayoutStep) => void },
): Promise<ArcPayoutAttestation> {
  const opts = { fetch: deps.fetch, baseUrl: deps.baseUrl };
  // 画面に出した額は古いかもしれない (精算で増えた等)。押した時点の残高で全額を決め直す。
  const balance = await readArcPayoutBalance(depositor, opts);
  if (balance.status !== 'ok') throw new ArcPayoutError('balance_unavailable');
  const fee = await fetchArcPayoutFee(depositor, balance.available, opts);
  const plan = planArcPayout(balance.available, fee);
  if (!plan.ok) throw new ArcPayoutError('below_fee');

  const chainId = arcPayoutChain().id;
  deps.onStep?.('switching');
  await ensureWalletChain(deps.walletClient, deps.switchChainAsync, chainId);
  const context = await readGatewayBurnIntentContext(deps.publicClient, chainId);
  const intent = buildArcPayoutIntent({ depositor, value: plan.value, maxFee: plan.maxFee, ...context });

  deps.onStep?.('signing');
  const signature = await deps.walletClient.signTypedData({
    account: getAddress(depositor),
    ...getBurnIntentTypedData(intent),
  });

  deps.onStep?.('requesting');
  const att: AttestationResponse = await requestAttestation({ burnIntent: intent, signature }, opts);
  // Circle の応答が自分の署名した内容 (自分宛て・この額・Arc) と一致するものだけを送る。
  const decoded = validateGatewayAttestation(att, intent.spec);
  return {
    depositor: getAddress(depositor),
    attestation: att.attestation,
    signature: att.signature,
    transferSpecHash: decoded.transferSpecHash,
    expiresAtBlock: decoded.maxBlockHeight,
    value: plan.value,
  };
}

const MINTER_USED_ABI = parseAbi(['function isTransferSpecHashUsed(bytes32 transferSpecHash) view returns (bool)']);

/** GatewayMinter がこの引き出しを受け取り済みか (送った取引の receipt でなく、コントラクトの記録で決める)。 */
async function isArcPayoutMinted(publicClient: PublicClient, transferSpecHash: Hex): Promise<boolean> {
  return publicClient.readContract({
    address: GATEWAY_MINTER_ADDRESS,
    abi: MINTER_USED_ABI,
    functionName: 'isTransferSpecHashUsed',
    args: [transferSpecHash],
  });
}

/** 受け取りの取引の確定を待つ時間。過ぎたら「結果を確かめ直す」(送り直さない)。 */
const MINT_RECEIPT_TIMEOUT_MS = 120_000;

/**
 * 全額の引き出しの後半: 受け取りの取引 (gatewayMint) を自分のウォレットから Arc で送り、受け取れたかを確かめる。
 * 再送・確かめ直しにも使う。成否は GatewayMinter の記録 (isTransferSpecHashUsed) で決める — 取引の receipt だけでは、
 * ウォレットでの取り消し (同じ nonce の別の取引) が成功の receipt を返すことがある (viem の onReplaced)。
 *
 * - 受け取り済み → 受け取った取引の hash を返す (別の人が送って受け取り済みなら null)。
 * - 送った取引があり結果が分からない (receipt を待てない) → `confirm_unknown`。送り直さない (同じ attestation の
 *   二重の受け取りは Gateway が拒むが、ガスの無駄と「失敗」の誤表示を避ける)。
 * - 送った取引が受け取りにならなかった (revert・取り消し) → `mint_not_completed` (失効までは送り直せる)。
 * - 失効した → `attestation_expired` (残高に戻るのを待つ)。
 */
export async function completeArcPayout(
  attestation: ArcPayoutAttestation,
  deps: Omit<WalletDeps, 'fetch' | 'baseUrl'> & {
    onStep?: (step: ArcPayoutStep) => void;
    /** 送った直後に呼ぶ (hash を画面に残し、結果が分からなくても送り直さないため)。 */
    onBroadcast?: (txHash: Hex) => void;
  },
): Promise<Hex | null> {
  const { publicClient } = deps;
  if (await isArcPayoutMinted(publicClient, attestation.transferSpecHash)) return attestation.txHash ?? null;

  let txHash = attestation.txHash;
  if (!txHash) {
    if ((await publicClient.getBlockNumber({ cacheTime: 0 })) > attestation.expiresAtBlock) {
      throw new ArcPayoutError('attestation_expired');
    }
    await ensureWalletChain(deps.walletClient, deps.switchChainAsync, arcPayoutChain().id);
    deps.onStep?.('minting');
    txHash = await deps.walletClient.sendTransaction({
      account: attestation.depositor,
      chain: arcPayoutChain(),
      to: GATEWAY_MINTER_ADDRESS,
      data: encodeGatewayMintCalldata(attestation.attestation, attestation.signature),
    });
    deps.onBroadcast?.(txHash);
  }

  deps.onStep?.('confirming');
  let minedHash: Hex = txHash;
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: MINT_RECEIPT_TIMEOUT_MS,
      // 手数料の上げ直し (repriced) は同じ受け取りの取引。取り消し・置き換えは下の記録の確認で「受け取っていない」になる。
      onReplaced: (replacement) => { minedHash = replacement.transaction.hash; },
    });
    minedHash = receipt.transactionHash;
  } catch {
    // RPC 障害・時間切れ: 取引は届いているかもしれない。記録で受け取り済みと分かれば成功、そうでなければ確かめ直しを促す。
    if (await isArcPayoutMinted(publicClient, attestation.transferSpecHash).catch(() => false)) return txHash;
    throw new ArcPayoutError('confirm_unknown');
  }
  if (await isArcPayoutMinted(publicClient, attestation.transferSpecHash)) return minedHash;
  if ((await publicClient.getBlockNumber({ cacheTime: 0 })) > attestation.expiresAtBlock) {
    throw new ArcPayoutError('attestation_expired');
  }
  throw new ArcPayoutError('mint_not_completed');
}

export type ArcPayoutErrorCode =
  | 'balance_unavailable'
  | 'below_fee'
  | 'attestation_expired'
  | 'confirm_unknown'
  | 'mint_not_completed';

export class ArcPayoutError extends Error {
  constructor(public readonly code: ArcPayoutErrorCode) {
    super(`Arc payout: ${code}`);
    this.name = 'ArcPayoutError';
  }
}
