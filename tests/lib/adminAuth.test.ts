import { describe, it, expect, afterEach } from 'vitest';
import { isAdminSession, isAdminWallet } from '@/lib/adminAuth';

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

// 2026-11-25 外部レビュー #1: 運営の API は鍵の署名 (EOA) で作ったセッションだけ。スマートウォレットの署名は、署名を確かめた
// チェーンでしか持ち主と言えない (別のチェーンで同じアドレスを別の人が持てる種類がある)。
describe('isAdminSession (運営の API の認可)', () => {
  const ADMIN = '0xAbC0000000000000000000000000000000000001';
  afterEach(() => {
    delete process.env.ADMIN_WALLETS;
  });

  it('許可リストのアドレスで EOA のセッションだけ通す', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    expect(isAdminSession({ address: ADMIN, signer: 'eoa' })).toBe(true);
    expect(isAdminSession({ address: ADMIN, signer: 'contract' })).toBe(false);
    expect(isAdminSession({ address: ADMIN })).toBe(false);
  });

  it('EOA でも許可リストに無ければ通さない・許可リストが空なら誰も通さない', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    expect(isAdminSession({ address: '0x3333333333333333333333333333333333333333', signer: 'eoa' })).toBe(false);
    process.env.ADMIN_WALLETS = '';
    expect(isAdminSession({ address: ADMIN, signer: 'eoa' })).toBe(false);
  });
});
