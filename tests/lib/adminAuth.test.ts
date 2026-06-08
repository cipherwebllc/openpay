import { describe, it, expect, afterEach } from 'vitest';
import { isAdminWallet } from '@/lib/adminAuth';

describe('isAdminWallet (運営 admin 許可リスト)', () => {
  afterEach(() => {
    delete process.env.ADMIN_WALLETS;
  });

  it('未設定 → 全拒否 (fail-closed)', () => {
    delete process.env.ADMIN_WALLETS;
    expect(isAdminWallet('0xabc0000000000000000000000000000000000001')).toBe(false);
  });

  it('空文字 → 全拒否', () => {
    process.env.ADMIN_WALLETS = '   ';
    expect(isAdminWallet('0xabc0000000000000000000000000000000000001')).toBe(false);
  });

  it('許可リストに一致 → 許可 (大文字小文字無視)', () => {
    process.env.ADMIN_WALLETS = '0xAbC0000000000000000000000000000000000001';
    expect(isAdminWallet('0xabc0000000000000000000000000000000000001')).toBe(true);
    expect(isAdminWallet('0xABC0000000000000000000000000000000000001')).toBe(true);
  });

  it('複数 (カンマ区切り・空白許容)', () => {
    process.env.ADMIN_WALLETS =
      '0x1111111111111111111111111111111111111111, 0x2222222222222222222222222222222222222222';
    expect(isAdminWallet('0x2222222222222222222222222222222222222222')).toBe(true);
    expect(isAdminWallet('0x3333333333333333333333333333333333333333')).toBe(false);
  });
});
