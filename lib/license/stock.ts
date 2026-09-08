import 'server-only';

import type { PurchaseIntent, SettledPurchaseIntent } from '@/lib/x402/purchaseIntent';
import { parseLicenseDefinition } from './definition';
import { computeLicensePaymentKey } from './paymentKey';

export const LICENSE_HOLD_INDEX = 'store:license:holds';
export const LICENSE_OBLIGATION_INDEX = 'store:license:ob:index';
export const LICENSE_DUE_INDEX = 'store:license:due';
export const licenseStockKey = (id: string) => 'x402:hosted:' + id + ':license:stock';
export const licenseReservationKey = (id: string, salt: string) => 'x402:hosted:' + id + ':license:reservation:' + salt.toLowerCase();
export const licenseQuotaKey = (id: string, payer: string) => 'x402:hosted:' + id + ':license:payer:' + payer.toLowerCase();
export const licenseObligationKey = (key: string) => 'store:license:ob:' + key;

export type LicenseExpiryEvidence = { blockNumber: string; blockHash: string; timestamp: string; authorizationUsed: false };
export type LicenseHook = 'claim' | 'settle' | 'finalize' | 'fail' | 'cas';

/** 旧 Lua/引数は変更しない。検証済み license snapshot のときだけ別の EVAL に dispatch。 */
export function licenseEvalContext(intent: PurchaseIntent, hook: LicenseHook, now: number, evidence?: LicenseExpiryEvidence) {
  const definition = parseLicenseDefinition(intent.metadata.license);
  if (intent.metadata.productKind !== 'license' || !definition) throw new Error('invalid license snapshot');
  const paymentKey = intent.state === 'quoted' ? '' : computeLicensePaymentKey({
    paymentChainId: BigInt(intent.chainId), paymentToken: intent.token,
    payer: intent.claim.payer, authorizationNonce: intent.claim.nonce,
  });
  const identity = {
    intentSalt: intent.intentSalt, productId: intent.resourceId, payer: intent.payerHint.toLowerCase(),
    gen: definition.definitionHash, paymentKey,
  };
  return JSON.stringify({
    hook, now, definition, identity,
    stockKey: licenseStockKey(intent.resourceId),
    reservationKey: licenseReservationKey(intent.resourceId, intent.intentSalt),
    quotaKey: licenseQuotaKey(intent.resourceId, intent.payerHint),
    holdIndex: LICENSE_HOLD_INDEX, obligationIndex: LICENSE_OBLIGATION_INDEX, dueIndex: LICENSE_DUE_INDEX,
    obligationKey: licenseObligationKey(paymentKey),
    ...(evidence ? { evidence } : {}),
    ...(hook === 'finalize' ? { obligation: {
      version: 1, kind: 'mint', paymentKey, productId: intent.resourceId,
      license: definition, payer: intent.payerHint, intentSalt: intent.intentSalt,
      payment: intent.state === 'quoted' ? null : intent.claim,
      txHash: (intent as SettledPurchaseIntent).txHash,
      purchasedAt: (intent as SettledPurchaseIntent).settledAt,
      status: 'awaiting_finality', attempts: 0, nextAttemptAt: now,
    } } : {}),
  });
}

// Redis の script error は先行 write を巻き戻さない。旧状態遷移の write をメモリに積み、
// 在庫・JSON・key type・全コマンド引数の検証後だけ flush する。別 EVAL/非同期副作用ではない。
// 新 Lua は通常の文字列連結のみ (reverify.ts の minifier 事故対策)。
const PRELUDE =
  'local realRedis=redis; local writes={}; local unpack=unpack or table.unpack; ' +
  'local function keyType(k) local t=realRedis.call("TYPE",k); if type(t)=="table" then return t.ok end; return t end; ' +
  'local function object(raw) if type(raw)~="string" then return nil end; local ok,v=pcall(cjson.decode,raw); if ok and type(v)=="table" then return v end; return nil end; ' +
  'local function integer(n,min,max) return type(n)=="number" and n==math.floor(n) and n>=min and n<=max end; ' +
  'local ctx=object(ARGV[#ARGV]); if not ctx or not integer(ctx.now,0,9007199254740991) or type(ctx.identity)~="table" or type(ctx.definition)~="table" then return -3 end; ' +
  'local identity=ctx.identity; local d=ctx.definition; ' +
  'if not integer(d.supply,1,10000) or type(identity.intentSalt)~="string" or type(identity.gen)~="string" then return -3 end; ' +
  'local function validKey(k,t) return type(k)=="string" and (keyType(k)=="none" or keyType(k)==t) end; ' +
  'for _,k in ipairs({ctx.stockKey,ctx.reservationKey,ctx.quotaKey,ctx.obligationKey}) do if not validKey(k,"string") then return -3 end end; ' +
  'for _,k in ipairs({ctx.holdIndex,ctx.obligationIndex,ctx.dueIndex}) do if not validKey(k,"zset") then return -3 end end; ' +
  'if not validKey(KEYS[1],"string") then return -3 end; ' +
  'local current=object(realRedis.call("GET",KEYS[1])); ' +
  'if not current then return 0 end; ' +
  'if type(current.metadata)~="table" or current.metadata.productKind~="license" or type(current.metadata.license)~="table" then return -3 end; ' +
  'for k,v in pairs(d) do if current.metadata.license[k]~=v then return -3 end end; ' +
  'if current.intentSalt~=identity.intentSalt or current.resourceId~=identity.productId or string.lower(current.payerHint)~=identity.payer then return -3 end; ' +
  'local stock=object(realRedis.call("GET",ctx.stockKey)); ' +
  'if not stock or stock.gen~=identity.gen or stock.supply~=d.supply or not integer(stock.reserved,0,d.supply) or not integer(stock.sold,0,d.supply) or stock.reserved+stock.sold>d.supply then return -3 end; ' +
  'local reservationRaw=realRedis.call("GET",ctx.reservationKey); local reservation=object(reservationRaw); ' +
  'if reservationRaw and not reservation then return -3 end; ' +
  'if reservation then for k,v in pairs(identity) do if reservation[k]~=v then return -3 end end; if reservation.state~="held" and reservation.state~="sold" and reservation.state~="released" then return -3 end end; ' +
  'local quotaRaw=realRedis.call("GET",ctx.quotaKey); local quota=quotaRaw and tonumber(quotaRaw) or 0; ' +
  'if not integer(quota,0,3) then return -3 end; ' +
  'local redis={call=function(command,...) ' +
  'if command=="SET" or command=="PERSIST" or command=="ZADD" or command=="ZREM" then writes[#writes+1]={command,...}; return 1 end; ' +
  'return realRedis.call(command,...) end}; ';

const COMMIT =
  'if result~=1 and result~=2 and result~=3 then return result end; ' +
  'local function write(command,...) writes[#writes+1]={command,...} end; ' +
  'local function hold() return reservation and reservation.state=="held" and stock.reserved>0 and quota>0 end; ' +
  'if ctx.hook=="claim" then ' +
  'if result==1 then ' +
  'if reservation then return -3 end; ' +
  'if stock.reserved+stock.sold>=stock.supply then return -4 end; ' +
  'if quota>=3 then return -5 end; ' +
  'reservation=identity; reservation.state="held"; stock.reserved=stock.reserved+1; quota=quota+1; ' +
  'write("SET",ctx.reservationKey,cjson.encode(reservation)); write("SET",ctx.stockKey,cjson.encode(stock)); write("SET",ctx.quotaKey,tostring(quota)); ' +
  'elseif not reservation or (reservation.state~="held" and reservation.state~="sold") then return -3 end; ' +
  'if reservation.state=="held" then if not hold() then return -3 end; write("ZADD",ctx.holdIndex,ctx.now,identity.intentSalt) elseif stock.sold<1 then return -3 end; ' +
  'elseif ctx.hook=="settle" then if result==1 and not hold() then return -3 end; ' +
  'elseif ctx.hook=="fail" then ' +
  'if not hold() then return -3 end; write("ZADD",KEYS[2],ctx.now,identity.intentSalt); write("ZADD",ctx.holdIndex,ctx.now,identity.intentSalt); ' +
  'elseif ctx.hook=="cas" then ' +
  'if ARGV[5]==ARGV[6] then ' +
  'local e=ctx.evidence; ' +
  'if not e or e.authorizationUsed~=false or type(e.blockHash)~="string" or not string.match(e.blockHash,"^0x%x+$") or #e.blockHash~=66 or not tonumber(e.blockNumber) or not tonumber(e.timestamp) or type(current.claim)~="table" or tonumber(e.timestamp)<=tonumber(current.claim.validBefore) then return -3 end; ' +
  'if not hold() then return -3 end; reservation.state="released"; reservation.evidence=e; stock.reserved=stock.reserved-1; quota=quota-1; ' +
  'write("SET",ctx.reservationKey,cjson.encode(reservation)); write("SET",ctx.stockKey,cjson.encode(stock)); write("SET",ctx.quotaKey,tostring(quota)); write("ZREM",ctx.holdIndex,identity.intentSalt); ' +
  'else if not hold() then return -3 end; write("ZADD",ctx.holdIndex,ctx.now,identity.intentSalt) end; ' +
  'elseif ctx.hook=="finalize" then ' +
  'local ob=ctx.obligation; if type(ob)~="table" or ob.paymentKey~=identity.paymentKey or ob.txHash~=ARGV[5] or type(ob.payment)~="table" or ob.payment.nonce~=current.claim.nonce then return -3 end; ' +
  'local oldRaw=realRedis.call("GET",ctx.obligationKey); local old=object(oldRaw); ' +
  'if oldRaw and (not old or old.paymentKey~=ob.paymentKey or old.intentSalt~=ob.intentSalt or old.txHash~=ob.txHash or old.productId~=ob.productId or old.payer~=ob.payer or type(old.license)~="table" or old.license.definitionHash~=d.definitionHash or not integer(old.nextAttemptAt,0,9007199254740991)) then return -3 end; ' +
  'if old then if type(old.payment)~="table" or old.purchasedAt~=ob.purchasedAt then return -3 end; for k,v in pairs(ob.payment) do if old.payment[k]~=v then return -3 end end; for k,v in pairs(d) do if old.license[k]~=v then return -3 end end end; ' +
  'if result==1 then ' +
  'if not hold() then return -3 end; reservation.state="sold"; stock.reserved=stock.reserved-1; stock.sold=stock.sold+1; quota=quota-1; ' +
  'write("SET",ctx.reservationKey,cjson.encode(reservation)); write("SET",ctx.stockKey,cjson.encode(stock)); write("SET",ctx.quotaKey,tostring(quota)); ' +
  'elseif not reservation or reservation.state~="sold" or stock.sold<1 then return -3 end; ' +
  'if not oldRaw then write("SET",ctx.obligationKey,cjson.encode(ob)) end; ' +
  'write("ZADD",ctx.obligationIndex,ob.purchasedAt,identity.paymentKey); ' +
  'if not old or (old.status~="minted" and old.status~="needs_repair") then write("ZADD",ctx.dueIndex,old and old.nextAttemptAt or ctx.now,identity.paymentKey) end; ' +
  'write("ZREM",ctx.holdIndex,identity.intentSalt); ' +
  'else return -3 end; ' +
  // 全 write の型・引数を flush 前に検証し、後半 WRONGTYPE が部分 commit へ波及するのを断つ。
  'for _,w in ipairs(writes) do ' +
  'local t=(w[1]=="ZADD" or w[1]=="ZREM") and "zset" or "string"; if not validKey(w[2],t) then return -3 end; ' +
  'if w[1]=="ZADD" and (not tonumber(w[3]) or type(w[4])~="string") then return -3 end; ' +
  'if w[1]=="SET" then if type(w[3])~="string" then return -3 end; if string.sub(w[3],1,1)=="{" and not object(w[3]) then return -3 end end; ' +
  'end; ' +
  'for _,w in ipairs(writes) do realRedis.call(unpack(w)) end; return result; ';

export function licenseLuaVariant(digitalScript: string): string {
  return PRELUDE + 'local function transition() ' + digitalScript + ' end; local result=transition(); ' + COMMIT;
}
