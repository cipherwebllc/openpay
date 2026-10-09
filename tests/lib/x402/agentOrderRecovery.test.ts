import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { encodeAgentCart } from '@/lib/agentOrder';
import {
  createAgentOrderSnapshot,
  parseAgentOrderSnapshot,
  parseBoundAgentOrderSnapshot,
} from '@/lib/x402/agentOrderRecovery';
import { paymentRedeliveryIdentity } from '@/lib/x402/paymentRedelivery';

const PAYER = getAddress('0x1111111111111111111111111111111111111111');
const MERCHANT = getAddress('0x4444444444444444444444444444444444444444');
const FEE_RECEIVER = getAddress(
  '0x5555555555555555555555555555555555555555',
);
const CHAIN_ID = 80002;
const DECIMALS = 18;
const TOTAL = 1600n * 10n ** 18n;
const CART = encodeAgentCart([
  { id: 'karaage', qty: 2 },
  { id: 'beer', qty: 1 },
]);
const RESOURCE = (() => {
  const params = new URLSearchParams();
  params.set('h', 'shop');
  params.set('cart', CART);
  params.set('table', 'A5');
  params.set('pickupAt', '1800000000000');
  return `https://open-pay.jp/api/agent-order/pay?${params.toString()}`;
})();

function payload(signature = `0x${'01'.repeat(32)}${'02'.repeat(32)}1b`) {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:80002',
    payload: {
      signature,
      authorization: {
        from: PAYER,
        validAfter: '0',
        validBefore: '9999999999',
        intentSalt: `0x${'22'.repeat(32)}`,
      },
    },
  };
}

function facilitatorBody(
  overrides: {
    paymentPayload?: ReturnType<typeof payload>;
    resource?: string;
    merchant?: string;
    merchantValue?: string;
  } = {},
) {
  return {
    x402Version: 1,
    paymentPayload: overrides.paymentPayload ?? payload(),
    paymentRequirements: {
      network: 'eip155:80002',
      resource: overrides.resource ?? RESOURCE,
      extra: {
        openpay: {
          merchant: overrides.merchant ?? MERCHANT,
          merchantValue: overrides.merchantValue ?? TOTAL.toString(),
          feeReceiver: FEE_RECEIVER,
          feeValue: (16n * 10n ** 18n).toString(),
        },
      },
    },
  };
}

function snapshot() {
  return createAgentOrderSnapshot({
    handle: 'shop',
    merchant: MERCHANT,
    payer: PAYER,
    chainId: CHAIN_ID,
    decimals: DECIMALS,
    items: [
      { name: '唐揚げ', qty: 2, price: '500' },
      { name: 'ビール', qty: 1, price: '600' },
    ],
    totalMinor: TOTAL,
    resource: RESOURCE,
    table: 'A5',
    pickupAt: 1800000000000,
  });
}

function bound(
  context: unknown,
  body = facilitatorBody(),
  identity = paymentRedeliveryIdentity(body.paymentPayload)!,
) {
  return parseBoundAgentOrderSnapshot({
    context,
    facilitatorBody: body,
    resource: RESOURCE,
    identity,
  });
}

describe('agent-order redelivery snapshot', () => {
  it('server snapshot と signed body/resource/identity が完全一致すれば復元する', () => {
    const value = snapshot();
    expect(value).not.toBeNull();
    expect(bound(value)).toEqual(value);
  });

  it('deployment decimals・item price・再計算 total の汚染を拒否する', () => {
    const value = snapshot()!;
    expect(parseAgentOrderSnapshot({ ...value, decimals: 17 })).toBeNull();
    expect(
      parseAgentOrderSnapshot({
        ...value,
        items: [
          { name: '唐揚げ', qty: 2, price: '0' },
          value.items[1],
        ],
      }),
    ).toBeNull();
    expect(
      parseAgentOrderSnapshot({
        ...value,
        items: [
          { name: '唐揚げ', qty: 2, price: '0500' },
          value.items[1],
        ],
      }),
    ).toBeNull();
    expect(
      parseAgentOrderSnapshot({ ...value, totalMinor: (TOTAL + 1n).toString() }),
    ).toBeNull();
  });

  it('body の merchant/payer/amount と incoming credential の混在を拒否する', () => {
    const value = snapshot()!;
    expect(
      bound(
        value,
        facilitatorBody({
          merchant: '0x6666666666666666666666666666666666666666',
        }),
      ),
    ).toBeNull();
    expect(
      bound(
        value,
        facilitatorBody({ merchantValue: (TOTAL + 1n).toString() }),
      ),
    ).toBeNull();

    const otherPayload = payload(
      `0x${'03'.repeat(32)}${'04'.repeat(32)}1b`,
    );
    const otherIdentity = paymentRedeliveryIdentity(otherPayload)!;
    expect(bound(value, facilitatorBody(), otherIdentity)).toBeNull();

    const wrongPayerBody = facilitatorBody();
    wrongPayerBody.paymentPayload.payload.authorization.from =
      '0x7777777777777777777777777777777777777777';
    const wrongPayerIdentity = paymentRedeliveryIdentity(
      wrongPayerBody.paymentPayload,
    )!;
    expect(bound(value, wrongPayerBody, wrongPayerIdentity)).toBeNull();
  });

  it('resource と snapshot の handle/table/pickup/cart qty 不一致を拒否する', () => {
    const value = snapshot()!;
    expect(bound({ ...value, handle: 'other' })).toBeNull();
    expect(bound({ ...value, table: 'B6' })).toBeNull();
    expect(bound({ ...value, pickupAt: 1800000060000 })).toBeNull();
    expect(
      bound({
        ...value,
        items: [
          { ...value.items[0], qty: 1, price: '1000' },
          value.items[1],
        ],
      }),
    ).toBeNull();
    expect(bound({ ...value, unexpected: true })).toBeNull();
  });
});
