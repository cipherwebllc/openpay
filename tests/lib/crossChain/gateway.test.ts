import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFunctionData, getAddress, pad, type Hex } from 'viem';
import {
  addressToBytes32,
  buildBurnIntent,
  encodeGatewayMintCalldata,
  encodeGatewayDepositCalldata,
  getBurnIntentTypedData,
  randomSalt,
  requestAttestation,
  GATEWAY_MINTER_ABI,
  GATEWAY_WALLET_ABI,
} from '@/lib/crossChain/gateway';
import {
  GATEWAY_MINTER_ADDRESS,
  GATEWAY_WALLET_ADDRESS,
} from '@/lib/crossChain/config';
import {
  BURN_INTENT_TYPED_DATA,
  CIRCLE_DOMAIN_BASE,
  CIRCLE_DOMAIN_POLYGON,
  GATEWAY_EIP712_DOMAIN,
  TRANSFER_SPEC_TYPED_DATA,
  type AttestationResponse,
} from '@/lib/crossChain/types';

const DEPOSITOR = getAddress('0x1234567890123456789012345678901234567890');
const RECIPIENT = getAddress('0x000000000000000000000000000000000000aBcd');
const SOURCE_TOKEN = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e'); // Base Sepolia USDC
const DEST_TOKEN = getAddress('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'); // Polygon Amoy USDC
const FIXED_SALT: Hex =
  '0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

describe('lib/crossChain/gateway', () => {
  describe('addressToBytes32', () => {
    it('checksum 化 + 左 0-pad で 32 bytes', () => {
      const out = addressToBytes32(
        '0x1234567890123456789012345678901234567890',
      );
      expect(out).toBe(
        '0x0000000000000000000000001234567890123456789012345678901234567890',
      );
    });

    it('小文字 address でも checksum 化される', () => {
      const out = addressToBytes32(
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
      );
      // 全 hex 文字を 12 bytes 0-pad に挿入
      expect(out.length).toBe(2 + 64);
      expect(out.startsWith('0x000000000000000000000000')).toBe(true);
    });

    it('viem.pad と equivalent', () => {
      const direct = pad(getAddress(DEPOSITOR), { size: 32 });
      expect(addressToBytes32(DEPOSITOR)).toBe(direct);
    });
  });

  describe('randomSalt', () => {
    it('0x-prefixed 32 bytes hex を返す', () => {
      const s = randomSalt();
      expect(s.startsWith('0x')).toBe(true);
      expect(s.length).toBe(2 + 64);
      expect(/^0x[0-9a-f]{64}$/.test(s)).toBe(true);
    });

    it('呼ぶ度に異なる値', () => {
      const a = randomSalt();
      const b = randomSalt();
      expect(a).not.toBe(b);
    });
  });

  describe('buildBurnIntent', () => {
    const baseArgs = {
      sourceDomain: CIRCLE_DOMAIN_BASE,
      destinationDomain: CIRCLE_DOMAIN_POLYGON,
      sourceToken: SOURCE_TOKEN,
      destinationToken: DEST_TOKEN,
      depositor: DEPOSITOR,
      recipient: RECIPIENT,
      value: 5_000_000n, // 5 USDC
      currentBlockHeight: 1000n,
    };

    it('TransferSpec に正しい domain / token / address を 入れる', () => {
      const intent = buildBurnIntent({
        ...baseArgs,
        overrides: { salt: FIXED_SALT },
      });
      expect(intent.spec.version).toBe(1);
      expect(intent.spec.sourceDomain).toBe(CIRCLE_DOMAIN_BASE);
      expect(intent.spec.destinationDomain).toBe(CIRCLE_DOMAIN_POLYGON);
      expect(intent.spec.sourceContract).toBe(
        addressToBytes32(GATEWAY_WALLET_ADDRESS),
      );
      expect(intent.spec.destinationContract).toBe(
        addressToBytes32(GATEWAY_MINTER_ADDRESS),
      );
      expect(intent.spec.sourceToken).toBe(addressToBytes32(SOURCE_TOKEN));
      expect(intent.spec.destinationToken).toBe(addressToBytes32(DEST_TOKEN));
      expect(intent.spec.sourceDepositor).toBe(addressToBytes32(DEPOSITOR));
      expect(intent.spec.destinationRecipient).toBe(
        addressToBytes32(RECIPIENT),
      );
      expect(intent.spec.sourceSigner).toBe(addressToBytes32(DEPOSITOR));
      expect(intent.spec.destinationCaller).toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      );
      expect(intent.spec.value).toBe(5_000_000n);
      expect(intent.spec.salt).toBe(FIXED_SALT);
      expect(intent.spec.hookData).toBe('0x');
    });

    it('maxBlockHeight = currentBlockHeight + chain-aware default offset (Base: 600 blocks ≈ 20 min)', () => {
      // baseArgs.sourceDomain = CIRCLE_DOMAIN_BASE = 6
      // testnet env: chainIdForDomain(6) → baseSepolia.id → 600n (block ~2s)
      const intent = buildBurnIntent(baseArgs);
      expect(intent.maxBlockHeight).toBe(1000n + 600n);
    });

    it('Arbitrum source: 5000 blocks (~21 分、~0.25s/block 対応)', () => {
      const intent = buildBurnIntent({
        ...baseArgs,
        sourceDomain: 3 as never, // CIRCLE_DOMAIN_ARBITRUM
      });
      // 短い block time に対応するため per-chain map で 5000 blocks 確保
      expect(intent.maxBlockHeight).toBe(1000n + 5000n);
    });

    it('Polygon source: 600 blocks (~20 分、~2s/block)', () => {
      const intent = buildBurnIntent({
        ...baseArgs,
        sourceDomain: 7 as never, // CIRCLE_DOMAIN_POLYGON
      });
      expect(intent.maxBlockHeight).toBe(1000n + 600n);
    });

    it('Optimism source: 600 blocks (~20 分、~2s/block)', () => {
      const intent = buildBurnIntent({
        ...baseArgs,
        sourceDomain: 2 as never, // CIRCLE_DOMAIN_OPTIMISM
      });
      expect(intent.maxBlockHeight).toBe(1000n + 600n);
    });

    it('overrides.maxBlockHeightOffset で offset 上書き', () => {
      const intent = buildBurnIntent({
        ...baseArgs,
        overrides: { maxBlockHeightOffset: 100n },
      });
      expect(intent.maxBlockHeight).toBe(1100n);
    });

    it('maxFee default: value * 10 bps (= value * 0.001)', () => {
      // 5_000_000 * 10 / 10_000 = 5_000
      const intent = buildBurnIntent(baseArgs);
      expect(intent.maxFee).toBe(5_000n);
    });

    it('maxFee 最低値: 1000 atomic (微少額 transfer で 0 にならない)', () => {
      // 1000 atomic * 10 bps / 10000 = 1 → MIN 1000 が効く
      const intent = buildBurnIntent({ ...baseArgs, value: 1000n });
      expect(intent.maxFee).toBe(1000n);
    });

    it('overrides.maxFee で直接指定', () => {
      const intent = buildBurnIntent({
        ...baseArgs,
        overrides: { maxFee: 99_999n },
      });
      expect(intent.maxFee).toBe(99_999n);
    });

    it('overrides.maxFeeBps で比率上書き (50 bps)', () => {
      const intent = buildBurnIntent({
        ...baseArgs,
        overrides: { maxFeeBps: 50n },
      });
      // 5_000_000 * 50 / 10_000 = 25_000
      expect(intent.maxFee).toBe(25_000n);
    });

    it('overrides.sourceSigner で signer 上書き (relayer pattern)', () => {
      const other = getAddress(
        '0x9999999999999999999999999999999999999999',
      );
      const intent = buildBurnIntent({
        ...baseArgs,
        overrides: { sourceSigner: other, salt: FIXED_SALT },
      });
      expect(intent.spec.sourceSigner).toBe(addressToBytes32(other));
      // depositor は変わらない
      expect(intent.spec.sourceDepositor).toBe(addressToBytes32(DEPOSITOR));
    });

    it('overrides.destinationCaller で指定 caller のみが mint 可能', () => {
      const relayer = pad(
        getAddress('0x7777777777777777777777777777777777777777'),
        { size: 32 },
      );
      const intent = buildBurnIntent({
        ...baseArgs,
        overrides: { destinationCaller: relayer, salt: FIXED_SALT },
      });
      expect(intent.spec.destinationCaller).toBe(relayer);
    });
  });

  describe('getBurnIntentTypedData', () => {
    it('domain は name + version のみ (chainId / verifyingContract を含めない)', () => {
      const intent = buildBurnIntent({
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destinationDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destinationToken: DEST_TOKEN,
        depositor: DEPOSITOR,
        recipient: RECIPIENT,
        value: 1_000_000n,
        currentBlockHeight: 0n,
        overrides: { salt: FIXED_SALT },
      });
      const td = getBurnIntentTypedData(intent);
      expect(td.domain).toEqual(GATEWAY_EIP712_DOMAIN);
      expect(td.domain).not.toHaveProperty('chainId');
      expect(td.domain).not.toHaveProperty('verifyingContract');
    });

    it('primaryType = "BurnIntent", types に TransferSpec + BurnIntent を含む', () => {
      const intent = buildBurnIntent({
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destinationDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destinationToken: DEST_TOKEN,
        depositor: DEPOSITOR,
        recipient: RECIPIENT,
        value: 1n,
        currentBlockHeight: 0n,
      });
      const td = getBurnIntentTypedData(intent);
      expect(td.primaryType).toBe('BurnIntent');
      expect(td.types?.TransferSpec).toEqual(TRANSFER_SPEC_TYPED_DATA);
      expect(td.types?.BurnIntent).toEqual(BURN_INTENT_TYPED_DATA);
    });

    it('message に intent 全フィールドが入る', () => {
      const intent = buildBurnIntent({
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destinationDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destinationToken: DEST_TOKEN,
        depositor: DEPOSITOR,
        recipient: RECIPIENT,
        value: 1_000_000n,
        currentBlockHeight: 100n,
        overrides: { salt: FIXED_SALT },
      });
      const td = getBurnIntentTypedData(intent);
      expect(td.message).toMatchObject({
        // currentBlock=100 + chain-aware offset (Base=600) = 700
        maxBlockHeight: 700n,
        maxFee: 1000n,
        spec: intent.spec,
      });
    });
  });

  describe('encodeGatewayMintCalldata', () => {
    it('viem.encodeFunctionData(gatewayMint, [attestation, signature]) と整合', () => {
      const attestation: Hex = '0x1234';
      const signature: Hex = '0xdead';
      const data = encodeGatewayMintCalldata(attestation, signature);
      const decoded = decodeFunctionData({
        abi: GATEWAY_MINTER_ABI,
        data,
      });
      expect(decoded.functionName).toBe('gatewayMint');
      expect(decoded.args[0]).toBe(attestation);
      expect(decoded.args[1]).toBe(signature);
    });
  });

  describe('encodeGatewayDepositCalldata', () => {
    it('viem.encodeFunctionData(deposit, [token, value]) と整合', () => {
      const data = encodeGatewayDepositCalldata(SOURCE_TOKEN, 1_000_000n);
      const decoded = decodeFunctionData({
        abi: GATEWAY_WALLET_ABI,
        data,
      });
      expect(decoded.functionName).toBe('deposit');
      expect(decoded.args[0]).toBe(SOURCE_TOKEN);
      expect(decoded.args[1]).toBe(1_000_000n);
    });
  });

  describe('requestAttestation', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
    });

    it('POST /v1/transfer に signed intent をシリアライズして送信', async () => {
      const intent = buildBurnIntent({
        sourceDomain: CIRCLE_DOMAIN_BASE,
        destinationDomain: CIRCLE_DOMAIN_POLYGON,
        sourceToken: SOURCE_TOKEN,
        destinationToken: DEST_TOKEN,
        depositor: DEPOSITOR,
        recipient: RECIPIENT,
        value: 1_000_000n,
        currentBlockHeight: 100n,
        overrides: { salt: FIXED_SALT },
      });
      const response: AttestationResponse = {
        attestation: '0xabcd',
        signature: '0x1234',
      };
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(response), { status: 200 }),
      );

      const out = await requestAttestation(
        { burnIntent: intent, signature: '0xdeadbeef' },
        { fetch: mockFetch as unknown as typeof fetch },
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/transfer');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].signature).toBe('0xdeadbeef');
      // BigInt はすべて string に落ちている
      expect(typeof body[0].burnIntent.maxBlockHeight).toBe('string');
      // currentBlockHeight=100 + chain-aware offset (Base=600) = 700
      expect(body[0].burnIntent.maxBlockHeight).toBe('700');
      expect(body[0].burnIntent.spec.value).toBe('1000000');

      expect(out).toEqual(response);
    });

    it('baseUrl override で host 差し替え可能', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ attestation: '0x00', signature: '0x00' }),
          { status: 200 },
        ),
      );
      await requestAttestation(
        {
          burnIntent: buildBurnIntent({
            sourceDomain: CIRCLE_DOMAIN_BASE,
            destinationDomain: CIRCLE_DOMAIN_POLYGON,
            sourceToken: SOURCE_TOKEN,
            destinationToken: DEST_TOKEN,
            depositor: DEPOSITOR,
            recipient: RECIPIENT,
            value: 1n,
            currentBlockHeight: 0n,
          }),
          signature: '0x',
        },
        {
          fetch: mockFetch as unknown as typeof fetch,
          baseUrl: 'https://my-staging.example.com',
        },
      );
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://my-staging.example.com/v1/transfer');
    });

    it('non-2xx でエラーメッセージ throw', async () => {
      mockFetch.mockResolvedValue(
        new Response('rate limited', { status: 429 }),
      );
      await expect(
        requestAttestation(
          {
            burnIntent: buildBurnIntent({
              sourceDomain: CIRCLE_DOMAIN_BASE,
              destinationDomain: CIRCLE_DOMAIN_POLYGON,
              sourceToken: SOURCE_TOKEN,
              destinationToken: DEST_TOKEN,
              depositor: DEPOSITOR,
              recipient: RECIPIENT,
              value: 1n,
              currentBlockHeight: 0n,
            }),
            signature: '0x',
          },
          { fetch: mockFetch as unknown as typeof fetch },
        ),
      ).rejects.toThrow(/HTTP 429/);
    });

    it('response が array でも first element を返す (batch shape 対応)', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify([{ attestation: '0xaa', signature: '0xbb' }]),
          { status: 200 },
        ),
      );
      const out = await requestAttestation(
        {
          burnIntent: buildBurnIntent({
            sourceDomain: CIRCLE_DOMAIN_BASE,
            destinationDomain: CIRCLE_DOMAIN_POLYGON,
            sourceToken: SOURCE_TOKEN,
            destinationToken: DEST_TOKEN,
            depositor: DEPOSITOR,
            recipient: RECIPIENT,
            value: 1n,
            currentBlockHeight: 0n,
          }),
          signature: '0x',
        },
        { fetch: mockFetch as unknown as typeof fetch },
      );
      expect(out.attestation).toBe('0xaa');
      expect(out.signature).toBe('0xbb');
    });
  });

});
