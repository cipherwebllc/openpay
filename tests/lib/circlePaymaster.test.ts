import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodePacked, getAddress, type Address, type Hex } from 'viem';
// permit ヘルパは flag 非依存の純関数で lib/circlePermit.ts に分離済 (bundle 対策)。
// loadWithFlag (flag toggling) は不要なので静的 import で直接検証する。
import {
  encodeCirclePaymasterData,
  buildPermitTypedData,
  assertPermitDomain,
} from '@/lib/circlePermit';

// env (flag) はモジュール評価時に確定するため、flag を変える test は
// process.env 設定 → vi.resetModules() → dynamic import の順で観測する。
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

// flag を指定して lib/circlePaymaster と lib/tokens を新鮮な module graph で読む。
async function loadWithFlag(enabled: boolean) {
  vi.resetModules();
  if (enabled) {
    process.env.NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER = '1';
  } else {
    delete process.env.NEXT_PUBLIC_ENABLE_CIRCLE_PAYMASTER;
  }
  const circle = await import('@/lib/circlePaymaster');
  const tokens = await import('@/lib/tokens');
  return { circle, tokens };
}

const MAINNET_V08: Address = getAddress(
  '0x0578cFB241215b77442a541325d6A4E6dFE700Ec',
);
const TESTNET_V08: Address = getAddress(
  '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966',
);

describe('CIRCLE_PAYMASTER_ADDRESSES (allowlist SoT)', () => {
  it('mainnet 7 chain が公式 v0.8 アドレスに揃う', async () => {
    const { circle } = await loadWithFlag(false);
    const a = circle.CIRCLE_PAYMASTER_ADDRESSES;
    // Arbitrum / Avalanche / Base / Ethereum / Optimism / Polygon / Unichain
    for (const id of [42161, 43114, 8453, 1, 10, 137, 130]) {
      expect(a[id]).toBe(MAINNET_V08);
    }
  });

  it('testnet 7 chain が公式 v0.8 アドレスに揃う', async () => {
    const { circle } = await loadWithFlag(false);
    const a = circle.CIRCLE_PAYMASTER_ADDRESSES;
    // Arb Sepolia / Avax Fuji / Base Sepolia / Eth Sepolia / OP Sepolia /
    // Polygon Amoy / Unichain Sepolia
    for (const id of [421614, 43113, 84532, 11155111, 11155420, 80002, 1301]) {
      expect(a[id]).toBe(TESTNET_V08);
    }
  });

  it('v0.7 アドレスを誤って含まない (取り違え防止)', async () => {
    const { circle } = await loadWithFlag(false);
    const all = Object.values(circle.CIRCLE_PAYMASTER_ADDRESSES).map((x) =>
      x.toLowerCase(),
    );
    expect(all).not.toContain(
      '0x6c973ebe80dcd8660841d4356bf15c32460271c9'.toLowerCase(),
    );
    expect(all).not.toContain(
      '0x31be08d380a21fc740883c0bc434fcfc88740b58'.toLowerCase(),
    );
  });

  it('未登録 chain は requireCirclePaymasterAddress で throw', async () => {
    const { circle } = await loadWithFlag(false);
    expect(() => circle.requireCirclePaymasterAddress(999999)).toThrow(
      /allowlist/,
    );
    expect(circle.circlePaymasterAddress(999999)).toBeUndefined();
  });
});

describe('resolveUsdcGaslessProvider', () => {
  it('flag OFF なら常に pimlico (既定)', async () => {
    const { circle, tokens } = await loadWithFlag(false);
    const usdc = tokens.defaultDeploymentForSymbol('usdc');
    expect(circle.resolveUsdcGaslessProvider(usdc, usdc.chainId)).toBe(
      'pimlico',
    );
  });

  it('flag ON + USDC erc20 + Circle 対応 chain (Arb Sepolia/Base Sepolia) で circle', async () => {
    const { circle, tokens } = await loadWithFlag(true);
    for (const id of [421614, 84532]) {
      const d = tokens.resolveDeployment('usdc', id);
      expect(d).toBeDefined();
      expect(circle.resolveUsdcGaslessProvider(d!, id)).toBe('circle');
    }
  });

  it('flag ON でも fee config 無し chain (OP Sepolia/Polygon Amoy) は pimlico', async () => {
    const { circle, tokens } = await loadWithFlag(true);
    for (const id of [11155420, 80002]) {
      const d = tokens.resolveDeployment('usdc', id);
      expect(d).toBeDefined();
      expect(circle.resolveUsdcGaslessProvider(d!, id)).toBe('pimlico');
    }
  });

  it('flag ON でも JPYC (sponsorship) は pimlico', async () => {
    const { circle, tokens } = await loadWithFlag(true);
    const jpyc = tokens.defaultDeploymentForSymbol('jpyc');
    expect(circle.resolveUsdcGaslessProvider(jpyc, jpyc.chainId)).toBe(
      'pimlico',
    );
  });

  it('flag ON でも buyer-only (unavailable) USDC は pimlico', async () => {
    const { circle, tokens } = await loadWithFlag(true);
    const buyerOnly = tokens.TOKEN_DEPLOYMENTS.find(
      (d) => d.symbol === 'usdc' && d.paymasterMode === 'unavailable',
    );
    expect(buyerOnly).toBeDefined();
    expect(
      circle.resolveUsdcGaslessProvider(buyerOnly!, buyerOnly!.chainId),
    ).toBe('pimlico');
  });
});

describe('encodeCirclePaymasterData', () => {
  it('abi.encodePacked(uint8(0), usdc, amount, sig) と一致する', async () => {
    const token = getAddress('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d');
    const permitAmount = 5_000_000n;
    const sig = `0x${'ab'.repeat(65)}` as Hex;
    const got = encodeCirclePaymasterData({
      token,
      permitAmount,
      permitSignature: sig,
    });
    const want = encodePacked(
      ['uint8', 'address', 'uint256', 'bytes'],
      [0, token, permitAmount, sig],
    );
    expect(got).toBe(want);
  });
});

describe('buildPermitTypedData', () => {
  it('deadline=MAX_UINT256 / primaryType=Permit / 全 field を含む', async () => {
    const owner = getAddress('0x1111111111111111111111111111111111111111');
    const spender = TESTNET_V08;
    const td = buildPermitTypedData({
      domain: {
        name: 'USDC',
        version: '2',
        chainId: 421614,
        verifyingContract: getAddress(
          '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        ),
      },
      owner,
      spender,
      value: 5_000_000n,
      nonce: 0n,
    });
    expect(td.primaryType).toBe('Permit');
    expect(td.message.deadline).toBe(2n ** 256n - 1n);
    expect(td.message.owner).toBe(owner);
    expect(td.message.spender).toBe(spender);
    expect(td.message.value).toBe(5_000_000n);
    expect(td.message.nonce).toBe(0n);
  });
});

describe('assertPermitDomain', () => {
  const domain = {
    name: 'USDC',
    version: '2',
    chainId: 421614,
    verifyingContract: getAddress(
      '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    ),
  };

  it('一致すれば throw しない', async () => {
    expect(() =>
      assertPermitDomain(domain, {
        chainId: 421614,
        token: domain.verifyingContract,
      }),
    ).not.toThrow();
  });

  it('chainId 不一致で throw', async () => {
    expect(() =>
      assertPermitDomain(domain, {
        chainId: 8453,
        token: domain.verifyingContract,
      }),
    ).toThrow(/chainId/);
  });

  it('verifyingContract 不一致で throw', async () => {
    expect(() =>
      assertPermitDomain(domain, {
        chainId: 421614,
        token: getAddress('0x0000000000000000000000000000000000000abc'),
      }),
    ).toThrow(/verifyingContract/);
  });
});

describe('CIRCLE_GAS_SURCHARGE_BPS', () => {
  it('Arbitrum/Base (mainnet+testnet) は 10% (1000 bps)', async () => {
    const { circle } = await loadWithFlag(false);
    for (const id of [42161, 8453, 421614, 84532]) {
      expect(circle.CIRCLE_GAS_SURCHARGE_BPS[id]).toBe(1000);
    }
  });

  it('fee 未確認 chain (Optimism/Polygon/Ethereum/Avalanche) は未登録', async () => {
    const { circle } = await loadWithFlag(false);
    for (const id of [10, 137, 1, 43114, 11155420, 80002]) {
      expect(circle.CIRCLE_GAS_SURCHARGE_BPS[id]).toBeUndefined();
    }
  });
});
