// お店の端末のガス用ウォレット (レジ・plans/store-gas-wallet.md)。
//
// レジの端末がお客様の署名を自分のガス (POL) で送るための専用の鍵。鍵はこの端末の localStorage にだけ
// 置き、OpenPay のサーバには送らない (fetch の body に載せない)。JPYC を受け取る店のウォレットとは別の鍵で、
// 入れるのは少額の POL だけ (端末の紛失・ブラウザの侵害で失いうるのは入れた POL のみ)。
// 対象チェーンは Polygon (testnet は Amoy) だけ。

import { isAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { env } from './env';
import { safeGet, safeRemove, safeSet } from './storage';

export const STORE_GAS_WALLET_STORAGE_KEY = 'openpay:store-gas-wallet:v1';

// forwarder.settle 1 回の目安ガス (残り回数の概算用・送信時の上限ではない)。
export const STORE_GAS_SETTLE_GAS_ESTIMATE = 150_000n;

export type StoredStoreGasWallet = {
  v: 1;
  privateKey: Hex;
  address: Address;
  createdAt: number;
};

/** ガス用ウォレットを使うチェーン (mainnet = Polygon・testnet = Amoy)。 */
export function storeGasWalletChain() {
  return env.networkEnv === 'mainnet' ? polygon : polygonAmoy;
}

function isStoredWallet(value: unknown): value is StoredStoreGasWallet {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.privateKey === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(o.privateKey) &&
    typeof o.address === 'string' &&
    isAddress(o.address) &&
    typeof o.createdAt === 'number'
  );
}

/** 保存済みの鍵を読む。無い・壊れている・鍵とアドレスが食い違う場合は null。 */
export function loadStoreGasWallet(): StoredStoreGasWallet | null {
  const raw = safeGet<unknown>(STORE_GAS_WALLET_STORAGE_KEY, null);
  if (!isStoredWallet(raw)) return null;
  // 鍵から導いたアドレスと保存値が違う = 改ざん/破損。送信に使わない。
  if (privateKeyToAccount(raw.privateKey).address.toLowerCase() !== raw.address.toLowerCase()) {
    return null;
  }
  return raw;
}

export type CreateStoreGasWalletResult =
  | { ok: true; wallet: StoredStoreGasWallet }
  | { ok: false; reason: 'already_exists' | 'storage_unavailable' };

/**
 * 新しい鍵を作って保存する。保存できたことを読み戻しで確かめてから成功を返す
 * (プライベートブラウズ等で保存に失敗したのにアドレスを見せ、POL を入れた後に鍵が消える偽成功を断つ)。
 * 既に鍵があるときは上書きしない (入っている POL を失わないため)。
 */
export function createStoreGasWallet(now: number = Date.now()): CreateStoreGasWalletResult {
  if (loadStoreGasWallet()) return { ok: false, reason: 'already_exists' };
  const privateKey = generatePrivateKey();
  const wallet: StoredStoreGasWallet = {
    v: 1,
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    createdAt: now,
  };
  safeSet(STORE_GAS_WALLET_STORAGE_KEY, wallet);
  const saved = loadStoreGasWallet();
  if (!saved || saved.privateKey !== privateKey) {
    return { ok: false, reason: 'storage_unavailable' };
  }
  return { ok: true, wallet: saved };
}

/** この端末から鍵を消す (残っている POL は戻せなくなる・呼び出し側で確認を取る)。 */
export function removeStoreGasWallet(): void {
  safeRemove(STORE_GAS_WALLET_STORAGE_KEY);
}

/** 残高と現在のガス価格から、あと何回送れるかの目安 (0 以上の整数)。 */
export function estimateRemainingSends(balanceWei: bigint, gasPriceWei: bigint): number {
  if (balanceWei <= 0n || gasPriceWei <= 0n) return 0;
  const perSend = gasPriceWei * STORE_GAS_SETTLE_GAS_ESTIMATE;
  const n = balanceWei / perSend;
  return n > 9999n ? 9999 : Number(n);
}

/**
 * 「残りの POL を戻す」で送れる額 (残高 − gas × maxFeePerGas)。送信時も同じ gas と maxFeePerGas を
 * 渡すので、実際のガス代はこの見込み以下 (差は少額の端数として残る)。送れないなら 0。
 */
export function withdrawableAmount(
  balanceWei: bigint,
  gas: bigint,
  maxFeePerGasWei: bigint,
): bigint {
  const reserve = gas * maxFeePerGasWei;
  return balanceWei > reserve ? balanceWei - reserve : 0n;
}
