// 注文リンクの「入金を確かめる」: 発送の判断に使うので、数えるのは成功した取引の、その受取チェーンの JPYC の
// Transfer のうち受取ウォレット宛てだけ (別のトークン・別の宛先・失敗した取引は届いた額に入れない)。
// 確認の署名は、この支払いをしたウォレット (受取先・forwarder へ送った人がちょうど 1 人で、AuthorizationUsed があれば
// 1 つだけで同じ人) のものだけを「確かめた」とする (Tx Hash は誰でも見られるので、他人の支払いの Tx Hash を貼った注文を
// 見分ける)。他人の支払いと自分の支払いを 1 つの取引にまとめた取引は「確かめられない」。
// 第 9 回レビュー D-3・E-6・E-7: 確定していない・確定を確かめられない取引は「届いています」(paid) にしない・この端末に
// 記録できないときは「初めて」と言わない・署名を確かめる問い合わせが RPC に届かないときは「他人の署名」と言わない。

import { describe, expect, it, vi } from 'vitest';
import {
  custom,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  erc6492SignatureValidatorByteCode,
  HttpRequestError,
  isAddressEqual,
  isErc6492Signature,
  multicall3Abi,
  numberToHex,
  parseAbi,
  parseErc6492Signature,
  parseUnits,
  recoverAddress,
  RpcRequestError,
  serializeErc6492Signature,
  serializeErc8010Signature,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

const FORWARDER = '0x2222222222222222222222222222222222222222' as Address;
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderConfig')>();
  return { ...actual, jpycForwarderFor: () => '0x2222222222222222222222222222222222222222' };
});

import { orderConfirmationMessage } from '@/lib/orderConfirmation';
import {
  checkOrderConfirmation,
  checkOrderLinkPayment,
  checkOrderLinkPaymentOnChains,
  extractTxHash,
  orderLinkReadClient,
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

// 取引はブロック 123 (hash = RECEIPT_BLOCK) に入っている。finalized = `finalized` タグのブロック (既定は確定済みの 200・
// Error ならタグを読めない)。canonicalHash = 同じ高さの今の正規のブロックの hash (既定は receipt と同じ・null は読めない)。
const RECEIPT_BLOCK = `0x${'a1'.repeat(32)}` as Hex;
function client(
  receipt: { status: 'success' | 'reverted'; logs: Log[] } | Error,
  {
    finalized = 200n,
    canonicalHash = RECEIPT_BLOCK,
    blockError,
  }: { finalized?: bigint | Error; canonicalHash?: Hex | null; blockError?: Error } = {},
) {
  return {
    getTransactionReceipt: vi.fn(async () => {
      if (receipt instanceof Error) throw receipt;
      return { ...receipt, blockNumber: 123n, blockHash: RECEIPT_BLOCK } as never;
    }),
    getBlock: vi.fn(async (args?: { blockTag?: string; blockNumber?: bigint }) => {
      if (args?.blockTag === 'finalized') {
        if (finalized instanceof Error) throw finalized;
        return { number: finalized } as never;
      }
      if (blockError) throw blockError;
      return { timestamp: 1_762_000_000n, hash: canonicalHash } as never;
    }),
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

  it('ecrecover で合わない署名はコントラクトのウォレットとして RPC で確かめ、合わなければ mismatch', async () => {
    const contractWallet = '0x6666666666666666666666666666666666666666' as Address;
    const signature = `0x${'12'.repeat(100)}` as Hex;
    const ok = { verifyMessage: vi.fn(async () => true) };
    await expect(checkOrderConfirmation({ client: ok, payer: contractWallet, message, signature })).resolves.toBe('verified');
    expect(ok.verifyMessage).toHaveBeenCalledWith({ address: contractWallet, message, signature });
    const rejected = { verifyMessage: vi.fn(async () => false) };
    await expect(checkOrderConfirmation({ client: rejected, payer: contractWallet, message, signature })).resolves.toBe('mismatch');
  });

  it('確かめる問い合わせが例外になったら (RPC に届かない) unchecked: 他人の署名 (mismatch) と言わない (E-7)', async () => {
    const contractWallet = '0x6666666666666666666666666666666666666666' as Address;
    const signature = `0x${'12'.repeat(100)}` as Hex;
    const broken = { verifyMessage: vi.fn(async () => { throw new Error('rpc down'); }) };
    await expect(checkOrderConfirmation({ client: broken, payer: contractWallet, message, signature })).resolves.toBe('unchecked');
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

  it('受取ウォレットに届いて確定していれば、届いた額・ブロック・時刻を返す (署名が無ければ unsigned)', async () => {
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
    // Polygon は `finalized` タグで確定を見る (lib/jpyc/finality)
    expect(c.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' });
  });

  it('確認の署名を確かめる問い合わせが RPC に届かなければ、届いた支払いの confirmation は unchecked', async () => {
    const contractWallet = '0x6666666666666666666666666666666666666666' as Address;
    const c = client({ status: 'success', logs: [transfer(JPYC, contractWallet, RECEIVER, '3465')] });
    c.verifyMessage.mockRejectedValueOnce(new Error('rpc down'));
    const text = `Tx Hash: ${HASH}\n確認の署名: 0x${'12'.repeat(100)}`;
    await expect(checkOrderLinkPayment({ ...base, text, client: c })).resolves.toMatchObject({
      status: 'paid',
      payer: contractWallet,
      confirmation: 'unchecked',
    });
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

// 第 9 回レビュー D-3: 確定する前の取引はチェーンの組み替えで消えることがあるので「届いています」にしない。
// 確定の読み方は lib/jpyc/finality.ts (Polygon・Ethereum は `finalized` タグ・ほかは即時) を使う。
describe('checkOrderLinkPayment: 確定', () => {
  const base = { chain: 'polygon' as const, receiver: RECEIVER, text: `Tx Hash: ${HASH}` };
  const logs = [transfer(JPYC, FORWARDER, RECEIVER, '3465')];
  const facts = { received: '3465', blockNumber: 123n, timestamp: 1_762_000_000, payer: null, confirmation: 'unsigned' };

  it('確定したブロックが取引のブロックより前なら pending (paid にしない)', async () => {
    const c = client({ status: 'success', logs }, { finalized: 122n });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'pending', ...facts });
  });

  it('確定したブロックが取引のブロックに届いたら paid', async () => {
    const c = client({ status: 'success', logs }, { finalized: 123n });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'paid', ...facts });
  });

  it('`finalized` タグを読めなければ finalityUnchecked (確定とも未確定とも言わない・paid にしない)', async () => {
    const c = client({ status: 'success', logs }, { finalized: new Error('unsupported block tag') });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'finalityUnchecked', ...facts });
  });

  it('Kaia はブロックが出た時点で確定するチェーンなので、タグを読まずに paid', async () => {
    const kaiaJpyc = deploymentForSlug('jpyc', 'kaia').address;
    const c = client(
      { status: 'success', logs: [transfer(kaiaJpyc, FORWARDER, RECEIVER, '3465')] },
      { finalized: new Error('unsupported block tag') },
    );
    await expect(checkOrderLinkPayment({ ...base, chain: 'kaia', client: c })).resolves.toEqual({ status: 'paid', ...facts });
    expect(c.getBlock).not.toHaveBeenCalledWith({ blockTag: 'finalized' });
  });

  // Codex MUST: receipt のブロックが組み替えで外れた (同じ高さの今の正規のブロックの hash が違う) なら、確定の高さに
  // 届いていても paid にしない。
  it('receipt のブロックの hash が、同じ高さの今の正規のブロックと違えば (別のフォーク) 確定の高さに届いていても pending', async () => {
    const c = client({ status: 'success', logs }, { finalized: 200n, canonicalHash: `0x${'b2'.repeat(32)}` as Hex });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'pending', ...facts });
    // 確定の高さを先に読み、その後で同じ高さの正規のブロックを読む (確定した後も正規なら、その取引はもう消えない)
    const order = c.getBlock.mock.calls.map(([args]) => (args?.blockTag === 'finalized' ? 'finalized' : 'byNumber'));
    expect(order).toEqual(['finalized', 'byNumber']);
  });

  it('Kaia (即時に確定するチェーン) でも、receipt のブロックが今の正規のブロックと違えば paid にしない', async () => {
    const kaiaJpyc = deploymentForSlug('jpyc', 'kaia').address;
    const c = client(
      { status: 'success', logs: [transfer(kaiaJpyc, FORWARDER, RECEIVER, '3465')] },
      { canonicalHash: `0x${'b2'.repeat(32)}` as Hex },
    );
    await expect(checkOrderLinkPayment({ ...base, chain: 'kaia', client: c })).resolves.toEqual({ status: 'pending', ...facts });
  });

  it('同じ高さの正規のブロックの hash を読めなければ finalityUnchecked (確定とも言わない)', async () => {
    const c = client({ status: 'success', logs }, { finalized: 200n, canonicalHash: null });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({ status: 'finalityUnchecked', ...facts });
  });

  // Codex SHOULD: ブロックを読めない (ノードの追従の遅れ等) ときも、見つかった支払いの情報は捨てない。
  it('同じ高さのブロックを読めなければ (getBlock が throw)、支払いの情報は保って finalityUnchecked (時刻は null)', async () => {
    const c = client({ status: 'success', logs }, { finalized: 200n, blockError: new Error('block not found') });
    await expect(checkOrderLinkPayment({ ...base, client: c })).resolves.toEqual({
      status: 'finalityUnchecked',
      ...facts,
      timestamp: null,
    });
  });

  // Codex SHOULD: 確定の高さを読み終える前に、同じ高さのブロックを取りに行かない (読む順番を呼び出しの順でなく完了で固定)。
  it('確定の高さを読み終えるまで、同じ高さのブロックを取りに行かない', async () => {
    let releaseFinalized!: (block: { number: bigint }) => void;
    const finalizedRead = new Promise<{ number: bigint }>((done) => {
      releaseFinalized = done;
    });
    const byNumber = vi.fn(async () => ({ timestamp: 1_762_000_000n, hash: RECEIPT_BLOCK }));
    const c = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'success', logs, blockNumber: 123n, blockHash: RECEIPT_BLOCK }) as never),
      getBlock: vi.fn((args?: { blockTag?: string }) => (args?.blockTag === 'finalized' ? finalizedRead : byNumber()) as never),
      verifyMessage: vi.fn(async () => false),
    };
    const checking = checkOrderLinkPayment({ ...base, client: c });
    await new Promise((done) => setTimeout(done, 20));
    expect(c.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' });
    expect(byNumber).not.toHaveBeenCalled();
    releaseFinalized({ number: 200n });
    await expect(checking).resolves.toEqual({ status: 'paid', ...facts });
    expect(byNumber).toHaveBeenCalledTimes(1);
  });

  it('全部のチェーンを探したときも、確定していない取引は見つかったチェーンの pending にする', async () => {
    const notFound = client(new TransactionReceiptNotFoundError({ hash: HASH }));
    const onPolygon = client({ status: 'success', logs }, { finalized: 100n });
    await expect(
      checkOrderLinkPaymentOnChains({
        chains: ['kaia', 'polygon'],
        receiver: RECEIVER,
        text: base.text,
        clientFor: (chain) => (chain === 'polygon' ? onPolygon : notFound),
      }),
    ).resolves.toEqual({ chain: 'polygon', result: { status: 'pending', ...facts }, unreachable: [] });
  });
});

describe('checkOrderLinkPaymentOnChains', () => {
  const text = `Tx Hash: ${HASH}`;
  const paidLogs = [transfer(JPYC, FORWARDER, RECEIVER, '3465')];
  // kaia の JPYC は polygon と別のアドレス。そのチェーンの JPYC の Transfer で数える。
  const kaiaJpyc = deploymentForSlug('jpyc', 'kaia').address;

  it('取引が見つかったチェーンで判定する (他のチェーンでは見つからない)', async () => {
    const notFound = client(new TransactionReceiptNotFoundError({ hash: HASH }));
    const onKaia = client({ status: 'success', logs: [transfer(kaiaJpyc, FORWARDER, RECEIVER, '3465')] });
    const found = await checkOrderLinkPaymentOnChains({
      chains: ['polygon', 'kaia'],
      receiver: RECEIVER,
      text,
      clientFor: (chain) => (chain === 'kaia' ? onKaia : notFound),
    });
    expect(found.chain).toBe('kaia');
    expect(found.result).toMatchObject({ status: 'paid', received: '3465' });
  });

  it('どこでも見つからなければ notFound・読めなかったチェーンがあれば error と読めなかったチェーン', async () => {
    const notFound = client(new TransactionReceiptNotFoundError({ hash: HASH }));
    const broken = client(new Error('rpc down'));
    await expect(
      checkOrderLinkPaymentOnChains({ chains: ['polygon', 'kaia'], receiver: RECEIVER, text, clientFor: () => notFound }),
    ).resolves.toEqual({ chain: null, result: { status: 'notFound' }, unreachable: [] });
    await expect(
      checkOrderLinkPaymentOnChains({
        chains: ['polygon', 'kaia'],
        receiver: RECEIVER,
        text,
        clientFor: (chain) => (chain === 'kaia' ? broken : notFound),
      }),
    ).resolves.toEqual({ chain: null, result: { status: 'error' }, unreachable: ['kaia'] });
  });

  // Codex SHOULD: 既定の RPC は時間切れと再試行で 1 つのチェーンに数十秒かかることがある。止まっているチェーンを待たない。
  const hanging = () => ({
    getTransactionReceipt: vi.fn(() => new Promise<never>(() => {})),
    getBlock: vi.fn(() => new Promise<never>(() => {})),
    verifyMessage: vi.fn(async () => false),
  });
  const within = <T,>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, new Promise<'still waiting'>((done) => setTimeout(() => done('still waiting'), ms))]);

  it('確定した支払いが見つかったら、設定の順で後ろの止まっているチェーンの答えを待たずに出す', async () => {
    const onPolygon = client({ status: 'success', logs: paidLogs });
    const search = checkOrderLinkPaymentOnChains({
      chains: ['polygon', 'kaia'],
      receiver: RECEIVER,
      text,
      clientFor: (chain) => (chain === 'polygon' ? onPolygon : hanging()),
      budgetMs: 60_000,
    });
    await expect(within(search, 500)).resolves.toMatchObject({ chain: 'polygon', result: { status: 'paid' }, unreachable: [] });
  });

  // Codex SHOULD: 採る結果は応答の速さで決めない。優先順 (paid > pending・finalityUnchecked > failed・notToReceiver
  // > notFound > error)、同じ順位なら設定の順 (chains の順) で前のチェーン。
  const later = <C extends ReturnType<typeof client>>(c: C, ms: number): C => ({
    ...c,
    getTransactionReceipt: vi.fn(async (args: { hash: Hex }) => {
      await new Promise((done) => setTimeout(done, ms));
      return (c.getTransactionReceipt as (a: { hash: Hex }) => Promise<never>)(args);
    }),
  });
  const kaiaLogs = () => [transfer(kaiaJpyc, FORWARDER, RECEIVER, '3465')];
  const forkedOnKaia = () => client({ status: 'success', logs: kaiaLogs() }, { canonicalHash: `0x${'b2'.repeat(32)}` as Hex });

  it('先に答えたチェーンの pending (別フォーク) が、後から答えたチェーンの paid を隠さない', async () => {
    const paidOnPolygon = later(client({ status: 'success', logs: paidLogs }), 40);
    await expect(
      checkOrderLinkPaymentOnChains({
        chains: ['kaia', 'polygon'],
        receiver: RECEIVER,
        text,
        clientFor: (chain) => (chain === 'polygon' ? paidOnPolygon : forkedOnKaia()),
      }),
    ).resolves.toMatchObject({ chain: 'polygon', result: { status: 'paid' }, unreachable: [] });
  });

  it('先に答えた「届いていない」(notToReceiver・failed) より、後から答えた pending を採る', async () => {
    const notToReceiver = client({ status: 'success', logs: [transfer(JPYC, FORWARDER, OTHER, '3465')] });
    const pendingOnKaia = later(forkedOnKaia(), 40);
    await expect(
      checkOrderLinkPaymentOnChains({
        chains: ['polygon', 'kaia'],
        receiver: RECEIVER,
        text,
        clientFor: (chain) => (chain === 'kaia' ? pendingOnKaia : notToReceiver),
      }),
    ).resolves.toMatchObject({ chain: 'kaia', result: { status: 'pending' } });
    const failed = client({ status: 'reverted', logs: [] });
    await expect(
      checkOrderLinkPaymentOnChains({
        chains: ['polygon', 'kaia'],
        receiver: RECEIVER,
        text,
        clientFor: (chain) => (chain === 'kaia' ? later(forkedOnKaia(), 40) : failed),
      }),
    ).resolves.toMatchObject({ chain: 'kaia', result: { status: 'pending' } });
  });

  it('同じ順位の結果が 2 つのチェーンにあれば、速く答えたほうでなく設定の順で前のチェーンを採る', async () => {
    // pending どうし: kaia が先に答えても、設定の順で前の polygon
    const pendingOnPolygon = later(client({ status: 'success', logs: paidLogs }, { finalized: 100n }), 40);
    await expect(
      checkOrderLinkPaymentOnChains({
        chains: ['polygon', 'kaia'],
        receiver: RECEIVER,
        text,
        clientFor: (chain) => (chain === 'polygon' ? pendingOnPolygon : forkedOnKaia()),
      }),
    ).resolves.toMatchObject({ chain: 'polygon', result: { status: 'pending' } });
    // paid どうし: kaia の paid が先に答えても、前の polygon が答えるまで待って polygon
    const paidOnPolygon = later(client({ status: 'success', logs: paidLogs }), 40);
    const paidOnKaia = client({ status: 'success', logs: kaiaLogs() });
    await expect(
      checkOrderLinkPaymentOnChains({
        chains: ['polygon', 'kaia'],
        receiver: RECEIVER,
        text,
        clientFor: (chain) => (chain === 'polygon' ? paidOnPolygon : paidOnKaia),
      }),
    ).resolves.toMatchObject({ chain: 'polygon', result: { status: 'paid' } });
  });

  it('予算が尽きたら、それまでに見つかった結果を採る (前のチェーンが止まっていても paid・ほかが止まっていても pending)', async () => {
    const paidOnPolygon = client({ status: 'success', logs: paidLogs });
    await expect(
      within(
        checkOrderLinkPaymentOnChains({
          chains: ['kaia', 'polygon'],
          receiver: RECEIVER,
          text,
          clientFor: (chain) => (chain === 'polygon' ? paidOnPolygon : hanging()),
          budgetMs: 50,
        }),
        1_000,
      ),
    ).resolves.toMatchObject({ chain: 'polygon', result: { status: 'paid' }, unreachable: [] });
    const pendingOnPolygon = client({ status: 'success', logs: paidLogs }, { finalized: 100n });
    await expect(
      within(
        checkOrderLinkPaymentOnChains({
          chains: ['polygon', 'kaia'],
          receiver: RECEIVER,
          text,
          clientFor: (chain) => (chain === 'polygon' ? pendingOnPolygon : hanging()),
          budgetMs: 50,
        }),
        1_000,
      ),
    ).resolves.toMatchObject({ chain: 'polygon', result: { status: 'pending' }, unreachable: [] });
  });

  it('時間の予算の間に答えないチェーンは「問い合わせできなかった」(unreachable) にして、待ち続けない', async () => {
    const notFound = client(new TransactionReceiptNotFoundError({ hash: HASH }));
    const search = checkOrderLinkPaymentOnChains({
      chains: ['polygon', 'kaia'],
      receiver: RECEIVER,
      text,
      clientFor: (chain) => (chain === 'kaia' ? hanging() : notFound),
      budgetMs: 50,
    });
    await expect(within(search, 1_000)).resolves.toEqual({ chain: null, result: { status: 'error' }, unreachable: ['kaia'] });
  });

  it('1 つでも見つかれば、他のチェーンの失敗は出さない・Tx Hash が無ければ問い合わせない', async () => {
    const broken = client(new Error('rpc down'));
    const onPolygon = client({ status: 'success', logs: paidLogs });
    const found = await checkOrderLinkPaymentOnChains({
      chains: ['polygon', 'kaia'],
      receiver: RECEIVER,
      text,
      clientFor: (chain) => (chain === 'polygon' ? onPolygon : broken),
    });
    expect(found).toMatchObject({ chain: 'polygon', result: { status: 'paid' }, unreachable: [] });
    const unused = client({ status: 'success', logs: [] });
    await expect(
      checkOrderLinkPaymentOnChains({ chains: ['polygon'], receiver: RECEIVER, text: 'なし', clientFor: () => unused }),
    ).resolves.toEqual({ chain: null, result: { status: 'invalid' }, unreachable: [] });
    expect(unused.getTransactionReceipt).not.toHaveBeenCalled();
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

  // 第 9 回レビュー E-6: 記録を読めない・残せないときは「初めて」(null) と言わず unavailable を返す (例外は出さない)。
  it('保存できない (setItem が throw)・使えない環境では、初めて (null) と言わず unavailable', () => {
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(rememberCheckedPayment(input, full)).toBe('unavailable');
    expect(rememberCheckedPayment(input, null)).toBe('unavailable');
  });

  it('読めない保存領域 (getItem が throw) は unavailable で、書き込みもしない (読めない記録を上書きで消さない)', () => {
    const setItem = vi.fn();
    const unreadable = { getItem: () => { throw new Error('denied'); }, setItem };
    expect(rememberCheckedPayment(input, unreadable)).toBe('unavailable');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('壊れた記録は作り直す。作り直した回は前に確かめたかが分からないので unavailable、次からは見られる', () => {
    const broken = memoryStorage({ 'openpay:order-link-checked:v1': '{not json' });
    expect(rememberCheckedPayment(input, broken)).toBe('unavailable');
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, broken)).toBe(1_000);
    const notObject = memoryStorage({ 'openpay:order-link-checked:v1': '[1,2]' });
    expect(rememberCheckedPayment(input, notObject)).toBe('unavailable');
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, notObject)).toBe(1_000);
  });

  // Codex SHOULD: オブジェクトでも、時刻でない値 (文字列の "1000" 等) や空文字の保存値は壊れた記録 (初めてと言わない)。
  it('時刻でない値・空文字の保存値も壊れた記録として unavailable にし、壊れた値は捨てて作り直す', () => {
    const key = `polygon:${RECEIVER.toLowerCase()}:${HASH}`;
    const stringTime = memoryStorage({ 'openpay:order-link-checked:v1': JSON.stringify({ [key]: '1000' }) });
    expect(rememberCheckedPayment(input, stringTime)).toBe('unavailable');
    expect(JSON.parse(stringTime.data['openpay:order-link-checked:v1'])).toEqual({ [key]: 1_000 });
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, stringTime)).toBe(1_000);
    const otherBroken = memoryStorage({ 'openpay:order-link-checked:v1': JSON.stringify({ 'polygon:x:y': -1, 'kaia:x:y': null }) });
    expect(rememberCheckedPayment(input, otherBroken)).toBe('unavailable');
    const empty = memoryStorage({ 'openpay:order-link-checked:v1': '' });
    expect(rememberCheckedPayment(input, empty)).toBe('unavailable');
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, empty)).toBe(1_000);
  });

  it('負の数だけの記録・この支払いの時刻が負の数なら壊れた記録 (負の時刻を「前に確かめた」にしない)', () => {
    const key = `polygon:${RECEIVER.toLowerCase()}:${HASH}`;
    const negativeOnly = memoryStorage({ 'openpay:order-link-checked:v1': JSON.stringify({ 'polygon:x:y': -1 }) });
    expect(rememberCheckedPayment(input, negativeOnly)).toBe('unavailable');
    const negativeOwn = memoryStorage({ 'openpay:order-link-checked:v1': JSON.stringify({ [key]: -5 }) });
    expect(rememberCheckedPayment(input, negativeOwn)).toBe('unavailable');
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, negativeOwn)).toBe(1_000);
  });

  it('JSON の 1e309 (Infinity に読める) も壊れた記録 (Infinity を「前に確かめた」にしない)', () => {
    const key = `polygon:${RECEIVER.toLowerCase()}:${HASH}`;
    const infinite = memoryStorage({ 'openpay:order-link-checked:v1': `{"${key}":1e309}` });
    expect(rememberCheckedPayment(input, infinite)).toBe('unavailable');
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, infinite)).toBe(1_000);
  });

  it('ほかの記録が壊れていても、この支払いの記録が読めれば前に確かめた時刻を返す (使い回しの注意を消さない)', () => {
    const key = `polygon:${RECEIVER.toLowerCase()}:${HASH}`;
    const mixed = memoryStorage({ 'openpay:order-link-checked:v1': JSON.stringify({ [key]: 1_000, 'kaia:x:y': 'oops' }) });
    expect(rememberCheckedPayment({ ...input, now: 2_000 }, mixed)).toBe(1_000);
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

// 第 9 回レビュー E-7: 確認の署名をコントラクトのウォレット (ERC-1271 / ERC-6492) として確かめる経路を、mock でなく viem の
// 実際の verifyMessage (orderLinkReadClient) で通す。模擬するのは RPC の応答だけ (tests/app/api/auth-siwe.test.ts と同じ形)。
// viem は確かめる問い合わせ (eth_call) の失敗を取り消しも RPC の失敗もまとめて false にするので、RPC に届かないときに
// 「他人の署名」(mismatch) にならないこと (unchecked) まで確かめる。
describe('確認の署名をコントラクトのウォレットとして viem で確かめる', () => {
  // Fixed, test-only keys; sign locally only, no real wallet.
  const owner = privateKeyToAccount(`0x${'33'.repeat(32)}`);
  const stranger = privateKeyToAccount(`0x${'55'.repeat(32)}`);
  const DEPLOYED_WALLET = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as Address;
  const COUNTERFACTUAL_WALLET = '0x6492649264926492649264926492649264926492' as Address;
  const FACTORY = '0xfac7fac7fac7fac7fac7fac7fac7fac7fac7fac7' as Address;
  const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex;
  const VALIDATOR_BYTECODE = erc6492SignatureValidatorByteCode.toLowerCase();
  const VALIDATOR_ARGS = [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes' }] as const;
  const message = orderConfirmationMessage({ chain: 'polygon', shop: RECEIVER, txHash: HASH });
  // 7702 で委任済みの EOA (ERC-8010 の署名)。委任先は「EOA 自身の鍵の署名なら有効」とする (典型)。
  const delegated = privateKeyToAccount(`0x${'44'.repeat(32)}`);
  const DELEGATE = '0x000000000000000000000000000000000000c0de' as Address;
  const ERC1271_MAGIC = '0x1626ba7e';
  const IS_VALID_SIGNATURE_ABI = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
  // まだ委任していない EOA (ERC-8010 の署名に委任の承認を入れて送る)。viem は承認 (authorizationList) を付けた
  // multicall3 の aggregate3 で、委任した後の isValidSignature を eth_call で読む。
  const undelegated = privateKeyToAccount(`0x${'66'.repeat(32)}`);
  const MULTICALL3 = (polygon.contracts.multicall3.address as Address).toLowerCase();
  const owners: Record<string, Address> = {
    [DEPLOYED_WALLET.toLowerCase()]: owner.address,
    [COUNTERFACTUAL_WALLET.toLowerCase()]: owner.address,
    [delegated.address.toLowerCase()]: delegated.address,
    [undelegated.address.toLowerCase()]: undelegated.address,
  };
  const OFFCHAIN_LOOKUP = parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']);

  async function isValid(wallet: string, hash: Hex, signature: Hex) {
    const expected = owners[wallet.toLowerCase()];
    try {
      return expected !== undefined && isAddressEqual(await recoverAddress({ hash, signature }), expected);
    } catch {
      return false;
    }
  }

  // 模擬のチェーン。ERC-6492 の validator は deployless (to なし) の eth_call で来るので、validator と同じく 6492 の
  // 包みを外し、wallet の isValidSignature を「owner の ecrecover なら有効」(よくある owner 型) として答える。
  // ERC-8010 (7702 委任済みの EOA) は、viem が EOA 自身へ isValidSignature を直接 eth_call する。
  // verifier: down = 確かめる eth_call が RPC に届かない (HTTP 503)・revert = 取り消した (署名を受け付けない)・
  // innerRevert = aggregate3 の中の isValidSignature だけが取り消した (aggregate3 そのものは成功)・
  // offchain = 呼んだ先が OffchainLookup (CCIP-Read) で外の URL を指して取り消した。
  // canonicalHash = 同じ高さの今の正規のブロックの hash (既定は receipt のブロックと同じ)。
  function fakeChain(
    options: {
      verifier?: 'answer' | 'down' | 'revert' | 'innerRevert' | 'offchain';
      logs?: Log[];
      finalized?: bigint;
      canonicalHash?: Hex;
    } = {},
  ) {
    const methods: string[] = [];
    const authorizationLists: unknown[] = [];
    const answer = async (valid: () => Promise<Hex>, to?: string) => {
      if (options.verifier === 'down') {
        throw new HttpRequestError({ url: 'https://rpc.invalid', status: 503, details: 'Service Unavailable' });
      }
      if (options.verifier === 'revert' || (options.verifier === 'offchain' && to)) {
        const data =
          options.verifier === 'offchain' && to
            ? encodeErrorResult({
                abi: OFFCHAIN_LOOKUP,
                errorName: 'OffchainLookup',
                args: [to as Address, ['https://ccip.invalid/{sender}/{data}.json'], '0x', '0x12345678', '0x'],
              })
            : '0x';
        throw new RpcRequestError({ body: {}, error: { code: 3, message: 'execution reverted', data }, url: 'https://rpc.invalid' });
      }
      return valid();
    };
    const transport = custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          methods.push(method);
          const first = Array.isArray(params) ? params[0] : undefined;
          if (method === 'eth_chainId') return numberToHex(polygon.id);
          if (method === 'eth_getTransactionReceipt') {
            return { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: '0x7b', status: '0x1', logs: options.logs ?? [] };
          }
          if (method === 'eth_getBlockByNumber') {
            if (first === 'finalized') return { number: numberToHex(options.finalized ?? 200n), hash: BLOCK_HASH, timestamp: '0x1' };
            return { number: first as Hex, hash: options.canonicalHash ?? BLOCK_HASH, timestamp: numberToHex(1_762_000_000) };
          }
          if (method === 'eth_getCode') {
            return String(first).toLowerCase() === delegated.address.toLowerCase() ? `0xef0100${DELEGATE.slice(2)}` : '0x';
          }
          const tx = first as { to?: string; data?: Hex; authorizationList?: unknown[] } | undefined;
          if (method === 'eth_call' && !tx?.to && tx?.data?.toLowerCase().startsWith(VALIDATOR_BYTECODE)) {
            const data = tx.data;
            return answer(async () => {
              const [signer, hash, sig] = decodeAbiParameters(VALIDATOR_ARGS, `0x${data.slice(VALIDATOR_BYTECODE.length)}`);
              const inner = isErc6492Signature(sig) ? parseErc6492Signature(sig).signature : sig;
              return encodeAbiParameters([{ type: 'bool' }], [await isValid(signer, hash, inner)]);
            });
          }
          if (method === 'eth_call' && tx?.to && tx.data?.startsWith(ERC1271_MAGIC)) {
            const { to, data } = { to: tx.to, data: tx.data };
            return answer(async () => {
              const { args } = decodeFunctionData({ abi: IS_VALID_SIGNATURE_ABI, data });
              const ok = await isValid(to, args[0], args[1]);
              return encodeAbiParameters([{ type: 'bytes4' }], [ok ? ERC1271_MAGIC : '0xffffffff']);
            }, to);
          }
          // 未委任の 8010: 承認 (authorizationList) を付けた aggregate3。承認が付いていれば委任した後として答える。
          if (method === 'eth_call' && tx?.to?.toLowerCase() === MULTICALL3 && tx.data) {
            const { data, authorizationList } = { data: tx.data, authorizationList: tx.authorizationList };
            authorizationLists.push(authorizationList);
            return answer(async () => {
              const decoded = decodeFunctionData({ abi: multicall3Abi, data });
              if (decoded.functionName !== 'aggregate3') throw new Error('unexpected multicall in test');
              const calls = decoded.args[0];
              const results = await Promise.all(
                calls.map(async ({ target, callData }) => {
                  if (options.verifier === 'innerRevert') return { success: false, returnData: '0x' as Hex };
                  const { args: inner } = decodeFunctionData({ abi: IS_VALID_SIGNATURE_ABI, data: callData });
                  const delegatedNow = Array.isArray(authorizationList) && authorizationList.length === 1;
                  const ok = delegatedNow && (await isValid(target, inner[0], inner[1]));
                  return {
                    success: true,
                    returnData: encodeAbiParameters([{ type: 'bytes4' }], [ok ? ERC1271_MAGIC : '0xffffffff']),
                  };
                }),
              );
              return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
            });
          }
          throw new Error(`unexpected rpc in test: ${method}`);
        },
      },
      { retryCount: 0 },
    );
    return { client: orderLinkReadClient(polygon, transport), methods, authorizationLists };
  }

  const signedByUndelegated8010 = async () =>
    serializeErc8010Signature({
      authorization: await undelegated.signAuthorization({ address: DELEGATE, chainId: polygon.id, nonce: 0 }),
      signature: await undelegated.signMessage({ message }),
    });

  const signedBy8010 = async () =>
    serializeErc8010Signature({
      authorization: await delegated.signAuthorization({ address: DELEGATE, chainId: polygon.id, nonce: 0 }),
      signature: await delegated.signMessage({ message }),
    });

  const signedBy6492 = async (signer: typeof owner) =>
    serializeErc6492Signature({ address: FACTORY, data: '0xdeadbeef', signature: await signer.signMessage({ message }) });

  it('ERC-6492 (未デプロイの wallet・factory で包んだ署名) は owner の署名なら verified', async () => {
    const { client: c, methods } = fakeChain();
    const signature = await signedBy6492(owner);
    await expect(checkOrderConfirmation({ client: c, payer: COUNTERFACTUAL_WALLET, message, signature })).resolves.toBe('verified');
    expect(methods).toContain('eth_call');
  });

  it('ERC-1271 (デプロイ済みの wallet) は owner の署名なら verified・別の鍵の署名は mismatch', async () => {
    const { client: c } = fakeChain();
    const byOwner = await owner.signMessage({ message });
    await expect(checkOrderConfirmation({ client: c, payer: DEPLOYED_WALLET, message, signature: byOwner })).resolves.toBe('verified');
    const byStranger = await stranger.signMessage({ message });
    await expect(checkOrderConfirmation({ client: c, payer: DEPLOYED_WALLET, message, signature: byStranger })).resolves.toBe('mismatch');
  });

  it('validator が取り消したら (署名を受け付けない) mismatch', async () => {
    const { client: c } = fakeChain({ verifier: 'revert' });
    const signature = await signedBy6492(owner);
    await expect(checkOrderConfirmation({ client: c, payer: COUNTERFACTUAL_WALLET, message, signature })).resolves.toBe('mismatch');
  });

  it('確かめる問い合わせが RPC に届かなければ unchecked (viem が false にまとめても、他人の署名と言わない)', async () => {
    const { client: c } = fakeChain({ verifier: 'down' });
    const signature = await signedBy6492(owner);
    await expect(checkOrderConfirmation({ client: c, payer: COUNTERFACTUAL_WALLET, message, signature })).resolves.toBe('unchecked');
  });

  it('ERC-8010 (7702 委任済みの EOA) も、確かめられれば verified・RPC に届かなければ unchecked・取り消しは mismatch', async () => {
    const signature = await signedBy8010();
    const ok = fakeChain();
    await expect(checkOrderConfirmation({ client: ok.client, payer: delegated.address, message, signature })).resolves.toBe('verified');
    // viem は 8010 の isValidSignature を readContract で読む (eth_getCode で委任を見てから)
    expect(ok.methods).toEqual(expect.arrayContaining(['eth_getCode', 'eth_call']));
    const down = fakeChain({ verifier: 'down' });
    await expect(checkOrderConfirmation({ client: down.client, payer: delegated.address, message, signature })).resolves.toBe('unchecked');
    const reverted = fakeChain({ verifier: 'revert' });
    await expect(checkOrderConfirmation({ client: reverted.client, payer: delegated.address, message, signature })).resolves.toBe('mismatch');
  });

  // Codex SHOULD: 未委任の 8010 は承認を付けた aggregate3 の経路 (readContract) を通る。中の取り消しと RPC の失敗を分ける。
  it('ERC-8010 (まだ委任していない EOA) は承認を付けた aggregate3 で確かめ、中の取り消しは mismatch・RPC に届かなければ unchecked', async () => {
    const signature = await signedByUndelegated8010();
    const ok = fakeChain();
    await expect(checkOrderConfirmation({ client: ok.client, payer: undelegated.address, message, signature })).resolves.toBe('verified');
    // 委任の承認を 1 つ付けた aggregate3 の eth_call を通った (委任済みの経路ではない)
    expect(ok.authorizationLists).toHaveLength(1);
    expect(ok.authorizationLists[0]).toHaveLength(1);
    const innerRevert = fakeChain({ verifier: 'innerRevert' });
    await expect(
      checkOrderConfirmation({ client: innerRevert.client, payer: undelegated.address, message, signature }),
    ).resolves.toBe('mismatch');
    const down = fakeChain({ verifier: 'down' });
    await expect(checkOrderConfirmation({ client: down.client, payer: undelegated.address, message, signature })).resolves.toBe('unchecked');
  });

  // C-1 と同じ: お客様が決めたウォレットが OffchainLookup で外の URL を指しても、お店のブラウザから取りに行かない。
  it('呼んだ先が OffchainLookup (CCIP-Read) を返しても外の URL へ取りに行かず、取り消しとして mismatch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network blocked in test'));
    try {
      const signature = await signedBy8010();
      const offchain = fakeChain({ verifier: 'offchain' });
      await expect(
        checkOrderConfirmation({ client: offchain.client, payer: delegated.address, message, signature }),
      ).resolves.toBe('mismatch');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('入金の確認を通して: receipt のブロックが今の正規のブロックと違えば (別のフォーク)、確定の高さに届いていても pending', async () => {
    const logs = [transfer(JPYC, COUNTERFACTUAL_WALLET, RECEIVER, '3465')];
    const text = `Tx Hash: ${HASH}\n確認の署名: ${await signedBy6492(owner)}`;
    const forked = fakeChain({ logs, finalized: 200n, canonicalHash: `0x${'cc'.repeat(32)}` as Hex });
    await expect(checkOrderLinkPayment({ chain: 'polygon', receiver: RECEIVER, text, client: forked.client })).resolves.toMatchObject({
      status: 'pending',
      confirmation: 'verified',
    });
  });

  it('入金の確認を通して: 6492 の wallet が払った確定済みの支払いは paid + verified・確定前は pending', async () => {
    const logs = [transfer(JPYC, COUNTERFACTUAL_WALLET, RECEIVER, '3465')];
    const text = `Tx Hash: ${HASH}\n確認の署名: ${await signedBy6492(owner)}`;
    const base = { chain: 'polygon' as const, receiver: RECEIVER, text };
    await expect(checkOrderLinkPayment({ ...base, client: fakeChain({ logs }).client })).resolves.toEqual({
      status: 'paid',
      received: '3465',
      blockNumber: 123n,
      timestamp: 1_762_000_000,
      payer: COUNTERFACTUAL_WALLET,
      confirmation: 'verified',
    });
    await expect(checkOrderLinkPayment({ ...base, client: fakeChain({ logs, finalized: 122n }).client })).resolves.toMatchObject({
      status: 'pending',
      confirmation: 'verified',
    });
    await expect(
      checkOrderLinkPayment({ ...base, client: fakeChain({ logs, verifier: 'down' }).client }),
    ).resolves.toMatchObject({ status: 'paid', confirmation: 'unchecked' });
  });
});
