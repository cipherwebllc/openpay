// lib/walletRejectionProof.ts: 通常決済の会計の印の予約を解く判定 (hooks/useStandardPayment.ts の K4b) だけが使う、厳しい 2 つ。
// lib/walletErrors.ts の isUserRejection (文言で決める・計測と表示用) との違いも固定する。
import { describe, it, expect } from 'vitest';
import { InternalRpcError, UnknownRpcError, UserRejectedRequestError } from 'viem';
import { isUserRejection } from '@/lib/walletErrors';
import { isEip1193UserRejection, rejectionCodeIsWalletAnswer } from '@/lib/walletRejectionProof';

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

  it('いちばん奥の error の code が 4001 でなければ false (4001 の奥に別の error がある)', () => {
    expect(isEip1193UserRejection(coded('User rejected the request.', 4001, coded('socket closed', -32000)))).toBe(false);
    expect(isEip1193UserRejection(coded('User rejected the request.', 4001, new Error('socket closed')))).toBe(false);
    expect(isEip1193UserRejection(coded('User rejected the request.', 4001, 'socket closed'))).toBe(false);
  });

  it('途中に 4001 でない code があれば、いちばん奥が 4001 でも false', () => {
    const raw = coded('User rejected the request.', 4001);
    expect(isEip1193UserRejection(new InternalRpcError(coded('Internal error', -32603, raw)))).toBe(false);
    // ウォレットが投げた error 自身に code が無い (cause の奥に 4001) と、viem は UnknownRpcError (code -1) に包む。
    expect(isEip1193UserRejection(new UnknownRpcError(new Error('Request failed', { cause: raw })))).toBe(false);
    expect(isEip1193UserRejection(coded('Request failed', 'ERR_FAILED', raw))).toBe(false);
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
