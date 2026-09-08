import 'server-only';

import { kvEval } from '@/lib/kv';
import type { HostedProduct, HostedContent } from '@/lib/x402/hostedStore';
import { createLicenseDefinition, type LicenseTermsInput } from './definition';
import { licenseDeployment, licenseSellerAllowed } from './config';
import { LICENSE_DUE_INDEX, licenseStockKey } from './stock';

export const LICENSE_REGISTRATION_INDEX = 'store:license:registration:index';
export const licenseRegistrationJobKey = (id: string) => 'store:license:registration:' + id;

// 型/数値/JSON の確認を全 write より前に完了する (Redis script は rollback しない)。
const CREATE_LICENSE =
  'local function kt(k) local t=redis.call("TYPE",k); if type(t)=="table" then return t.ok end; return t end; ' +
  'for _,i in ipairs({1,2,4,5}) do if kt(KEYS[i])~="none" then return -3 end end; ' +
  'if kt(KEYS[3])~="none" and kt(KEYS[3])~="list" then return -4 end; ' +
  'for _,i in ipairs({6,7}) do if kt(KEYS[i])~="none" and kt(KEYS[i])~="zset" then return -4 end end; ' +
  'local cap=tonumber(ARGV[4]); local now=tonumber(ARGV[7]); if not cap or cap<1 or not now then return -4 end; ' +
  'for _,i in ipairs({1,2,5,6}) do local ok,v=pcall(cjson.decode,ARGV[i]); if not ok or type(v)~="table" then return -4 end end; ' +
  'if redis.call("LLEN",KEYS[3])>=cap then return -2 end; ' +
  'redis.call("SET",KEYS[1],ARGV[1]); redis.call("SET",KEYS[2],ARGV[2]); redis.call("LPUSH",KEYS[3],ARGV[3]); ' +
  'redis.call("SET",KEYS[4],ARGV[5]); redis.call("SET",KEYS[5],ARGV[6]); ' +
  'redis.call("ZADD",KEYS[6],now,ARGV[3]); redis.call("ZADD",KEYS[7],now,"registration:"..ARGV[3]); return 1; ';

export async function createLicenseProduct(product: HostedProduct, content: HostedContent, terms: LicenseTermsInput | undefined, cap: number) {
  const deployment = licenseDeployment();
  if (!terms || !deployment || !licenseSellerAllowed(product.owner) || product.usdcEnabled || product.contentKind !== 'text' || BigInt(product.priceJpyc) < 1000n) {
    return { ok: false as const, reason: 'conflict' as const };
  }
  const license = createLicenseDefinition(product.id, terms, deployment.chainId, deployment.contract);
  const next: HostedProduct = { ...product, productKind: 'license', license, saleActive: false, registration: { status: 'pending', attempts: 0 } };
  const job = { version: 1, kind: 'registration', productId: product.id, license, status: 'pending', attempts: 0, nextAttemptAt: product.createdAt };
  const r = await kvEval<number>(CREATE_LICENSE, [
    'x402:hosted:' + product.id, license.contentRef, 'x402:hosted:owner:' + product.owner.toLowerCase(),
    licenseStockKey(product.id), licenseRegistrationJobKey(product.id), LICENSE_REGISTRATION_INDEX, LICENSE_DUE_INDEX,
  ], [JSON.stringify(next), JSON.stringify(content), product.id, String(cap),
    JSON.stringify({ supply: license.supply, reserved: 0, sold: 0, gen: license.definitionHash }), JSON.stringify(job), String(product.createdAt)]);
  if (!r.ok || r.value === -4) return { ok: false as const, reason: 'storage' as const };
  if (r.value === -2) return { ok: false as const, reason: 'too_many' as const };
  if (r.value !== 1) return { ok: false as const, reason: 'conflict' as const };
  return { ok: true as const, product: next };
}
