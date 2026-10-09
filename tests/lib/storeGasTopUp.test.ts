// 「接続中のウォレットから補充」の操作の記録 (lib/storeGasTopUp.ts): タブをまたいで共有し、届く途中の補充の宛先を
// 消させない・同じ宛先への補充を重ねない・自分の記録だけを片付ける・壊れた記録や切れた記録で鍵を永久に消せなくしない。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import {
  STORE_GAS_TOPUP_KEY,
  TOPUP_APPROVAL_TTL_MS,
  TOPUP_SENT_KEEP_MS,
  TOPUP_SENT_TTL_MS,
  attachStoreGasTopUpHash,
  finishStoreGasTopUp,
  liveStoreGasTopUps,
  noteStoreGasTopUpSender,
  reserveStoreGasTopUp,
  resolveStoreGasTopUp,
  staleStoreGasTopUps,
  touchStoreGasTopUp,
} from '@/lib/storeGasTopUp';

const A = '0x0000000000000000000000000000000000000abc' as const;
const B = '0x0000000000000000000000000000000000000def' as const;
const TX = `0x${'ab'.repeat(32)}` as const;
// 実際の時計に合わせる (先の時刻の記録は捨てるため)
const T0 = Date.now();

function reserve(address: `0x${string}` = A, now = T0) {
  const r = reserveStoreGasTopUp(address, 80002, now);
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}

describe('storeGasTopUp', () => {
  beforeEach(() => window.localStorage.clear());

  it('同じ宛先への補充は重ねない (別のタブを含む)・別の宛先は置ける', () => {
    reserve(A);
    expect(reserveStoreGasTopUp(A, 80002, T0)).toEqual({ ok: false, reason: 'busy' });
    expect(reserveStoreGasTopUp(B, 80002, T0).ok).toBe(true);
    expect(liveStoreGasTopUps(A, T0)).toHaveLength(1);
  });

  it('自分の記録だけを片付ける (別のタブの記録を消さない)', () => {
    const a = reserve(A);
    const b = reserve(B);
    finishStoreGasTopUp(a);
    expect(liveStoreGasTopUps(A, T0)).toHaveLength(0);
    expect(liveStoreGasTopUps(B, T0).map((r) => r.id)).toEqual([b]);
    finishStoreGasTopUp('nope');
    expect(liveStoreGasTopUps(B, T0)).toHaveLength(1);
  });

  it('確認中の記録は 30 分で切れる (タブを閉じた確認で鍵を永久に消せなくしない)・確認中のタブは延ばせる', () => {
    const id = reserve(A, T0);
    expect(liveStoreGasTopUps(A, T0 + TOPUP_APPROVAL_TTL_MS - 1)).toHaveLength(1);
    expect(liveStoreGasTopUps(A, T0 + TOPUP_APPROVAL_TTL_MS)).toHaveLength(0);
    touchStoreGasTopUp(id, T0 + 20 * 60_000);
    expect(liveStoreGasTopUps(A, T0 + TOPUP_APPROVAL_TTL_MS + 5 * 60_000)).toHaveLength(1);
    // 切れた記録は次に置くときに掃除し、同じ宛先にもう一度置ける
    expect(reserveStoreGasTopUp(A, 80002, T0 + 2 * TOPUP_APPROVAL_TTL_MS).ok).toBe(true);
  });

  it('送った記録は 1 日残る (確認中の 30 分では切れない)・確認中の記録が切れて消えていても置き直す', () => {
    const id = reserve(A, T0);
    attachStoreGasTopUpHash({ id, address: A, chainId: 80002 }, TX, T0 + 1_000);
    expect(liveStoreGasTopUps(A, T0 + 2 * TOPUP_APPROVAL_TTL_MS)[0]).toMatchObject({ id, hash: TX, chainId: 80002 });
    expect(liveStoreGasTopUps(A, T0 + 1_000 + TOPUP_SENT_TTL_MS)).toHaveLength(0);
    window.localStorage.clear();
    attachStoreGasTopUpHash({ id: 'x', address: A, chainId: 43113 }, TX, T0);
    expect(liveStoreGasTopUps(A, T0)[0]).toMatchObject({ id: 'x', hash: TX, chainId: 43113 });
  });

  it('壊れた記録・形の違う記録は捨てる (鍵を永久に消せなくしない)', () => {
    window.localStorage.setItem(STORE_GAS_TOPUP_KEY, '{broken');
    expect(liveStoreGasTopUps(A, T0)).toEqual([]);
    expect(reserveStoreGasTopUp(A, 80002, T0).ok).toBe(true);
    window.localStorage.setItem(STORE_GAS_TOPUP_KEY, JSON.stringify({ x: { id: 'x', address: 'nope', chainId: 1, at: T0 } }));
    expect(liveStoreGasTopUps(A, T0)).toEqual([]);
  });

  it('保存できないときは置かない (記録なしでは別のタブの削除を止められない = 補充しない)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(reserveStoreGasTopUp(A, 80002, T0)).toEqual({ ok: false, reason: 'storage' });
    } finally {
      spy.mockRestore();
    }
  });

  it('時刻が数でない・無限大・先の時刻の記録は捨てる (切れずに残り続けない)', () => {
    window.localStorage.setItem(
      STORE_GAS_TOPUP_KEY,
      '{"a":{"id":"a","address":"' + A + '","chainId":80002,"at":1e309},' +
        '"b":{"id":"b","address":"' + A + '","chainId":80002,"at":' + (T0 + 60 * 60_000) + '}}',
    );
    expect(liveStoreGasTopUps(A, T0)).toEqual([]);
    expect(reserveStoreGasTopUp(A, 80002, T0).ok).toBe(true);
  });

  it('送った記録は 1 日たっても捨てず「結果を確かめられていない」として 7 日残す・新しい補充は止めない (A5/G3)', () => {
    const id = reserve(A, T0);
    attachStoreGasTopUpHash({ id, address: A, chainId: 80002, from: B, nonce: 7 }, TX, T0);
    expect(liveStoreGasTopUps(A, T0)[0]).toMatchObject({ from: B, nonce: 7 });
    const later = T0 + TOPUP_SENT_TTL_MS;
    expect(liveStoreGasTopUps(A, later)).toHaveLength(0);
    expect(staleStoreGasTopUps(A, later)).toEqual([expect.objectContaining({ id, hash: TX, from: B, nonce: 7 })]);
    // 新しい補充は置ける。置いても (切れた記録の掃除で) 古い記録は消えない
    expect(reserveStoreGasTopUp(A, 80002, later).ok).toBe(true);
    expect(staleStoreGasTopUps(A, later).map((r) => r.id)).toEqual([id]);
    // 7 日で捨てる (壊れた記録・確かめられない記録で、注意が永久に残らない)
    const dropAt = T0 + TOPUP_SENT_KEEP_MS;
    expect(staleStoreGasTopUps(A, dropAt)).toHaveLength(0);
    reserveStoreGasTopUp(B, 80002, dropAt);
    expect(window.localStorage.getItem(STORE_GAS_TOPUP_KEY)).not.toContain(`"${id}"`);
  });

  it('送り手と nonce は後から足せる (時刻は延ばさない・送った記録だけ)', () => {
    const id = reserve(A, T0);
    noteStoreGasTopUpSender(id, { from: B, nonce: 3 }, T0 + 1_000);
    expect(liveStoreGasTopUps(A, T0 + 1_000)[0].nonce).toBeUndefined();
    attachStoreGasTopUpHash({ id, address: A, chainId: 80002, from: B }, TX, T0);
    noteStoreGasTopUpSender(id, { from: B, nonce: 3 }, T0 + 1_000);
    expect(liveStoreGasTopUps(A, T0 + 1_000)[0]).toMatchObject({ at: T0, hash: TX, from: B, nonce: 3 });
  });

  it('tx を記録に残せなかったら false を返す (呼び出し側が画面で見張る)', () => {
    const id = reserve(A);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(attachStoreGasTopUpHash({ id, address: A, chainId: 80002 }, TX, T0)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(attachStoreGasTopUpHash({ id, address: A, chainId: 80002 }, TX, T0)).toBe(true);
  });
});

// 送った補充の結果の証拠 (receipt・送り手の nonce の消費)。時間の経過だけで「入らなかった」と決めない (A5/G3)。
describe('resolveStoreGasTopUp', () => {
  const REC = { id: 'r', address: A, chainId: 80002, at: T0, hash: TX } as const;
  function client(o: { receipt?: 'found' | 'down'; count?: number; tx?: { nonce: number } | null }) {
    return {
      getTransactionReceipt: vi.fn(async () => {
        if (o.receipt === 'down') throw new Error('rpc down');
        if (o.receipt !== 'found') throw new TransactionReceiptNotFoundError({ hash: TX });
        return { status: 'success' as const, transactionHash: TX };
      }),
      getTransactionCount: vi.fn(async () => {
        if (o.count === undefined) throw new Error('rpc down');
        return o.count;
      }),
      getTransaction: vi.fn(async () => {
        if (!o.tx) throw new TransactionNotFoundError({ hash: TX });
        return { nonce: o.tx.nonce, from: B };
      }),
    };
  }

  it('receipt があれば結果 (送り手が分からなくても)', async () => {
    const c = client({ receipt: 'found' });
    await expect(resolveStoreGasTopUp(c, REC)).resolves.toEqual({
      kind: 'receipt',
      receipt: { status: 'success', transactionHash: TX },
    });
    expect(c.getTransactionCount).not.toHaveBeenCalled();
  });

  it('receipt が無く、送り手の nonce が消費されていれば置き換え確定 (元の tx はもう入らない)', async () => {
    await expect(resolveStoreGasTopUp(client({ count: 8 }), { ...REC, from: B, nonce: 7 })).resolves.toEqual({
      kind: 'replaced',
    });
    // nonce がまだなら途中のまま
    await expect(resolveStoreGasTopUp(client({ count: 7 }), { ...REC, from: B, nonce: 7 })).resolves.toEqual({
      kind: 'pending',
    });
  });

  it('nonce が分からなければ tx を読んで覚える (読めなければ途中のまま)', async () => {
    const c = client({ count: 7, tx: { nonce: 7 } });
    await expect(resolveStoreGasTopUp(c, { ...REC, from: B })).resolves.toEqual({ kind: 'pending', nonce: 7 });
    expect(c.getTransactionCount).toHaveBeenCalledWith({ address: B, blockTag: 'latest' });
    await expect(resolveStoreGasTopUp(client({ count: 8, tx: { nonce: 7 } }), { ...REC, from: B })).resolves.toEqual({
      kind: 'replaced',
    });
    await expect(resolveStoreGasTopUp(client({ count: 8, tx: null }), { ...REC, from: B })).resolves.toEqual({
      kind: 'pending',
    });
    // 送り手が分からなければ nonce は見ない
    await expect(resolveStoreGasTopUp(client({ count: 8, tx: { nonce: 7 } }), REC)).resolves.toEqual({ kind: 'pending' });
  });

  it('RPC の障害 (receipt を読めない・nonce を読めない) は置き換えと見なさない', async () => {
    await expect(resolveStoreGasTopUp(client({ receipt: 'down', count: 8 }), { ...REC, from: B, nonce: 7 })).resolves.toEqual(
      { kind: 'pending' },
    );
    await expect(resolveStoreGasTopUp(client({}), { ...REC, from: B, nonce: 7 })).resolves.toEqual({ kind: 'pending' });
  });
});
