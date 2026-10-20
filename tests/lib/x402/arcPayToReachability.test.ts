// 「Arc (Circle Gateway) でも販売する」の受取先 fence。コントラクトの受取先は Arc の売上を引き出せない
// (受取アドレスの署名が要る) ので、登録・変更で断る。RPC 障害は fail-closed (Arc の同意だけが止まる)。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  codes: new Map<number, string | undefined | Error>(),
  createPublicClient: vi.fn(),
  transportForChain: vi.fn(),
  network: 'base' as string | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: mocks.createPublicClient };
});
vi.mock('@/lib/chains', () => ({
  arc: { id: 5042 },
  arcTestnet: { id: 5042002 },
  transportForChain: mocks.transportForChain,
}));
vi.mock('@/lib/x402/config', () => ({
  x402Config: {
    get network() {
      return mocks.network;
    },
  },
}));

import { arcPayToRejection, checkArcPayToReachability } from '@/lib/x402/arcPayToReachability';
import { isNonDelegatedContractCode } from '@/lib/accountCode';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const DELEGATED = `0xef0100${'22'.repeat(20)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.codes.clear();
  mocks.network = 'base';
  mocks.transportForChain.mockImplementation((id: number) => `transport-${id}`);
  mocks.createPublicClient.mockImplementation(({ chain }: { chain: { id: number } }) => ({
    getBytecode: vi.fn(async () => {
      const code = mocks.codes.get(chain.id);
      if (code instanceof Error) throw code;
      return code;
    }),
  }));
});

describe('isNonDelegatedContractCode', () => {
  it.each([[undefined, false], ['0x', false], [DELEGATED, false], [DELEGATED.toUpperCase().replace('0XEF', '0xef'), false],
    ['0x6000', true], [`${DELEGATED}00`, true]] as const)('%s → %s', (code, expected) => {
    expect(isNonDelegatedContractCode(code as `0x${string}` | undefined)).toBe(expected);
  });
});

describe('checkArcPayToReachability', () => {
  it('Base と Arc mainnet の両方でコードが無ければ (または 7702 の委任なら) 通す', async () => {
    mocks.codes.set(5042, DELEGATED);
    await expect(checkArcPayToReachability(PAY_TO)).resolves.toEqual({ ok: true, payTo: PAY_TO });
    expect(mocks.transportForChain.mock.calls.map(([id]) => id).sort((a, b) => a - b)).toEqual([5042, 8453]);
  });

  it.each([[8453], [5042]])('chain %s でコントラクトなら contract_wallet', async (chainId) => {
    mocks.codes.set(chainId, '0x6000');
    await expect(checkArcPayToReachability(PAY_TO)).resolves.toEqual({ ok: false, reason: 'contract_wallet' });
  });

  it('x402 が base-sepolia なら Base Sepolia と Arc testnet を見る', async () => {
    mocks.network = 'base-sepolia';
    await checkArcPayToReachability(PAY_TO);
    expect(mocks.transportForChain.mock.calls.map(([id]) => id).sort((a, b) => a - b)).toEqual([84532, 5042002]);
  });

  it('RPC 障害は EOA と誤認せず rpc_unavailable (fail-closed)', async () => {
    mocks.codes.set(5042, new Error('timeout'));
    await expect(checkArcPayToReachability(PAY_TO)).resolves.toEqual({ ok: false, reason: 'rpc_unavailable' });
  });

  it('不正なアドレスは RPC を呼ばずに invalid', async () => {
    await expect(checkArcPayToReachability('0x1234')).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(mocks.createPublicClient).not.toHaveBeenCalled();
  });
});

describe('arcPayToRejection (登録・変更の route が使う)', () => {
  it('Arc に同意していなければ RPC を呼ばずに通す', async () => {
    await expect(arcPayToRejection(undefined)).resolves.toBeNull();
    await expect(arcPayToRejection({ payTo: PAY_TO })).resolves.toBeNull();
    expect(mocks.createPublicClient).not.toHaveBeenCalled();
  });

  it('同意済みで受取先も同じ変更 (説明文の編集等) は検査しない — RPC 障害で無関係な編集を止めない', async () => {
    mocks.codes.set(5042, new Error('down'));
    await expect(arcPayToRejection({ payTo: PAY_TO, arc: true }, { payTo: PAY_TO, arc: true })).resolves.toBeNull();
    expect(mocks.createPublicClient).not.toHaveBeenCalled();
  });

  it.each([
    ['新規登録', undefined],
    ['同意を新しく付ける (false → true)', { payTo: PAY_TO }],
    ['受取先を変える', { payTo: '0x2222222222222222222222222222222222222222', arc: true }],
  ])('%s は検査する (コントラクト → 400)', async (_label, prev) => {
    mocks.codes.set(8453, '0x6000');
    await expect(arcPayToRejection({ payTo: PAY_TO, arc: true }, prev)).resolves.toEqual({
      error: 'usdc_arc_contract_pay_to', status: 400,
    });
  });

  it('RPC 障害は 503 usdc_arc_check_unavailable', async () => {
    mocks.codes.set(8453, new Error('down'));
    await expect(arcPayToRejection({ payTo: PAY_TO, arc: true })).resolves.toEqual({
      error: 'usdc_arc_check_unavailable', status: 503,
    });
  });

  it('EOA なら通す', async () => {
    await expect(arcPayToRejection({ payTo: PAY_TO, arc: true })).resolves.toBeNull();
  });
});
