// 「接続中のウォレットから補充」の操作の記録 (lib/storeGasTopUp.ts): タブをまたいで共有し、届く途中の補充の宛先を
// 消させない・同じ宛先への補充を重ねない・自分の記録だけを片付ける・壊れた記録や切れた記録で鍵を永久に消せなくしない。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STORE_GAS_TOPUP_KEY,
  TOPUP_APPROVAL_TTL_MS,
  TOPUP_SENT_TTL_MS,
  attachStoreGasTopUpHash,
  finishStoreGasTopUp,
  liveStoreGasTopUps,
  reserveStoreGasTopUp,
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
