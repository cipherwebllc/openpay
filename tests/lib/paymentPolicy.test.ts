import { describe, it, expect } from 'vitest';
import { paymentPolicyKey } from '@/lib/paymentPolicy';

describe('paymentPolicyKey', () => {
  it('standard は gasMode に関係なく standard', () => {
    expect(paymentPolicyKey('standard', 'customer')).toBe('standard');
    expect(paymentPolicyKey('standard', 'merchant')).toBe('standard');
  });

  it('gasless + customer → gaslessCustomerGas', () => {
    expect(paymentPolicyKey('gasless', 'customer')).toBe('gaslessCustomerGas');
  });

  it('gasless + merchant → gaslessMerchantGas', () => {
    expect(paymentPolicyKey('gasless', 'merchant')).toBe('gaslessMerchantGas');
  });
});
