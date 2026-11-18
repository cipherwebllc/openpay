// lib/walletErrors.ts の 2 つの拒否判定の意味と、その違いを固定する (全レビュー第 8 回 F-5 / PR-17)。
// isConnectRejection は ConnectButton と WalletBadge が別々に持っていた同じ実装を 1 つにしたもの。
// isUserRejection とは判定が違い、寄せると接続エラーの表示が変わるので別の関数にしている。
import { describe, it, expect } from 'vitest';
import { InternalRpcError, UnknownRpcError, UserRejectedRequestError } from 'viem';
import {
  isConnectRejection,
  isEip1193UserRejection,
  isUserRejection,
  rejectionCodeIsWalletAnswer,
} from '@/lib/walletErrors';

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

// 通常決済の会計の印の予約を解く判定 (hooks/useStandardPayment.ts の K4b) だけが使う、厳しい 2 つ。
describe('isEip1193UserRejection (ウォレットが 4001 で断ったと code で確かめられたか)', () => {
  const coded = (message: string, code: unknown, cause?: unknown) => Object.assign(new Error(message), { code, cause });

  it('ウォレットの 4001 (viem が包んだ形・そのまま・Error でない object) は true', () => {
    const raw = coded('User rejected the request.', 4001);
    expect(isEip1193UserRejection(raw)).toBe(true);
    expect(isEip1193UserRejection(new UserRejectedRequestError(raw))).toBe(true);
    expect(isEip1193UserRejection(new Error('wrapped', { cause: new UserRejectedRequestError(raw) }))).toBe(true);
    expect(isEip1193UserRejection({ code: 4001 })).toBe(true);
  });

  it('文言だけの「拒否」(code が無い) は false (isUserRejection は true)', () => {
    for (const message of ['Connection request reset', 'User rejected the request.', 'User denied transaction signature']) {
      const err = new Error(message);
      expect(isUserRejection(err)).toBe(true);
      expect(isEip1193UserRejection(err)).toBe(false);
      // viem は code の無い error を UnknownRpcError (code -1) に包む。
      expect(isEip1193UserRejection(new UnknownRpcError(err))).toBe(false);
    }
  });

  it('WalletConnect の 5000 は、viem の UserRejectedRequestError (code 4001) に包まれていても false', () => {
    const wrapped = new UserRejectedRequestError(coded('User rejected.', 5000));
    expect(wrapped.code).toBe(4001);
    expect(isEip1193UserRejection(wrapped)).toBe(false);
  });

  it('いちばん奥の error の code で決める: 4001 の奥に別の error があれば false・別の code の奥が 4001 なら true', () => {
    expect(isEip1193UserRejection(coded('User rejected the request.', 4001, coded('socket closed', -32000)))).toBe(false);
    expect(isEip1193UserRejection(coded('User rejected the request.', 4001, new Error('socket closed')))).toBe(false);
    expect(isEip1193UserRejection(coded('User rejected the request.', 4001, 'socket closed'))).toBe(false);
    expect(isEip1193UserRejection(new InternalRpcError(coded('Internal error', -32603, coded('User rejected', 4001))))).toBe(true);
  });

  it('包む側が文言から作った 4001 (wagmi の walletConnect の connector が接続・切り替えで作る形) は false', () => {
    const wrapped = new UserRejectedRequestError(new Error('Connection request reset. Please try again.'));
    expect(wrapped.code).toBe(4001);
    expect(isUserRejection(wrapped)).toBe(true);
    expect(isEip1193UserRejection(wrapped)).toBe(false);
  });

  it("数の 4001 でない code ('4001'・'ACTION_REJECTED'・-32603) は false", () => {
    expect(isEip1193UserRejection(coded('User rejected the request.', '4001'))).toBe(false);
    expect(isEip1193UserRejection(coded('user rejected action', 'ACTION_REJECTED'))).toBe(false);
    expect(isEip1193UserRejection(coded('Internal JSON-RPC error.', -32603))).toBe(false);
  });

  it('object でないもの (null・undefined・文字列・数) は false', () => {
    for (const value of [null, undefined, 'User rejected the request.', 4001]) {
      expect(isEip1193UserRejection(value)).toBe(false);
    }
  });

  it('輪になった cause・深すぎる連なりは、元の error を確かめられないので false', () => {
    const loop = coded('User rejected the request.', 4001);
    loop.cause = loop;
    expect(isEip1193UserRejection(loop)).toBe(false);
    let deep: unknown = coded('User rejected the request.', 4001);
    for (let i = 0; i < 16; i += 1) deep = new Error('wrapped', { cause: deep });
    expect(isEip1193UserRejection(deep)).toBe(false);
    // 16 段 (15 回包む) までは見る。
    let near: unknown = coded('User rejected the request.', 4001);
    for (let i = 0; i < 15; i += 1) near = new Error('wrapped', { cause: near });
    expect(isEip1193UserRejection(near)).toBe(true);
  });
});

describe('rejectionCodeIsWalletAnswer (その接続の 4001 がウォレット自身の答えか)', () => {
  it('injected と walletConnect だけ true', () => {
    expect(rejectionCodeIsWalletAnswer('injected')).toBe(true);
    expect(rejectionCodeIsWalletAnswer('walletConnect')).toBe(true);
  });

  it('Coinbase Wallet SDK (SDK が 4001 を作る)・知らない接続・未接続は false', () => {
    expect(rejectionCodeIsWalletAnswer('coinbaseWallet')).toBe(false);
    expect(rejectionCodeIsWalletAnswer('mock')).toBe(false);
    expect(rejectionCodeIsWalletAnswer(undefined)).toBe(false);
  });
});
