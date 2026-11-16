// forwarder の nonce の式 (lib/relay/forwarderIntent の buildForwarderNonce) の軽い差し替え。
// 入力 (from・merchant・merchantValue・feeReceiver・feeValue・validAfter・validBefore・intentSalt・chainId・forwarder) の組ごとに
// 決まった 32 byte の値を返す: 1 つでも違えば別の値・同じなら同じ値 (一致の判定にとっては本物の hash と同じ)。
// 本物の keccak を 1,230 回 × 組の数だけ計算すると coverage つきの CI で遅いので、見張りの回し方・一致しない順を見るテストで使う。
// 本物の式と一致の判定が合うことは、本物で計算するテスト (tests/lib/qrSaleHistory.test.ts の一致の場面・parity) が確かめる。
// vi.mock の factory から読むので、このリポの module を import しない。

type NonceInput = {
  from: string;
  merchant: string;
  merchantValue: bigint;
  feeReceiver: string;
  feeValue: bigint;
  validAfter: bigint;
  validBefore: bigint;
  intentSalt: string;
};

export function createFakeForwarderNonce(): (p: NonceInput, chainId: number, forwarder: string) => `0x${string}` {
  const ids = new Map<string, `0x${string}`>();
  return (p, chainId, forwarder) => {
    const key = [
      p.from, p.merchant, p.merchantValue, p.feeReceiver, p.feeValue, p.validAfter, p.validBefore, p.intentSalt,
      chainId, forwarder,
    ]
      .map((v) => String(v).toLowerCase())
      .join('|');
    let id = ids.get(key);
    if (!id) {
      id = `0x${(ids.size + 1).toString(16).padStart(64, '0')}`;
      ids.set(key, id);
    }
    return id;
  };
}
