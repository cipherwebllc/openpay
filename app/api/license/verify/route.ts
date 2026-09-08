import { NextResponse } from 'next/server';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { kvGet, kvSet } from '@/lib/kv';
import { licenseNftEnabled } from '@/lib/license/config';
import { resolveLicenseRights, type LicenseRights } from '@/lib/license/rights';
import { acquireLicenseVerifyBudget, releaseLicenseVerifyBudget } from '@/lib/license/verifyBudget';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { getHostedProduct, isHostedId } from '@/lib/x402/hostedStore';
import { readStoreOwnership } from '@/lib/x402/storeEntitlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!licenseNftEnabled()) return respond({ error: 'not_found' }, 404);
  const params = new URL(request.url).searchParams;
  const addressInput = params.get('address') ?? '';
  const productId = params.get('product') ?? '';
  // 不正入力/重複 selector は rate limit の KV を含むすべての IO より前に拒否する。
  if (params.getAll('address').length !== 1 || params.getAll('product').length !== 1 ||
    !isAddress(addressInput) || addressInput.toLowerCase() === zeroAddress || !isHostedId(productId)) return respond({ error: 'invalid_input' }, 400);
  const address = getAddress(addressInput);
  const product = await getHostedProduct(productId);
  if (product === 'storage') return respond({ error: 'storage_unavailable' }, 503);
  if (!product || product.id !== productId || product.productKind !== 'license' || !product.license) return respond({ error: 'not_found' }, 404);
  if (!await checkIpRateLimit('license-verify', hashIp(clientIp(request)), 30, 60)) {
    const response = respond({ error: 'rate_limited' }, 429);
    response.headers.set('Retry-After', '60'); return response;
  }
  const d = product.license;
  const key = 'store:license:verify:cache:' + d.definitionHash + ':' + address.toLowerCase();
  const now = Date.now();
  try {
    const cached = await kvGet(key);
    if (cached.ok && cached.value) {
      const value = JSON.parse(cached.value);
      if (value.version === 1 && value.address === address && value.license?.productId === productId && value.license?.contract === d.contract &&
        value.license?.tokenId === d.tokenId && value.license?.chainId === d.tokenChainId && typeof value.entitled === 'boolean' &&
        [null, 'purchase', 'holder'].includes(value.basis) && ['awaiting_finality', 'pending', 'submitted', 'minted', 'registered', 'retryable', 'needs_repair', 'unknown'].includes(value.nft?.status) &&
        (value.nft.mintTxHash === undefined || (typeof value.nft.mintTxHash === 'string' && /^0x[0-9a-f]{64}$/.test(value.nft.mintTxHash))) &&
        (value.observedBlock === undefined || (typeof value.observedBlock === 'string' && /^(0|[1-9][0-9]*)$/.test(value.observedBlock))) &&
        typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt)) && now - Date.parse(value.checkedAt) >= 0 && now - Date.parse(value.checkedAt) < 60_000) {
        // cache に混入した内部フィールドを公開 API へ波及させず、公開 schema だけを投影する。
        return respond({ version: 1, address, license: { chainId: d.tokenChainId, contract: d.contract, tokenId: d.tokenId, productId },
          entitled: value.entitled, basis: value.basis, nft: { status: value.nft.status, ...(value.nft.mintTxHash ? { mintTxHash: value.nft.mintTxHash } : {}) },
          ...(value.observedBlock !== undefined ? { observedBlock: value.observedBlock } : {}), checkedAt: value.checkedAt });
      }
    }
  } catch {
    // キャッシュの破損/停止を権利の偽否定へ波及させず、権威データを読む。
  }
  let rights: LicenseRights = { entitled: null, basis: null, nft: { status: 'unknown' } };
  let budget: string | null = null;
  try {
    budget = await acquireLicenseVerifyBudget();
    if (budget) {
      const owned = await readStoreOwnership(address, productId);
      if (owned.ok) rights = await resolveLicenseRights({ address, productId, definition: d, ownership: owned.ownership });
    }
  } catch {
    // KV/RPC 不明や集計枠不足を false に変え、購入/再購入を促す波及を断つ。
  } finally {
    if (budget) {
      try { await releaseLicenseVerifyBudget(budget); } catch {
        // 解放障害を権利応答へ波及させない。KV 読込も含む処理時間より長い 60 秒 lease で回収する。
      }
    }
  }
  const response = { version: 1, address, license: { chainId: d.tokenChainId, contract: d.contract, tokenId: d.tokenId, productId },
    ...rights, checkedAt: new Date().toISOString() };
  if (rights.entitled !== null) {
    try { await kvSet(key, JSON.stringify(response), { ttlSec: 60 }); } catch {
      // キャッシュ書込の停止を確定した権利応答へ波及させない。
    }
  }
  return respond(response);
}
