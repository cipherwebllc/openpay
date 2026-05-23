import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFunctionData, getAddress, type Hex } from 'viem';
import {
  CCTP_V2_TOKEN_MESSENGER_ABI,
  CCTP_V2_MESSAGE_TRANSMITTER_ABI,
  CCTP_FINALITY_FAST,
  CCTP_FINALITY_STANDARD,
  encodeDepositForBurnCalldata,
  encodeReceiveMessageCalldata,
  fetchIrisAttestation,
  pollIrisAttestation,
} from '@/lib/crossChain/cctp';
import { CIRCLE_DOMAIN_BASE, CIRCLE_DOMAIN_POLYGON } from '@/lib/crossChain/types';

const RECIPIENT = getAddress('0x000000000000000000000000000000000000aBcd');
const TOKEN = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e'); // Base Sepolia USDC

describe('lib/crossChain/cctp encode helpers', () => {
  describe('encodeDepositForBurnCalldata', () => {
    it('Fast finality (1000) default + 7 引数を viem encode', () => {
      const data = encodeDepositForBurnCalldata({
        value: 5_000_000n,
        destinationDomain: CIRCLE_DOMAIN_POLYGON,
        recipient: RECIPIENT,
        burnToken: TOKEN,
      });
      const decoded = decodeFunctionData({
        abi: CCTP_V2_TOKEN_MESSENGER_ABI,
        data,
      });
      expect(decoded.functionName).toBe('depositForBurn');
      const [
        amount,
        destDomain,
        mintRecipient,
        burnToken,
        destCaller,
        maxFee,
        minFinality,
      ] = decoded.args;
      expect(amount).toBe(5_000_000n);
      expect(destDomain).toBe(CIRCLE_DOMAIN_POLYGON);
      // recipient は bytes32 化されている (左 0-pad)
      expect(mintRecipient).toBe(
        '0x000000000000000000000000000000000000000000000000000000000000abcd',
      );
      expect(burnToken).toBe(TOKEN);
      // permissionless destinationCaller = 0x0...
      expect(destCaller).toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      );
      // 5_000_000 × 10bps / 10000 = 5000
      expect(maxFee).toBe(5000n);
      expect(minFinality).toBe(CCTP_FINALITY_FAST);
    });

    it('overrides.minFinalityThreshold = STANDARD (2000) で V1 互換 mode', () => {
      const data = encodeDepositForBurnCalldata({
        value: 1_000_000n,
        destinationDomain: CIRCLE_DOMAIN_BASE,
        recipient: RECIPIENT,
        burnToken: TOKEN,
        overrides: { minFinalityThreshold: CCTP_FINALITY_STANDARD },
      });
      const decoded = decodeFunctionData({
        abi: CCTP_V2_TOKEN_MESSENGER_ABI,
        data,
      });
      expect(decoded.args[6]).toBe(2000);
    });

    it('overrides.maxFee で直接指定', () => {
      const data = encodeDepositForBurnCalldata({
        value: 1_000_000n,
        destinationDomain: CIRCLE_DOMAIN_BASE,
        recipient: RECIPIENT,
        burnToken: TOKEN,
        overrides: { maxFee: 12345n },
      });
      const decoded = decodeFunctionData({
        abi: CCTP_V2_TOKEN_MESSENGER_ABI,
        data,
      });
      expect(decoded.args[5]).toBe(12345n);
    });

    it('微少額 transfer で maxFee = 1000 atomic min が効く', () => {
      const data = encodeDepositForBurnCalldata({
        value: 100n,
        destinationDomain: CIRCLE_DOMAIN_BASE,
        recipient: RECIPIENT,
        burnToken: TOKEN,
      });
      const decoded = decodeFunctionData({
        abi: CCTP_V2_TOKEN_MESSENGER_ABI,
        data,
      });
      expect(decoded.args[5]).toBe(1000n);
    });

    it('overrides.destinationCaller で specific caller 限定', () => {
      const caller =
        '0x0000000000000000000000007777777777777777777777777777777777777777';
      const data = encodeDepositForBurnCalldata({
        value: 1_000_000n,
        destinationDomain: CIRCLE_DOMAIN_BASE,
        recipient: RECIPIENT,
        burnToken: TOKEN,
        overrides: { destinationCaller: caller },
      });
      const decoded = decodeFunctionData({
        abi: CCTP_V2_TOKEN_MESSENGER_ABI,
        data,
      });
      expect(decoded.args[4]).toBe(caller);
    });
  });

  describe('encodeReceiveMessageCalldata', () => {
    it('receiveMessage(message, attestation) calldata 生成', () => {
      const message: Hex = '0xdeadbeef';
      const attestation: Hex = '0xcafebabe';
      const data = encodeReceiveMessageCalldata(message, attestation);
      const decoded = decodeFunctionData({
        abi: CCTP_V2_MESSAGE_TRANSMITTER_ABI,
        data,
      });
      expect(decoded.functionName).toBe('receiveMessage');
      expect(decoded.args[0]).toBe(message);
      expect(decoded.args[1]).toBe(attestation);
    });
  });
});

describe('lib/crossChain/cctp iris API', () => {
  describe('fetchIrisAttestation', () => {
    it('GET /v2/messages/{domain}?transactionHash={hash}', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            messages: [
              {
                status: 'complete',
                message: '0xaa',
                attestation: '0xbb',
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const result = await fetchIrisAttestation(
        CIRCLE_DOMAIN_BASE,
        '0x1234' as Hex,
        { fetch: mockFetch as unknown as typeof fetch },
      );
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v2/messages/6?transactionHash=0x1234');
      expect(init.method).toBe('GET');
      expect(result.messages[0].status).toBe('complete');
    });

    it('non-2xx は throw', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('rate limited', { status: 429 }),
      );
      await expect(
        fetchIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1234' as Hex, {
          fetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(/HTTP 429/);
    });

    it('baseUrl override 効く', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      );
      await fetchIrisAttestation(CIRCLE_DOMAIN_BASE, '0x99' as Hex, {
        fetch: mockFetch as unknown as typeof fetch,
        baseUrl: 'https://staging.example.com',
      });
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://staging.example.com/v2/messages/6?transactionHash=0x99',
      );
    });
  });

  describe('pollIrisAttestation', () => {
    let calls: number;
    let sleepMock: ReturnType<typeof vi.fn>;
    let nowMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      calls = 0;
      sleepMock = vi.fn().mockResolvedValue(undefined);
      // 各 poll 呼出で 1000ms 進む
      let t = 0;
      nowMock = vi.fn(() => {
        t += 1000;
        return t;
      });
    });

    it('immediate complete: 1 fetch で返す', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            messages: [
              { status: 'complete', message: '0xff', attestation: '0x11' },
            ],
          }),
          { status: 200 },
        ),
      );
      const result = await pollIrisAttestation(
        CIRCLE_DOMAIN_BASE,
        '0x1' as Hex,
        {
          fetch: mockFetch as unknown as typeof fetch,
          sleep: sleepMock,
          now: nowMock,
        },
      );
      expect(result.status).toBe('complete');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it('pending → complete: poll loop が completion を待つ', async () => {
      const responses = [
        new Response(
          JSON.stringify({
            messages: [{ status: 'pending_confirmations' }],
          }),
          { status: 200 },
        ),
        new Response(
          JSON.stringify({
            messages: [{ status: 'pending_confirmations' }],
          }),
          { status: 200 },
        ),
        new Response(
          JSON.stringify({
            messages: [
              { status: 'complete', message: '0xab', attestation: '0xcd' },
            ],
          }),
          { status: 200 },
        ),
      ];
      const mockFetch = vi.fn(async () => {
        calls++;
        return responses[calls - 1];
      });
      const result = await pollIrisAttestation(
        CIRCLE_DOMAIN_BASE,
        '0x1' as Hex,
        {
          fetch: mockFetch as unknown as typeof fetch,
          sleep: sleepMock,
          now: nowMock,
          intervalMs: 100,
        },
      );
      expect(result.attestation).toBe('0xcd');
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledTimes(2);
      // interval 引数が正しく渡されている
      expect(sleepMock.mock.calls[0][0]).toBe(100);
    });

    it('timeout 超過で throw', async () => {
      // 各 fetch ごとに now が 50_000ms 進むよう mock (= 2 回目で timeout 超え)
      let t = 0;
      const nowMockBig = vi.fn(() => {
        const cur = t;
        t += 50_000;
        return cur;
      });
      // Response.body は 1 度しか read できないので、毎回新規 Response を返す
      const mockFetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ messages: [{ status: 'pending_confirmations' }] }),
            { status: 200 },
          ),
      );
      await expect(
        pollIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
          fetch: mockFetch as unknown as typeof fetch,
          sleep: sleepMock,
          now: nowMockBig,
          timeoutMs: 90_000,
        }),
      ).rejects.toThrow(/timeout/);
    });

    it('complete でも message/attestation が無いと skip して poll 継続', async () => {
      const responses = [
        new Response(
          JSON.stringify({
            // complete だが message が欠落 → skip
            messages: [{ status: 'complete' }],
          }),
          { status: 200 },
        ),
        new Response(
          JSON.stringify({
            messages: [
              { status: 'complete', message: '0xa', attestation: '0xb' },
            ],
          }),
          { status: 200 },
        ),
      ];
      let i = 0;
      const mockFetch = vi.fn(async () => responses[i++]);
      const result = await pollIrisAttestation(
        CIRCLE_DOMAIN_BASE,
        '0x1' as Hex,
        {
          fetch: mockFetch as unknown as typeof fetch,
          sleep: sleepMock,
          now: nowMock,
        },
      );
      expect(result.message).toBe('0xa');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe('lib/crossChain/cctp: edge cases + 境界条件', () => {
  it('depositForBurn: value=0 でも encode 可能 (call site 側で gate)', () => {
    const data = encodeDepositForBurnCalldata({
      value: 0n,
      destinationDomain: CIRCLE_DOMAIN_BASE,
      recipient: RECIPIENT,
      burnToken: TOKEN,
    });
    const decoded = decodeFunctionData({
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
      data,
    });
    expect(decoded.args[0]).toBe(0n);
    // 0 * 10bps / 10000 = 0 → MIN 1000 が効く
    expect(decoded.args[5]).toBe(1000n);
  });

  it('depositForBurn: uint256 max value でも encode 通る', () => {
    const max = (1n << 256n) - 1n;
    const data = encodeDepositForBurnCalldata({
      value: max,
      destinationDomain: CIRCLE_DOMAIN_BASE,
      recipient: RECIPIENT,
      burnToken: TOKEN,
    });
    const decoded = decodeFunctionData({
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
      data,
    });
    expect(decoded.args[0]).toBe(max);
  });

  it('encodeReceiveMessageCalldata: 空 bytes ("0x") を受け付ける', () => {
    const data = encodeReceiveMessageCalldata('0x', '0x');
    const decoded = decodeFunctionData({
      abi: CCTP_V2_MESSAGE_TRANSMITTER_ABI,
      data,
    });
    expect(decoded.args[0]).toBe('0x');
    expect(decoded.args[1]).toBe('0x');
  });

  it('iris API: 巨大 message body (~10KB) でも JSON parse 通る', async () => {
    const longMessage = ('0x' + 'ab'.repeat(5000)) as Hex;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [
            {
              status: 'complete',
              message: longMessage,
              attestation: '0xsig',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await pollIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
      fetch: mockFetch as unknown as typeof fetch,
      sleep: vi.fn(async (_ms: number) => undefined),
      now: () => 0,
    });
    expect(result.message).toBe(longMessage);
  });

  it('iris API: multi-message response (multi-burn) では first complete を返す', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [
            { status: 'pending_confirmations' },
            { status: 'complete', message: '0xfirst', attestation: '0xsig1' },
            { status: 'complete', message: '0xsecond', attestation: '0xsig2' },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await pollIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
      fetch: mockFetch as unknown as typeof fetch,
      sleep: vi.fn(async (_ms: number) => undefined),
      now: () => 0,
    });
    expect(result.message).toBe('0xfirst');
    expect(result.attestation).toBe('0xsig1');
  });

  it('iris API: HTTP 5xx error → throw (transient retry は caller 責務)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('internal server error', { status: 500 }),
    );
    await expect(
      fetchIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('iris API: malformed JSON response → SyntaxError throw', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<html>blocked by waf</html>', { status: 200 }),
    );
    await expect(
      fetchIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });

  it('iris polling: 初回 fetch 後すぐ complete → sleep 1 回も呼ばれない', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ status: 'complete', message: '0xa', attestation: '0xb' }],
        }),
        { status: 200 },
      ),
    );
    const sleepMock = vi.fn(async (_ms: number) => undefined);
    await pollIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
      fetch: mockFetch as unknown as typeof fetch,
      sleep: sleepMock,
      now: () => 0,
    });
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('concurrent: 同一 tx hash 3 並列 polling → 各々独立に動く', async () => {
    let i = 0;
    const responses = [
      JSON.stringify({
        messages: [{ status: 'complete', message: '0x1', attestation: '0xa' }],
      }),
      JSON.stringify({
        messages: [{ status: 'complete', message: '0x2', attestation: '0xb' }],
      }),
      JSON.stringify({
        messages: [{ status: 'complete', message: '0x3', attestation: '0xc' }],
      }),
    ];
    const mockFetch = vi.fn(async () => {
      const body = responses[i++ % responses.length];
      return new Response(body, { status: 200 });
    });
    const results = await Promise.all([
      pollIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
        fetch: mockFetch as unknown as typeof fetch,
        sleep: vi.fn(async (_ms: number) => undefined),
        now: () => 0,
      }),
      pollIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
        fetch: mockFetch as unknown as typeof fetch,
        sleep: vi.fn(async (_ms: number) => undefined),
        now: () => 0,
      }),
      pollIrisAttestation(CIRCLE_DOMAIN_BASE, '0x1' as Hex, {
        fetch: mockFetch as unknown as typeof fetch,
        sleep: vi.fn(async (_ms: number) => undefined),
        now: () => 0,
      }),
    ]);
    expect(results.map((r) => r.message)).toEqual(['0x1', '0x2', '0x3']);
  });
});
