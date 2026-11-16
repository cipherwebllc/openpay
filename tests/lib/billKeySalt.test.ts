import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { BILL_KEY_TAG, billKeyIntent, billKeySalt } from '@/lib/relay/billKeySalt';
import { buildForwarderNonce, type ForwarderSettleParams } from '@/lib/relay/forwarderIntent';

// 期待値は、実装 (viem) と別の道具 (Foundry の cast) で計算した:
//   TAG  = cast keccak "openpay.bill-key.v1"
//   salt = cast keccak $(cast abi-encode "f(bytes32,string)" $TAG "<bill key>")
// 払う側とお店の端末が同じ値を作ることを、この vector で固定する (お店の端末は K2 で同じ関数を import する)。
const TAG = '0x08bdd09c9e48e277d98780b5c95461c094c5c00794ae799a9e9eb73815490796';
const VECTORS: [string, Hex][] = [
  ['AAAAAAAAAAAAAAAAAAAAAA', '0xd47315f7150d1e487d4e9fec2a1e61d28c55443e29061299c54f5205dee83406'],
  ['Zm9vYmFyYmF6cXV4MTIzNA', '0x69f93cd3b5a483ef1d119580ad5aff6b3b657cf379145e02b344199ea334c499'],
  ['a-b_c-d_e-f_g-h_0123Zz', '0xe374137dba2c694dc1107b09fdd263fc9a81c40e9652947177487d46e50b9ea4'],
];

// tests/lib/forwarderIntent.test.ts (= contracts/test/Eip3009Forwarder.t.sol の golden vector) と同じ固定の入力。
const GOLDEN: Omit<ForwarderSettleParams, 'intentSalt'> = {
  from: '0x1111111111111111111111111111111111111111',
  merchant: '0x2222222222222222222222222222222222222222',
  merchantValue: 1000n * 10n ** 18n,
  feeReceiver: '0x3333333333333333333333333333333333333333',
  feeValue: 2n * 10n ** 18n,
  validAfter: 0n,
  validBefore: 1_000_000_000_000n,
};
const CHAIN = 80002;
const FORWARDER: Address = '0x4444444444444444444444444444444444444444';

describe('billKeySalt', () => {
  it('BILL_KEY_TAG は keccak256("openpay.bill-key.v1")', () => {
    expect(BILL_KEY_TAG).toBe(keccak256(toHex('openpay.bill-key.v1')));
    expect(BILL_KEY_TAG).toBe(TAG);
  });

  it.each(VECTORS)('golden vector: %s', (billKey, salt) => {
    expect(billKeySalt(billKey)).toBe(salt);
  });

  it('encode の形: abi.encode(bytes32 TAG, string bill key) = TAG ‖ 0x40 ‖ 長さ 22 ‖ utf8 の 22 byte (右を 0 で埋める)', () => {
    const utf8 = '5a6d3976596d4679596d4636635856344d54497a4e41'; // "Zm9vYmFyYmF6cXV4MTIzNA"
    const encoded = `0x${TAG.slice(2)}${'40'.padStart(64, '0')}${'16'.padStart(64, '0')}${utf8.padEnd(64, '0')}` as Hex;
    expect(toHex('Zm9vYmFyYmF6cXV4MTIzNA')).toBe(`0x${utf8}`);
    expect(billKeySalt('Zm9vYmFyYmF6cXV4MTIzNA')).toBe(keccak256(encoded));
  });

  it('forwarder の nonce の golden vector (bill key から作った intentSalt を入れた例・cast で計算)', () => {
    const intentSalt = billKeySalt('Zm9vYmFyYmF6cXV4MTIzNA')!;
    expect(buildForwarderNonce({ ...GOLDEN, intentSalt }, CHAIN, FORWARDER)).toBe(
      '0x7ad3d0a6ed8d157e19aeb7b60e78306e762e109f03a4313e492b2da5421b38c2',
    );
  });

  it('salt は 32 byte の hex で、0 ではない (契約は intentSalt == 0 を拒む)', () => {
    for (const [billKey] of VECTORS) {
      const salt = billKeySalt(billKey)!;
      expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
      expect(BigInt(salt)).not.toBe(0n);
    }
  });

  it('同じ bill key は同じ salt・違う bill key は違う salt (大文字と小文字も区別する)', () => {
    expect(billKeySalt('Zm9vYmFyYmF6cXV4MTIzNA')).toBe(billKeySalt('Zm9vYmFyYmF6cXV4MTIzNA'));
    expect(billKeySalt('zm9vYmFyYmF6cXV4MTIzNA')).not.toBe(billKeySalt('Zm9vYmFyYmF6cXV4MTIzNA'));
    expect(new Set(VECTORS.map(([billKey]) => billKeySalt(billKey))).size).toBe(VECTORS.length);
  });

  it('文字列をそのまま hash する: base64 として同じ 16 byte になる 2 つの文字列 (末尾の余りの 4 bit だけが違う) は別の salt', () => {
    // 22 字 = 132 bit で、16 byte = 128 bit。最後の字の下 4 bit は decode で捨てられるので、A と B は同じ byte 列になる。
    const a = 'AAAAAAAAAAAAAAAAAAAAAA';
    const b = 'AAAAAAAAAAAAAAAAAAAAAB';
    expect(Buffer.from(a, 'base64url').equals(Buffer.from(b, 'base64url'))).toBe(true);
    expect(billKeySalt(a)).not.toBeNull();
    expect(billKeySalt(b)).not.toBeNull();
    expect(billKeySalt(a)).not.toBe(billKeySalt(b));
  });

  it.each([
    ['空', ''],
    ['21 字', 'Zm9vYmFyYmF6cXV4MTIzN'],
    ['23 字', 'Zm9vYmFyYmF6cXV4MTIzNAA'],
    ['44 字', 'Zm9vYmFyYmF6cXV4MTIzNAZm9vYmFyYmF6cXV4MTIzNA'],
    ['+ 入り (base64 の標準形)', 'Zm9vYmFyYmF6cXV4MTIzN+'],
    ['/ 入り', 'Zm9vYmFyYmF6cXV4MTIzN/'],
    ['= 入り (padding)', 'Zm9vYmFyYmF6cXV4MTIzN='],
    ['空白入り', 'Zm9vYmFyYmF6cXV4MTIzN '],
    ['前に空白', ' Zm9vYmFyYmF6cXV4MTIzNA'],
    ['後ろに改行', 'Zm9vYmFyYmF6cXV4MTIzNA\n'],
    ['22 字で後ろが改行', 'Zm9vYmFyYmF6cXV4MTIzN\n'],
    ['ASCII でない字入り', 'Zm9vYmFyYmF6cXV4MTIzNあ'],
    ['全角の英数', 'ＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡ'],
    ['% 入り', 'Zm9vYmFyYmF6cXV4MTI%2B'],
    ['. 入り', 'Zm9vYmFyYmF6cXV4MTIzN.'],
    ['32 byte の hex (intentSalt そのもの)', `0x${'ab'.repeat(32)}`],
  ])('形の違う文字列は null (throw しない): %s', (_label, value) => {
    expect(billKeySalt(value)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['数', 1234567890123456789012],
    ['真偽', true],
    ['22 字の配列', Array.from('Zm9vYmFyYmF6cXV4MTIzNA')],
    ['正しい文字列 1 つの配列', ['Zm9vYmFyYmF6cXV4MTIzNA']],
    ['object', { toString: () => 'Zm9vYmFyYmF6cXV4MTIzNA' }],
  ])('文字列でない値は null (throw しない): %s', (_label, value) => {
    expect(billKeySalt(value)).toBeNull();
  });
});

describe('billKeyIntent (払う側の 1 回の署名に使う intentSalt と有効期限)', () => {
  const KEY = 'Zm9vYmFyYmF6cXV4MTIzNA';
  const OTHER = 'AAAAAAAAAAAAAAAAAAAAAA';

  it('最初の署名: 有効期限はそのまま・intentSalt は billKeySalt', () => {
    const used = new Set<string>();
    expect(billKeyIntent(KEY, 1000n, used)).toEqual({ intentSalt: billKeySalt(KEY), validBefore: 1000n });
  });

  it('同じ bill key・同じ有効期限の署名し直し: 1 秒ずつ先へずらす (同じ nonce を 2 度作らない)', () => {
    const used = new Set<string>();
    expect(billKeyIntent(KEY, 1000n, used)?.validBefore).toBe(1000n);
    expect(billKeyIntent(KEY, 1000n, used)?.validBefore).toBe(1001n);
    expect(billKeyIntent(KEY, 1000n, used)?.validBefore).toBe(1002n);
    // 次の秒に署名し直しても、前にずらして使った値とは重ならない。
    expect(billKeyIntent(KEY, 1001n, used)?.validBefore).toBe(1003n);
    const nonces = [1000n, 1001n, 1002n, 1003n].map((validBefore) =>
      buildForwarderNonce({ ...GOLDEN, validBefore, intentSalt: billKeySalt(KEY)! }, CHAIN, FORWARDER));
    expect(new Set(nonces).size).toBe(4);
  });

  it('秒が進んだ署名し直し: 有効期限はそのまま (ずらさない)', () => {
    const used = new Set<string>();
    billKeyIntent(KEY, 1000n, used);
    expect(billKeyIntent(KEY, 1007n, used)?.validBefore).toBe(1007n);
  });

  it('端末の時計が戻った後の署名し直し: 戻った後の値をそのまま使う (前の値に引きずられて先へ行かない)', () => {
    const used = new Set<string>();
    // 時計が 1 時間進んでいた端末で 1 回署名した後、時計を直して署名し直す。
    billKeyIntent(KEY, 1000n + 3600n, used);
    expect(billKeyIntent(KEY, 1000n, used)?.validBefore).toBe(1000n);
  });

  it('別の bill key は、同じ有効期限でもずらさない', () => {
    const used = new Set<string>();
    billKeyIntent(KEY, 1000n, used);
    expect(billKeyIntent(OTHER, 1000n, used)).toEqual({ intentSalt: billKeySalt(OTHER), validBefore: 1000n });
  });

  it('別の画面 (別の used) は、同じ bill key・同じ有効期限でもずらさない', () => {
    billKeyIntent(KEY, 1000n, new Set<string>());
    expect(billKeyIntent(KEY, 1000n, new Set<string>())?.validBefore).toBe(1000n);
  });

  it('形の違う bill key は null で、used に何も足さない', () => {
    const used = new Set<string>();
    expect(billKeyIntent('Zm9vYmFyYmF6cXV4MTIzN', 1000n, used)).toBeNull();
    expect(billKeyIntent(undefined, 1000n, used)).toBeNull();
    expect(used.size).toBe(0);
  });

  it('used に bill key の文字列そのものを残さない (残すのは hash と有効期限)', () => {
    const used = new Set<string>();
    billKeyIntent(KEY, 1000n, used);
    expect([...used]).toEqual([`${billKeySalt(KEY)}:1000`]);
    expect([...used].join('')).not.toContain(KEY);
  });
});

describe('lib/relay/billKeySalt.ts は、払う側とお店の端末が共有する純関数の module', () => {
  const source = readFileSync(resolve(__dirname, '../../lib/relay/billKeySalt.ts'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  it('import は viem だけ (server-only にしない・env も storage も読まない)', () => {
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['viem']);
    expect(code).not.toMatch(/\bwindow\b|\bdocument\b|Storage|process\.env|fetch\(|Date\.now|Math\.random|getRandomValues/);
  });
});
