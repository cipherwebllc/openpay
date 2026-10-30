// lib/walletErrors.ts の 2 つの拒否判定の意味と、その違いを固定する (全レビュー第 8 回 F-5 / PR-17)。
// isConnectRejection は ConnectButton と WalletBadge が別々に持っていた同じ実装を 1 つにしたもの。
// isUserRejection とは判定が違い、寄せると接続エラーの表示が変わるので別の関数にしている。
import { describe, it, expect } from 'vitest';
import { isConnectRejection, isUserRejection } from '@/lib/walletErrors';

describe('isConnectRejection (接続エラーを画面に出さない判定)', () => {
  it("'user rejected' と 'connection request reset' を含めば true (大文字小文字は問わない)", () => {
    expect(isConnectRejection(new Error('User rejected the request.'))).toBe(true);
    expect(isConnectRejection(new Error('USER REJECTED the request'))).toBe(true);
    expect(isConnectRejection(new Error('Connection request reset. Please try again.'))).toBe(true);
  });

  it("'user denied' は拒否に数えない (isUserRejection との違い)", () => {
    expect(isConnectRejection(new Error('User denied account authorization'))).toBe(false);
    expect(isConnectRejection(new Error('MetaMask Tx Signature: User denied transaction signature.'))).toBe(false);
  });

  it("'rejected the request' だけでは拒否に数えない (NativeTipForm の判定との違い)", () => {
    expect(isConnectRejection(new Error('Wallet rejected the request'))).toBe(false);
  });

  it('ほかの失敗は false (表示する)', () => {
    expect(isConnectRejection(new Error('Failed to connect: RPC down'))).toBe(false);
    expect(isConnectRejection(new Error(''))).toBe(false);
  });

  it('Error でない object も message で判定する (wagmi の error を型どおりに受ける)', () => {
    const plain = { name: 'Error', message: 'User rejected the request. Details: Connection request reset.' };
    expect(isConnectRejection(plain as Error)).toBe(true);
  });
});

describe('isUserRejection (計測で拒否と失敗を分ける判定)', () => {
  it("'user rejected'・'user denied'・'connection request reset' を含む Error は true", () => {
    expect(isUserRejection(new Error('User rejected the request.'))).toBe(true);
    expect(isUserRejection(new Error('User denied transaction signature'))).toBe(true);
    expect(isUserRejection(new Error('Connection request reset'))).toBe(true);
  });

  it('Error でないものは false (message を持つ object・文字列・null)', () => {
    expect(isUserRejection({ message: 'User rejected the request.' })).toBe(false);
    expect(isUserRejection('User rejected the request.')).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });

  it("'rejected the request' だけでは拒否に数えない", () => {
    expect(isUserRejection(new Error('Wallet rejected the request'))).toBe(false);
  });
});

describe('2 つの判定の違い', () => {
  it("'user denied' の Error: isUserRejection は true・isConnectRejection は false", () => {
    const err = new Error('User denied account authorization');
    expect(isUserRejection(err)).toBe(true);
    expect(isConnectRejection(err)).toBe(false);
  });
});
