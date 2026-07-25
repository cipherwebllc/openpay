import { describe, it, expect, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  verifyJpycFeeTransfer,
  verifyJpycFeeOnChain,
  verifyJpycStandardFeePairOnChain,
  verifyJpycTransferTo,
  verifyJpycTransferToOnChain,
  type FeeReceiptLog,
} from '@/lib/feeVerify';

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const TOKEN = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29'; // JPYC v3
const FROM = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const TO = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER = '0x1111111111111111111111111111111111111111';
const MIN = 300n * 10n ** 18n; // basic ¥300

function pad32(addr: string): string {
  return `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;
}

function transferLog(args: {
  token?: string;
  from?: string;
  to?: string;
  value?: bigint;
  topic?: string;
}): FeeReceiptLog {
  return {
    address: args.token ?? TOKEN,
    topics: [
      args.topic ?? TRANSFER_TOPIC,
      pad32(args.from ?? FROM),
      pad32(args.to ?? TO),
    ],
    data: `0x${(args.value ?? MIN).toString(16)}`,
  };
}

const expected = { token: TOKEN, from: FROM, to: TO, minValue: MIN } as const;

describe('verifyJpycFeeTransfer', () => {
  it('from→to に tier 額ちょうどの Transfer → ok', () => {
    const r = verifyJpycFeeTransfer({ logs: [transferLog({})], expected });
    expect(r).toEqual({ ok: true, value: MIN });
  });

  it('tier 額超過 → ok (value はそのまま)', () => {
    const v = MIN + 1n;
    const r = verifyJpycFeeTransfer({ logs: [transferLog({ value: v })], expected });
    expect(r).toEqual({ ok: true, value: v });
  });

  it('額不足 → amount_too_low', () => {
    const r = verifyJpycFeeTransfer({
      logs: [transferLog({ value: MIN - 1n })],
      expected,
    });
    expect(r).toEqual({ ok: false, reason: 'amount_too_low' });
  });

  it('送金元が別 wallet → no_matching_transfer (なりすまし拒否)', () => {
    const r = verifyJpycFeeTransfer({
      logs: [transferLog({ from: OTHER })],
      expected,
    });
    expect(r).toEqual({ ok: false, reason: 'no_matching_transfer' });
  });

  it('宛先が受領アドレス以外 → no_matching_transfer', () => {
    const r = verifyJpycFeeTransfer({ logs: [transferLog({ to: OTHER })], expected });
    expect(r).toEqual({ ok: false, reason: 'no_matching_transfer' });
  });

  it('別トークンの Transfer は無視 → no_matching_transfer', () => {
    const r = verifyJpycFeeTransfer({
      logs: [transferLog({ token: OTHER })],
      expected,
    });
    expect(r).toEqual({ ok: false, reason: 'no_matching_transfer' });
  });

  it('Transfer 以外の topic は無視', () => {
    const r = verifyJpycFeeTransfer({
      logs: [transferLog({ topic: `0x${'a'.repeat(64)}` })],
      expected,
    });
    expect(r).toEqual({ ok: false, reason: 'no_matching_transfer' });
  });

  it('同一 tx 内の複数 from→to Transfer は合算', () => {
    const r = verifyJpycFeeTransfer({
      logs: [
        transferLog({ value: 100n * 10n ** 18n }),
        transferLog({ value: 200n * 10n ** 18n }),
      ],
      expected,
    });
    expect(r).toEqual({ ok: true, value: MIN }); // 100+200=300
  });

  it('小文字のログアドレス (token/from/to) を checksummed expected と照合 (getAddress 正規化)', () => {
    // event log は小文字で来ることが多い。expected は checksummed (session.address /
    // deployment.address)。getAddress で両者を正規化して照合する。
    const r = verifyJpycFeeTransfer({
      logs: [
        transferLog({
          token: TOKEN.toLowerCase(),
          from: FROM.toLowerCase(),
          to: TO.toLowerCase(),
        }),
      ],
      expected,
    });
    expect(r.ok).toBe(true);
  });

  it('logs 空 → no_matching_transfer', () => {
    expect(verifyJpycFeeTransfer({ logs: [], expected })).toEqual({
      ok: false,
      reason: 'no_matching_transfer',
    });
  });

  it('data が hex でない (BigInt 例外) → そのログは無視', () => {
    const bad: FeeReceiptLog = {
      address: TOKEN,
      topics: [TRANSFER_TOPIC, pad32(FROM), pad32(TO)],
      data: '0xnothex',
    };
    expect(verifyJpycFeeTransfer({ logs: [bad], expected })).toEqual({
      ok: false,
      reason: 'no_matching_transfer',
    });
  });

  it('topics が 3 未満 (非標準ログ) → 無視', () => {
    const short: FeeReceiptLog = {
      address: TOKEN,
      topics: [TRANSFER_TOPIC],
      data: `0x${MIN.toString(16)}`,
    };
    expect(verifyJpycFeeTransfer({ logs: [short], expected })).toEqual({
      ok: false,
      reason: 'no_matching_transfer',
    });
  });

  it('log.address が不正 (getAddress 例外) → そのログは無視', () => {
    const bad: FeeReceiptLog = {
      address: '0xnot-an-address',
      topics: [TRANSFER_TOPIC, pad32(FROM), pad32(TO)],
      data: `0x${MIN.toString(16)}`,
    };
    expect(verifyJpycFeeTransfer({ logs: [bad], expected })).toEqual({
      ok: false,
      reason: 'no_matching_transfer',
    });
  });

  it('不正ログが混在しても有効な Transfer は集計される (堅牢性)', () => {
    const bad: FeeReceiptLog = {
      address: TOKEN,
      topics: [TRANSFER_TOPIC, pad32(FROM), pad32(TO)],
      data: '0xZZ', // 壊れた data → 無視
    };
    const r = verifyJpycFeeTransfer({
      logs: [bad, transferLog({ value: MIN })],
      expected,
    });
    expect(r).toEqual({ ok: true, value: MIN });
  });
});

describe('verifyJpycFeeOnChain', () => {
  const txHash = `0x${'1'.repeat(64)}` as Hex;
  it('status=success → 純関数へ委譲し ok', async () => {
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [transferLog({})],
      }),
    };
    const r = await verifyJpycFeeOnChain({ publicClient, txHash, expected });
    expect(r).toEqual({ ok: true, value: MIN });
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: txHash });
  });

  it('status=success → 成功時に receipt の blockNumber を載せる (Pro 付与の決定論用)', async () => {
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [transferLog({})],
        blockNumber: 12345n,
      }),
    };
    const r = await verifyJpycFeeOnChain({ publicClient, txHash, expected });
    expect(r).toEqual({ ok: true, value: MIN, blockNumber: 12345n });
  });

  it('blockNumber 欠落の receipt でも成功は壊さない (blockNumber undefined)', async () => {
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [transferLog({})],
        // blockNumber 無し (古い mock / 非標準 client)
      }),
    };
    const r = await verifyJpycFeeOnChain({ publicClient, txHash, expected });
    expect(r).toEqual({ ok: true, value: MIN });
  });

  it('検証失敗時は blockNumber を載せない (reason のみ)', async () => {
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [transferLog({ value: MIN - 1n })],
        blockNumber: 999n,
      }),
    };
    const r = await verifyJpycFeeOnChain({ publicClient, txHash, expected });
    expect(r).toEqual({ ok: false, reason: 'amount_too_low' });
  });

  it('status=reverted → tx_reverted', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValue({ status: 'reverted', logs: [] }),
    };
    expect(await verifyJpycFeeOnChain({ publicClient, txHash, expected })).toEqual({
      ok: false,
      reason: 'tx_reverted',
    });
  });

  it('未マイニング/不明な tx (TransactionReceiptNotFoundError) → tx_not_found', async () => {
    const notFound = Object.assign(new Error('receipt not found'), {
      name: 'TransactionReceiptNotFoundError',
    });
    const publicClient = {
      getTransactionReceipt: vi.fn().mockRejectedValue(notFound),
    };
    expect(await verifyJpycFeeOnChain({ publicClient, txHash, expected })).toEqual({
      ok: false,
      reason: 'tx_not_found',
    });
  });

  it('RPC/transport 障害 (それ以外の例外) → rpc_error (tx_not_found と区別)', async () => {
    const rpcDown = Object.assign(new Error('fetch failed'), {
      name: 'HttpRequestError',
    });
    const publicClient = {
      getTransactionReceipt: vi.fn().mockRejectedValue(rpcDown),
    };
    expect(await verifyJpycFeeOnChain({ publicClient, txHash, expected })).toEqual({
      ok: false,
      reason: 'rpc_error',
    });
  });
});

const FORWARDER = '0x2222222222222222222222222222222222222222';
const toExpected = { token: TOKEN, to: TO, minValue: MIN } as const;

describe('verifyJpycTransferTo (from 非依存・受注リレー用)', () => {
  it('free 経路 (customer→merchant) を to 一致で拾う → ok', () => {
    const r = verifyJpycTransferTo({
      logs: [transferLog({ from: FROM, to: TO })],
      expected: toExpected,
    });
    expect(r).toEqual({ ok: true, value: MIN });
  });

  it('recover(forwarder) 分割ログ: merchant 着金のみ合算 (feeReceiver 宛は除外) → ok', () => {
    // customer→merchant ログは存在しない。merchant 宛は forwarder からの 1 本のみ。
    const merchantLeg = transferLog({ from: FORWARDER, to: TO, value: MIN });
    const feeLeg = transferLog({ from: FORWARDER, to: OTHER, value: 2n * 10n ** 18n });
    const r = verifyJpycTransferTo({ logs: [merchantLeg, feeLeg], expected: toExpected });
    expect(r).toEqual({ ok: true, value: MIN }); // merchant 宛のみ・feeReceiver 宛は除外
  });

  it('from が誰でも to=merchant なら拾う (verifyJpycFeeTransfer との違い)', () => {
    const r = verifyJpycTransferTo({
      logs: [transferLog({ from: FORWARDER, to: TO })],
      expected: toExpected,
    });
    expect(r.ok).toBe(true);
  });

  it('to が merchant 以外のログは除外 → no_matching_transfer', () => {
    const r = verifyJpycTransferTo({
      logs: [transferLog({ from: FORWARDER, to: OTHER })],
      expected: toExpected,
    });
    expect(r).toEqual({ ok: false, reason: 'no_matching_transfer' });
  });

  it('merchant 宛合計が minValue 未満 → amount_too_low', () => {
    const r = verifyJpycTransferTo({
      logs: [transferLog({ to: TO, value: MIN - 1n })],
      expected: toExpected,
    });
    expect(r).toEqual({ ok: false, reason: 'amount_too_low' });
  });

  it('別トークンの to=merchant Transfer は無視 → no_matching_transfer', () => {
    const r = verifyJpycTransferTo({
      logs: [transferLog({ token: OTHER, to: TO })],
      expected: toExpected,
    });
    expect(r).toEqual({ ok: false, reason: 'no_matching_transfer' });
  });

  it('複数の merchant 着金は合算', () => {
    const r = verifyJpycTransferTo({
      logs: [
        transferLog({ from: FROM, to: TO, value: 100n * 10n ** 18n }),
        transferLog({ from: FORWARDER, to: TO, value: 200n * 10n ** 18n }),
      ],
      expected: toExpected,
    });
    expect(r).toEqual({ ok: true, value: MIN });
  });
});

describe('verifyJpycTransferToOnChain', () => {
  const txHash = `0x${'2'.repeat(64)}` as Hex;
  it('status=success → 実着金合計 value + blockNumber を返す', async () => {
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [transferLog({ from: FORWARDER, to: TO, value: MIN })],
        blockNumber: 7n,
      }),
    };
    const r = await verifyJpycTransferToOnChain({ publicClient, txHash, expected: toExpected });
    expect(r).toEqual({ ok: true, value: MIN, blockNumber: 7n });
  });

  it('receipt.from から merchant への direct Transfer 額だけを additive に返す', async () => {
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [
          transferLog({ from: FROM, to: TO, value: MIN }),
          transferLog({ from: FORWARDER, to: TO, value: 1n }),
        ],
        blockNumber: 7n,
        transactionIndex: 4,
        from: FROM,
      }),
    };
    const r = await verifyJpycTransferToOnChain({
      publicClient,
      txHash,
      expected: toExpected,
    });
    expect(r).toEqual({
      ok: true,
      value: MIN + 1n,
      blockNumber: 7n,
      transactionIndex: 4,
      receiptFrom: FROM,
      directValue: MIN,
    });
  });

  it('同一 receipt の merchant Transfer source→feeReceiver 額を server-side 集計', async () => {
    const feeValue = 9n;
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [
          transferLog({ from: FORWARDER, to: TO, value: MIN }),
          transferLog({ from: FORWARDER, to: OTHER, value: feeValue }),
        ],
        blockNumber: 7n,
      }),
    };
    const r = await verifyJpycTransferToOnChain({
      publicClient,
      txHash,
      expected: { ...toExpected, feeReceiver: OTHER },
    });
    expect(r).toEqual({
      ok: true,
      value: MIN,
      blockNumber: 7n,
      merchantSource: FORWARDER,
      sameSourceFeeValue: feeValue,
    });
  });

  it('status=reverted → tx_reverted', async () => {
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted', logs: [] }),
    };
    expect(
      await verifyJpycTransferToOnChain({ publicClient, txHash, expected: toExpected }),
    ).toEqual({ ok: false, reason: 'tx_reverted' });
  });
});

describe('verifyJpycStandardFeePairOnChain', () => {
  const merchantTxHash = `0x${'3'.repeat(64)}` as Hex;
  const feeTxHash = `0x${'4'.repeat(64)}` as Hex;
  const pairExpected = {
    token: TOKEN,
    merchant: TO,
    merchantValue: MIN,
    feeReceiver: OTHER,
    feeMinValue: MIN,
  } as const;
  it('同一 on-chain payer の merchant 後 fee Transfer を receipt 各 1 回で検証', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: OTHER })],
          blockNumber: 101n,
          from: FROM,
          transactionIndex: 0,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: pairExpected,
      }),
    ).toEqual({ ok: true, value: MIN, blockNumber: 101n });
    expect(publicClient.getTransactionReceipt.mock.calls).toEqual([
      [{ hash: merchantTxHash }],
      [{ hash: feeTxHash }],
    ]);
  });

  it('別 payer の無関係な fee tx は payer_mismatch', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: OTHER, to: OTHER })],
          blockNumber: 101n,
          from: OTHER,
          transactionIndex: 0,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: pairExpected,
      }),
    ).toEqual({ ok: false, reason: 'payer_mismatch' });
  });

  it('merchant leg より古い履歴 fee tx は fee_before_merchant', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: OTHER })],
          blockNumber: 99n,
          from: FROM,
          transactionIndex: 9,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: pairExpected,
      }),
    ).toEqual({ ok: false, reason: 'fee_before_merchant' });
  });

  it.each([
    [1, 1],
    [0, 1],
  ])(
    'same block で fee transactionIndex=%i が merchant=%i 以前なら拒否',
    async (feeIndex, merchantIndex) => {
      const publicClient = {
          getTransactionReceipt: vi
          .fn()
          .mockResolvedValueOnce({
            status: 'success',
            logs: [transferLog({ from: FROM, to: TO })],
            blockNumber: 100n,
            from: FROM,
            transactionIndex: merchantIndex,
          })
          .mockResolvedValueOnce({
            status: 'success',
            logs: [transferLog({ from: FROM, to: OTHER })],
            blockNumber: 100n,
            from: FROM,
            transactionIndex: feeIndex,
          }),
      };

      expect(
        await verifyJpycStandardFeePairOnChain({
          publicClient,
          merchantTxHash,
          feeTxHash,
          expected: pairExpected,
        }),
      ).toEqual({ ok: false, reason: 'fee_before_merchant' });
    },
  );

  it('same block でも fee transactionIndex が merchant より後なら受理', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: OTHER })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 2,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: pairExpected,
      }),
    ).toEqual({ ok: true, value: MIN, blockNumber: 100n });
  });

  it('tx sender が同じでも JPYC Transfer payer が別なら拒否', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: OTHER, to: OTHER })],
          blockNumber: 101n,
          from: FROM,
          transactionIndex: 0,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: pairExpected,
      }),
    ).toEqual({ ok: false, reason: 'no_matching_transfer' });
  });

  it('merchant receipt の JPYC Transfer payer も tx sender と一致必須', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: OTHER, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: OTHER })],
          blockNumber: 101n,
          from: FROM,
          transactionIndex: 0,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: pairExpected,
      }),
    ).toEqual({ ok: false, reason: 'no_matching_transfer' });
  });

  it('merchant leg の同 payer direct 額が保存注文額より多くても拒否', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO, value: MIN + 1n })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: OTHER })],
          blockNumber: 101n,
          from: FROM,
          transactionIndex: 0,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: pairExpected,
      }),
    ).toEqual({ ok: false, reason: 'merchant_amount_mismatch' });
  });

  it('同 payer の別用途の大額送金を注文 fee として受理しない', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [
            transferLog({
              from: FROM,
              to: OTHER,
              value: pairExpected.feeMinValue + 1n,
            }),
          ],
          blockNumber: 101n,
          from: FROM,
          transactionIndex: 0,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: pairExpected,
      }),
    ).toEqual({ ok: false, reason: 'fee_amount_mismatch' });
  });

  it('店舗負担の保存済み第2候補 (minimum+1 minor unit) だけは exact fee として受理', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [
            transferLog({
              from: FROM,
              to: OTHER,
              value: pairExpected.feeMinValue + 1n,
            }),
          ],
          blockNumber: 101n,
          from: FROM,
          transactionIndex: 0,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: {
          ...pairExpected,
          feeAlternateValue: pairExpected.feeMinValue + 1n,
        },
      }),
    ).toEqual({
      ok: true,
      value: pairExpected.feeMinValue + 1n,
      blockNumber: 101n,
    });
  });

  it('第2候補を持つ店舗負担でも minimum+2 minor units は拒否', async () => {
    const publicClient = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [transferLog({ from: FROM, to: TO })],
          blockNumber: 100n,
          from: FROM,
          transactionIndex: 1,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [
            transferLog({
              from: FROM,
              to: OTHER,
              value: pairExpected.feeMinValue + 2n,
            }),
          ],
          blockNumber: 101n,
          from: FROM,
          transactionIndex: 0,
        }),
    };

    expect(
      await verifyJpycStandardFeePairOnChain({
        publicClient,
        merchantTxHash,
        feeTxHash,
        expected: {
          ...pairExpected,
          feeAlternateValue: pairExpected.feeMinValue + 1n,
        },
      }),
    ).toEqual({ ok: false, reason: 'fee_amount_mismatch' });
  });
});
