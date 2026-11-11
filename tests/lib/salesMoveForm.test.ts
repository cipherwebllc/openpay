// lib/salesMoveForm (「売上をほかのウォレットへ移す」の画面の確かめ方): 上限は注文リンクと同じ定数 (server の RELAY_MAX_JPYC の
// 既定の写し) から作り、最低額は route と同じ定数。server の拒否コード → 画面の文言のキー。
import { describe, expect, it } from 'vitest';
import { zeroAddress, type Address } from 'viem';
import { ORDER_LINK_GASLESS_MAX_JPYC } from '@/lib/orderLink';
import { SALES_MOVE_MIN_VALUE_WEI } from '@/lib/relay/salesMove';
import { RelayIpRateLimitedError, RelayResponseUnknownError } from '@/lib/relay/relayResponseError';
import {
  checkDestination,
  checkMoveAmount,
  moveAllWei,
  salesMoveErrorKey,
  salesMoveLimits,
  salesMoveRetrySeconds,
} from '@/lib/salesMoveForm';

const JPYC = 10n ** 18n;
const FEE = 2n * JPYC;
const FROM: Address = '0x9999999999999999999999999999999999999999';
const BLOCKED: Address = '0x5555555555555555555555555555555555555555';

describe('salesMoveLimits / moveAllWei', () => {
  it('上限は ORDER_LINK_GASLESS_MAX_JPYC (移す額 + 利用料)・下限は SALES_MOVE_MIN_VALUE_WEI', () => {
    expect(salesMoveLimits(FEE)).toEqual({
      minMove: SALES_MOVE_MIN_VALUE_WEI,
      maxMove: ORDER_LINK_GASLESS_MAX_JPYC * JPYC - FEE,
      maxTotal: ORDER_LINK_GASLESS_MAX_JPYC * JPYC,
      minWallet: FEE + SALES_MOVE_MIN_VALUE_WEI,
    });
  });

  it('「全部移す」は ウォレット − 利用料、下限未満は null、上限で止める', () => {
    expect(moveAllWei(FEE + JPYC - 1n, FEE)).toBeNull();
    expect(moveAllWei(FEE + JPYC, FEE)).toBe(JPYC);
    expect(moveAllWei(10n * JPYC, FEE)).toBe(8n * JPYC);
    expect(moveAllWei(ORDER_LINK_GASLESS_MAX_JPYC * JPYC * 2n, FEE)).toBe(ORDER_LINK_GASLESS_MAX_JPYC * JPYC - FEE);
  });
});

describe('checkDestination / checkMoveAmount', () => {
  it('前後の空白を落とし、checksum の形にそろえる', () => {
    expect(checkDestination(`  ${BLOCKED.toLowerCase()}  `, { from: FROM, forbidden: [] })).toEqual({ ok: true, address: BLOCKED });
  });

  it('0 アドレスはいつも拒み、null の forbidden は飛ばす', () => {
    expect(checkDestination(zeroAddress, { from: FROM, forbidden: [null] })).toEqual({ ok: false, error: 'forbiddenDestination' });
    expect(checkDestination(BLOCKED, { from: FROM, forbidden: [null, BLOCKED] })).toEqual({ ok: false, error: 'forbiddenDestination' });
  });

  it('移す額は 18 桁の 10 進を正確に wei にする (丸めない)', () => {
    expect(checkMoveAmount('1.000000000000000001', { fee: FEE, balance: 100n * JPYC })).toEqual({ ok: true, wei: JPYC + 1n });
    expect(checkMoveAmount(' 12 ', { fee: FEE, balance: 100n * JPYC })).toEqual({ ok: true, wei: 12n * JPYC });
    expect(checkMoveAmount('.5', { fee: FEE, balance: 100n * JPYC })).toEqual({ ok: false, error: 'invalidAmount' });
    expect(checkMoveAmount('1.', { fee: FEE, balance: 100n * JPYC })).toEqual({ ok: false, error: 'invalidAmount' });
    expect(checkMoveAmount('-1', { fee: FEE, balance: 100n * JPYC })).toEqual({ ok: false, error: 'invalidAmount' });
  });
});

describe('salesMoveErrorKey', () => {
  it.each([
    ['rate_limited', 'rateLimited'],
    ['insufficient_balance', 'insufficient'],
    ['amount_below_minimum', 'belowMin'],
    ['value_exceeds_max', 'aboveMax'],
    ['merchant_is_sender', 'sameAsSender'],
    ['merchant_is_forwarder', 'forbiddenDestination'],
    ['merchant_is_fee_receiver', 'forbiddenDestination'],
    ['merchant_is_relayer', 'forbiddenDestination'],
    ['merchant_is_token', 'forbiddenDestination'],
    ['zero_merchant', 'forbiddenDestination'],
    ['not_found', 'unavailable'],
    ['unsupported_chain', 'unavailable'],
    ['relay_not_configured', 'unavailable'],
    ['gas_ceiling_required', 'unavailable'],
    ['kv_required', 'unavailable'],
    ['storage_unavailable', 'unavailable'],
    ['daily_budget_exceeded', 'unavailable'],
    ['balance_unavailable', 'unavailable'],
    // この端末に復旧の枠を書けないので送らなかった (第 10 回レビュー G-1)。「時間をおいて」の文言にしない。
    ['intent_storage_unavailable', 'storageUnavailable'],
    ['relay_unused', 'generic'],
    ['signature_invalid', 'generic'],
  ])('%s → %s', (code, key) => {
    expect(salesMoveErrorKey(new Error(code))).toBe(key);
  });

  it('署名の取り消し・IP の rate limit・Error でない値', () => {
    expect(salesMoveErrorKey(Object.assign(new Error('User rejected the request.'), { code: 4001 }))).toBe('rejected');
    expect(salesMoveErrorKey(new RelayIpRateLimitedError(30))).toBe('rateLimited');
    expect(salesMoveErrorKey('oops')).toBe('generic');
    expect(salesMoveErrorKey(new RelayResponseUnknownError())).toBe('generic');
  });

  it('待つ秒数は Retry-After、無ければ 60 秒', () => {
    expect(salesMoveRetrySeconds(new RelayIpRateLimitedError(30))).toBe(30);
    expect(salesMoveRetrySeconds(new RelayIpRateLimitedError(null))).toBe(60);
    expect(salesMoveRetrySeconds(new Error('rate_limited'))).toBe(60);
  });
});
