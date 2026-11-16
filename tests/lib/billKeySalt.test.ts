import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { BILL_KEY_TAG, billKeyIntent, billKeySalt } from '@/lib/relay/billKeySalt';
import { buildForwarderNonce, type ForwarderSettleParams } from '@/lib/relay/forwarderIntent';

// 期待値は、実装 (viem) と別の道具 (Foundry の cast) で計算した:
//   TAG  = cast keccak "openpay.bill-key.v1"
//   salt = cast keccak $(cast abi-encode "f(bytes32,string)" $TAG "<bill key>")
// 払う側とお店の端末が同じ値を作ることを、この vector で固定する (お店の端末は lib/qrSaleHistory.ts で同じ関数を import する)。
// bill key は 11 字 (64 bit の乱数の base64url)。Zm9vYmFyYmE は "foobarba" の 8 byte。
const TAG = '0x08bdd09c9e48e277d98780b5c95461c094c5c00794ae799a9e9eb73815490796';
const VECTORS: [string, Hex][] = [
  ['AAAAAAAAAAA', '0xcd21456b4b5c6b2f73e4a1f9dd4535d7b7e6092a5444d45af4260b3dc994ec43'],
  ['Zm9vYmFyYmE', '0xf71ee2a8eaaff2864b1bb71e47354a28af9038a73387875ed5159ddba2e4c311'],
  ['a-b_c-d_e-8', '0xd7b269e373189582c23e8556cfde09f612ca0fe46bcbccc214929895e2aa702e'],
];
// 前の形 (128 bit・22 字)。いまは形の違う bill key = 無いものとして扱う。
const OLD_22 = 'Zm9vYmFyYmF6cXV4MTIzNA';

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

  it('encode の形: abi.encode(bytes32 TAG, string bill key) = TAG ‖ 0x40 ‖ 長さ 11 ‖ utf8 の 11 byte (右を 0 で埋める)', () => {
    const utf8 = '5a6d3976596d4679596d45'; // "Zm9vYmFyYmE"
    const encoded = `0x${TAG.slice(2)}${'40'.padStart(64, '0')}${'0b'.padStart(64, '0')}${utf8.padEnd(64, '0')}` as Hex;
    expect(toHex('Zm9vYmFyYmE')).toBe(`0x${utf8}`);
    expect(billKeySalt('Zm9vYmFyYmE')).toBe(keccak256(encoded));
  });

  it('forwarder の nonce の golden vector (bill key から作った intentSalt を入れた例・cast で計算)', () => {
    const intentSalt = billKeySalt('Zm9vYmFyYmE')!;
    expect(buildForwarderNonce({ ...GOLDEN, intentSalt }, CHAIN, FORWARDER)).toBe(
      '0x0c5e6828d506861e706ff9118267bf80702dfa0cf48cb0d12a479a298d91c588',
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
    expect(billKeySalt('Zm9vYmFyYmE')).toBe(billKeySalt('Zm9vYmFyYmE'));
    expect(billKeySalt('zm9vYmFyYmE')).not.toBeNull();
    expect(billKeySalt('zm9vYmFyYmE')).not.toBe(billKeySalt('Zm9vYmFyYmE'));
    expect(new Set(VECTORS.map(([billKey]) => billKeySalt(billKey))).size).toBe(VECTORS.length);
  });

  it('文字列をそのまま hash する: base64 として同じ 8 byte になる 2 つの文字列 (末尾の余りの 2 bit だけが違う) は別の salt', () => {
    // 11 字 = 66 bit で、8 byte = 64 bit。最後の字の下 2 bit は decode で捨てられるので、A と B は同じ byte 列になる。
    const a = 'AAAAAAAAAAA';
    const b = 'AAAAAAAAAAB';
    expect(Buffer.from(a, 'base64url').equals(Buffer.from(b, 'base64url'))).toBe(true);
    expect(billKeySalt(a)).not.toBeNull();
    expect(billKeySalt(b)).not.toBeNull();
    expect(billKeySalt(a)).not.toBe(billKeySalt(b));
  });

  it.each([
    ['空', ''],
    ['10 字', 'Zm9vYmFyYm'],
    ['12 字', 'Zm9vYmFyYmEA'],
    ['12 字 (8 byte の base64 の padding つき)', 'Zm9vYmFyYmE='],
    ['21 字', OLD_22.slice(0, 21)],
    ['22 字 (前の形・128 bit)', OLD_22],
    ['22 字 (正しい形を 2 つつなげた)', 'Zm9vYmFyYmEZm9vYmFyYmE'],
    ['23 字', `${OLD_22}A`],
    ['+ 入り (base64 の標準形)', 'Zm9vYmFyYm+'],
    ['/ 入り', 'Zm9vYmFyYm/'],
    ['= 入り (padding)', 'Zm9vYmFyYm='],
    ['空白入り', 'Zm9vYmFyYm '],
    ['前に空白', ' Zm9vYmFyYmE'],
    ['後ろに改行', 'Zm9vYmFyYmE\n'],
    ['11 字で後ろが改行', 'Zm9vYmFyYm\n'],
    ['ASCII でない字入り', 'Zm9vYmFyYmあ'],
    ['全角の英数', 'ＡＡＡＡＡＡＡＡＡＡＡ'],
    ['% 入り', 'Zm9vYmFy%2B'],
    ['. 入り', 'Zm9vYmFyYm.'],
    ['32 byte の hex (intentSalt そのもの)', `0x${'ab'.repeat(32)}`],
  ])('形の違う文字列は null (throw しない): %s', (_label, value) => {
    expect(billKeySalt(value)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['数 (11 桁)', 12345678901],
    ['真偽', true],
    ['11 字の配列', Array.from('Zm9vYmFyYmE')],
    ['正しい文字列 1 つの配列', ['Zm9vYmFyYmE']],
    ['object', { toString: () => 'Zm9vYmFyYmE' }],
  ])('文字列でない値は null (throw しない): %s', (_label, value) => {
    expect(billKeySalt(value)).toBeNull();
  });
});

describe('billKeyIntent (払う側の 1 回の署名に使う intentSalt と有効期限)', () => {
  const KEY = 'Zm9vYmFyYmE';
  const OTHER = 'AAAAAAAAAAA';

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
    expect(billKeyIntent('Zm9vYmFyYm', 1000n, used)).toBeNull();
    expect(billKeyIntent(OLD_22, 1000n, used)).toBeNull();
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
