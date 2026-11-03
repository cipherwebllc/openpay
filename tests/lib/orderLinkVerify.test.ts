// 注文リンクの「入金を確かめる」: 発送の判断に使うので、数えるのは成功した取引の、その受取チェーンの JPYC の
// Transfer のうち受取ウォレット宛てだけ (別のトークン・別の宛先・失敗した取引は届いた額に入れない)。
// 確認の署名は、この支払いをしたウォレット (受取先・forwarder へ送った人がちょうど 1 人で、AuthorizationUsed があれば
// 1 つだけで同じ人) のものだけを「確かめた」とする (Tx Hash は誰でも見られるので、他人の支払いの Tx Hash を貼った注文を
// 見分ける)。他人の支払いと自分の支払いを 1 つの取引にまとめた取引は「確かめられない」。

import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseAbi,
  parseUnits,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const FORWARDER = '0x2222222222222222222222222222222222222222' as Address;
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return { ...actual, jpycForwarderFor: () => '0x2222222222222222222222222222222222222222' };
});

import { orderConfirmationMessage } from '@/lib/orderConfirmation';
import {
  checkOrderConfirmation,
  checkOrderLinkPayment,
  extractTxHash,
  paymentPayer,
  receivedByReceiver,
  rememberCheckedPayment,
} from '@/lib/orderLinkVerify';
import { deploymentForSlug } from '@/lib/tokens';

const RECEIVER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const JPYC = deploymentForSlug('jpyc', 'polygon').address;
const NOT_JPYC = '0x3333333333333333333333333333333333333333' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;

function transfer(token: Address, from: Address, to: Address, jpyc: string): Log {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint256' }], [parseUnits(jpyc, 18)]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as unknown as Log;
}

const AUTHORIZATION_USED = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);
function authorizationUsed(token: Address, authorizer: Address): Log {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: AUTHORIZATION_USED,
      eventName: 'AuthorizationUsed',
      args: { authorizer, nonce: `0x${'77'.repeat(32)}` },
    }) as [Hex, ...Hex[]],
    data: '0x',
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as unknown as Log;
}

function client(receipt: { status: 'success' | 'reverted'; logs: Log[] } | Error) {
  return {
    getTransactionReceipt: vi.fn(async () => {
      if (receipt instanceof Error) throw receipt;
      return { ...receipt, blockNumber: 123n } as never;
    }),
    getBlock: vi.fn(async () => ({ timestamp: 1_762_000_000n }) as never),
    verifyMessage: vi.fn(async () => false),
  };
}

describe('extractTxHash', () => {
  it('貼った文 (お店に知らせるの文や Explorer の URL) から最初の Tx Hash を取り出す', () => {
    expect(extractTxHash(`ご注文 A-001 のお支払いが済みました。\nTx Hash: ${HASH}\nhttps://polygonscan.com/tx/${HASH}`)).toBe(HASH);
    expect(extractTxHash(`https://polygonscan.com/tx/${HASH.toUpperCase().replace('0X', '0x')}`)).toBe(HASH);
    expect(extractTxHash('0x1234')).toBeNull();
    expect(extractTxHash('')).toBeNull();
  });

  it('確認の署名 (65 バイト) の頭 64 桁を Tx Hash と取り違えない (署名が先に書かれていても)', () => {
    const sig = `0x${'cd'.repeat(65)}`;
    expect(extractTxHash(`確認の署名: ${sig}\nTx Hash: ${HASH}`)).toBe(HASH);
    expect(extractTxHash(`確認の署名: ${sig}`)).toBeNull();
    // 改行が消えて次の行とつながっても取れる (1 行の欄に貼った文)
    expect(extractTxHash(`Tx Hash: ${HASH}https://polygonscan.com/tx/${HASH}`)).toBe(HASH);
  });
});

describe('paymentPayer', () => {
  const PAYER = '0x4444444444444444444444444444444444444444' as Address;
  const ATTACKER = '0x7777777777777777777777777777777777777777' as Address;
  it('ガス代不要の支払いは AuthorizationUsed の authorizer (forwarder や relayer を払った人にしない)', () => {
    const logs = [
      transfer(JPYC, PAYER, FORWARDER, '3500'),
      authorizationUsed(JPYC, PAYER),
      transfer(JPYC, FORWARDER, RECEIVER, '3465'),
      transfer(JPYC, FORWARDER, OTHER, '35'),
    ];
    expect(paymentPayer(logs, JPYC, RECEIVER, FORWARDER)).toBe(PAYER);
  });

  it('AuthorizationUsed が無ければ、受取先か forwarder へ JPYC を送ったただ 1 人 (通常決済・スマートアカウント)', () => {
    expect(paymentPayer([transfer(JPYC, PAYER, RECEIVER, '3500')], JPYC, RECEIVER, FORWARDER)).toBe(PAYER);
    expect(
      paymentPayer(
        [transfer(JPYC, PAYER, FORWARDER, '3500'), transfer(JPYC, FORWARDER, RECEIVER, '3465')],
        JPYC,
        RECEIVER,
        FORWARDER,
      ),
    ).toBe(PAYER);
    // 同じ人の 2 回の送金は 1 人
    expect(
      paymentPayer([transfer(JPYC, PAYER, RECEIVER, '3000'), transfer(JPYC, PAYER, RECEIVER, '500')], JPYC, RECEIVER, FORWARDER),
    ).toBe(PAYER);
  });

  it('別のトークン・ゼロアドレス (発行)・0 の送金・関係ない宛先は数えない', () => {
    const logs = [
      transfer(NOT_JPYC, OTHER, RECEIVER, '1'),
      transfer(JPYC, zeroAddress, RECEIVER, '1'),
      transfer(JPYC, ATTACKER, RECEIVER, '0'),
      transfer(JPYC, OTHER, '0x5555555555555555555555555555555555555555', '1'),
      transfer(JPYC, PAYER, RECEIVER, '3500'),
    ];
    expect(paymentPayer(logs, JPYC, RECEIVER, FORWARDER)).toBe(PAYER);
  });

  it('他人の支払いと自分の支払いを 1 つの取引にまとめたら、払った人を決めない (null)', () => {
    // 2 つの EIP-3009 の支払い (誰でも forwarder の settle を続けて呼べる)
    expect(
      paymentPayer(
        [
          transfer(JPYC, PAYER, FORWARDER, '3500'),
          authorizationUsed(JPYC, PAYER),
          transfer(JPYC, FORWARDER, RECEIVER, '3465'),
          transfer(JPYC, ATTACKER, FORWARDER, '1'),
          authorizationUsed(JPYC, ATTACKER),
          transfer(JPYC, FORWARDER, OTHER, '1'),
        ],
        JPYC,
        RECEIVER,
        FORWARDER,
      ),
    ).toBeNull();
    // 他人の EIP-3009 の支払いに、自分の普通の送金を足す
    expect(
      paymentPayer(
        [authorizationUsed(JPYC, PAYER), transfer(JPYC, PAYER, FORWARDER, '3500'), transfer(JPYC, ATTACKER, RECEIVER, '1')],
        JPYC,
        RECEIVER,
        FORWARDER,
      ),
    ).toBeNull();
    // 関係ない人の AuthorizationUsed だけを足す (受取先へ送った人と合わない)
    expect(
      paymentPayer([transfer(JPYC, PAYER, RECEIVER, '3500'), authorizationUsed(JPYC, ATTACKER)], JPYC, RECEIVER, FORWARDER),
    ).toBeNull();
    expect(paymentPayer([], JPYC, RECEIVER, FORWARDER)).toBeNull();
  });
});

describe('checkOrderConfirmation', () => {
  const message = orderConfirmationMessage({ chain: 'polygon', shop: RECEIVER, txHash: HASH });

  it('払ったウォレットの署名なら verified・別の人や別の文の署名なら mismatch', async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const c = { verifyMessage: vi.fn(async () => false) };
    const signed = await payer.signMessage({ message });
    await expect(checkOrderConfirmation({ client: c, payer: payer.address, message, signature: signed })).resolves.toBe('verified');
    // ecrecover で通れば RPC に問い合わせない
    expect(c.verifyMessage).not.toHaveBeenCalled();
    const byStranger = await stranger.signMessage({ message });
    await expect(checkOrderConfirmation({ client: c, payer: payer.address, message, signature: byStranger })).resolves.toBe('mismatch');
    const otherTx = await payer.signMessage({
      message: orderConfirmationMessage({ chain: 'polygon', shop: RECEIVER, txHash: `0x${'ef'.repeat(32)}` }),
    });
    await expect(checkOrderConfirmation({ client: c, payer: payer.address, message, signature: otherTx })).resolves.toBe('mismatch');
    const otherShop = await payer.signMessage({
      message: orderConfirmationMessage({ chain: 'polygon', shop: OTHER, txHash: HASH }),
    });
    await expect(checkOrderConfirmation({ client: c, payer: payer.address, message, signature: otherShop })).resolves.toBe('mismatch');
    const otherChain = await payer.signMessage({
      message: orderConfirmationMessage({ chain: 'kaia', shop: RECEIVER, txHash: HASH }),
    });
    await expect(checkOrderConfirmation({ client: c, payer: payer.address, message, signature: otherChain })).resolves.toBe('mismatch');
  });

  it('短縮形 (EIP-2098) の署名も払ったウォレットのものとして確かめる', async () => {
    const { parseSignature, serializeCompactSignature, signatureToCompactSignature } = await import('viem');
    const payer = privateKeyToAccount(generatePrivateKey());
    const full = await payer.signMessage({ message });
    const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(full)));
    const c = { verifyMessage: vi.fn(async () => false) };
    await expect(checkOrderConfirmation({ client: c, payer: payer.address, message, signature: compact })).resolves.toBe('verified');
  });

  it('ecrecover で合わない署名はコントラクトのウォレットとして RPC で確かめ、失敗は mismatch に倒す', async () => {
    const contractWallet = '0x6666666666666666666666666666666666666666' as Address;
    const signature = `0x${'12'.repeat(100)}` as Hex;
    const ok = { verifyMessage: vi.fn(async () => true) };
    await expect(checkOrderConfirmation({ client: ok, payer: contractWallet, message, signature })).resolves.toBe('verified');
    expect(ok.verifyMessage).toHaveBeenCalledWith({ address: contractWallet, message, signature });
    const broken = { verifyMessage: vi.fn(async () => { throw new Error('rpc down'); }) };
    await expect(checkOrderConfirmation({ client: broken, payer: contractWallet, message, signature })).resolves.toBe('mismatch');
  });
});

describe('receivedByReceiver', () => {
  it('その JPYC の、受取ウォレット宛ての Transfer だけを足す', () => {
    const logs = [
      transfer(JPYC, OTHER, FORWARDER, '3500'),
      transfer(JPYC, FORWARDER, RECEIVER, '3465'),
      transfer(JPYC, FORWARDER, OTHER, '35'),
      transfer(NOT_JPYC, OTHER, RECEIVER, '9999'),
    ];
    expect(receivedByReceiver(logs, JPYC, RECEIVER)).toBe(parseUnits('3465', 18));
  });
});

describe('checkOrderLinkPayment', () => {
  const base = { chain: 'polygon' as const, receiver: RECEIVER, text: `Tx Hash: ${HASH}` };

  it('受取ウォレットに届いていれば、届いた額・ブロック・時刻を返す (署名が無ければ unsigned)', async () => {
    const c = client({ status: 'success', logs: [transfer(JPYC, FORWARDER, RECEIVER, '3465')] });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({
      status: 'paid',
      received: '3465',
      blockNumber: 123n,
      timestamp: 1_762_000_000,
      payer: null,
      confirmation: 'unsigned',
    });
    expect(c.getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it('届いた文の確認の署名が、払ったウォレットのものなら verified・他人のものなら mismatch', async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const logs = [
      transfer(JPYC, payer.address, FORWARDER, '3500'),
      authorizationUsed(JPYC, payer.address),
      transfer(JPYC, FORWARDER, RECEIVER, '3465'),
    ];
    const signature = await payer.signMessage({
      message: orderConfirmationMessage({ chain: 'polygon', shop: RECEIVER, txHash: HASH }),
    });
    const text = `注文します。\nTx Hash: ${HASH}\nhttps://polygonscan.com/tx/${HASH}\n確認の署名: ${signature}`;
    await expect(checkOrderLinkPayment({ ...base, text, client: client({ status: 'success', logs }) })).resolves.toMatchObject({
      status: 'paid',
      payer: payer.address,
      confirmation: 'verified',
    });
    // 他人が同じ Tx Hash を貼り、自分のウォレットで署名した
    const thief = privateKeyToAccount(generatePrivateKey());
    const stolen = await thief.signMessage({
      message: orderConfirmationMessage({ chain: 'polygon', shop: RECEIVER, txHash: HASH }),
    });
    await expect(
      checkOrderLinkPayment({ ...base, text: `Tx Hash: ${HASH}\n確認の署名: ${stolen}`, client: client({ status: 'success', logs }) }),
    ).resolves.toMatchObject({ status: 'paid', confirmation: 'mismatch' });
  });

  it('他人の支払いと自分の支払いをまとめた取引に自分で署名しても verified にしない (unverifiable)', async () => {
    const victim = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const logs = [
      transfer(JPYC, victim.address, FORWARDER, '3500'),
      authorizationUsed(JPYC, victim.address),
      transfer(JPYC, FORWARDER, RECEIVER, '3465'),
      transfer(JPYC, attacker.address, FORWARDER, '1'),
      authorizationUsed(JPYC, attacker.address),
      transfer(JPYC, FORWARDER, OTHER, '1'),
    ];
    const signature = await attacker.signMessage({
      message: orderConfirmationMessage({ chain: 'polygon', shop: RECEIVER, txHash: HASH }),
    });
    await expect(
      checkOrderLinkPayment({ ...base, text: `Tx Hash: ${HASH}\n確認の署名: ${signature}`, client: client({ status: 'success', logs }) }),
    ).resolves.toMatchObject({ status: 'paid', payer: null, confirmation: 'unverifiable' });
  });

  it('別の宛先・別のトークンだけの取引は「届いていない」 (偽の Tx Hash で発送させない)', async () => {
    const c = client({
      status: 'success',
      logs: [transfer(JPYC, FORWARDER, OTHER, '3465'), transfer(NOT_JPYC, OTHER, RECEIVER, '3465')],
    });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'notToReceiver' });
  });

  it('失敗した取引は、ログに受取ウォレット宛てがあっても「失敗」', async () => {
    const c = client({ status: 'reverted', logs: [transfer(JPYC, FORWARDER, RECEIVER, '3465')] });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'failed' });
  });

  it('見つからない取引は「見つからない」・RPC の失敗は「問い合わせできない」 (届いたとは言わない)', async () => {
    const notFound = client(new TransactionReceiptNotFoundError({ hash: HASH }));
    await expect(checkOrderLinkPayment({ ...base, client: notFound })).resolves.toEqual({ status: 'notFound' });
    const broken = client(new Error('rpc down'));
    await expect(checkOrderLinkPayment({ ...base, client: broken })).resolves.toEqual({ status: 'error' });
  });

  it('Tx Hash が読み取れなければチェーンに問い合わせない', async () => {
    const c = client({ status: 'success', logs: [] });
    await expect(checkOrderLinkPayment({ ...base, text: 'A-001 払いました', client: c })).resolves.toEqual({ status: 'invalid' });
    expect(c.getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('rememberCheckedPayment', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      data,
    };
  }
  const input = { chain: 'polygon' as const, receiver: RECEIVER, hash: HASH, now: 1_000 };

  it('初めての支払いは null、同じ受取先・チェーン・Tx Hash の 2 回目は 1 回目の時刻を返す (使い回しを知らせる)', () => {
    const storage = memoryStorage();
    expect(rememberCheckedPayment(input, storage)).toBeNull();
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, storage)).toBe(1_000);
    // 大文字小文字の違いは同じ支払い。
    expect(rememberCheckedPayment({ ...input, hash: HASH.toUpperCase().replace('0X', '0x') as Hex, now: 3_000 }, storage)).toBe(1_000);
    // 受取先やチェーンが違えば別の記録。
    expect(rememberCheckedPayment({ ...input, receiver: OTHER }, storage)).toBeNull();
    expect(rememberCheckedPayment({ ...input, chain: 'kaia' }, storage)).toBeNull();
  });

  it('壊れた記録は作り直し、保存できない・使えない環境でも例外を出さない (確かめる機能は止めない)', () => {
    const broken = memoryStorage({ 'openpay:order-link-checked:v1': '{not json' });
    expect(rememberCheckedPayment(input, broken)).toBeNull();
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, broken)).toBe(1_000);
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(rememberCheckedPayment(input, full)).toBeNull();
    expect(rememberCheckedPayment(input, null)).toBeNull();
  });

  it('記録は新しい順に 300 件までに保つ', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 300; i += 1) many[`polygon:x:${i}`] = i;
    const storage = memoryStorage({ 'openpay:order-link-checked:v1': JSON.stringify(many) });
    rememberCheckedPayment({ ...input, now: 10_000 }, storage);
    const kept = JSON.parse(storage.data['openpay:order-link-checked:v1']) as Record<string, number>;
    expect(Object.keys(kept)).toHaveLength(300);
    expect(kept['polygon:x:0']).toBeUndefined();
    expect(Object.values(kept)).toContain(10_000);
  });
});
