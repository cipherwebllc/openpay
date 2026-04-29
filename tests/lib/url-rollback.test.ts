// multi-chain (chain= パラメタ) 導入前の v1 parser を本リポジトリ内で再現する
// 凍結 fixture。Phase 1 multi-chain commit 以前への rollback を行うと、流通中の
// `chain=arbitrum/optimism/polygon` URL を旧 parser が silent に ignore して
// 顧客が誤チェーン (Base) に送金する事故が起こり得る — その挙動を test code
// で permanent に記録し、誤って前のバージョンへ rollback した時の事故を再現
// 可能にしておく。README §ロールバック の「multi-chain URL 後の rollback は
// silent fund misdirection」警告の根拠。
//
// fixture は `lib/url.ts` の chain サポート前のロジックを最小再現する。実装は
// 現リポジトリの parsePayParams を import せず、独立した関数として固定する
// ことで「rollback 後の挙動」を厳密に表現する (現実装の更新で fixture が
// 動かなくなるのを防ぐ)。

import { describe, it, expect } from 'vitest';
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';

// === 凍結 v1 parser (chain サポート前の挙動) ===
type LegacyToken = 'jpyc' | 'usdc';
type LegacyMode = 'gasless' | 'direct';
type LegacyGasMode = 'customer' | 'merchant';

type LegacyParsedParams = {
  to: Address;
  token: LegacyToken;
  // v1 では chain は無く、token から固定的に決まる:
  //   jpyc → polygon (Polygon Amoy / Polygon mainnet)
  //   usdc → base    (Base Sepolia / Base mainnet)
  resolvedChain: 'polygon' | 'base';
  gas: LegacyGasMode;
  amount?: string;
  mode: LegacyMode;
};

type LegacyParseResult =
  | { ok: true; params: LegacyParsedParams }
  | { ok: false; error: string };

function legacyParsePayParams(sp: URLSearchParams): LegacyParseResult {
  const to = sp.get('to');
  const token = sp.get('token');
  const gasRaw = sp.get('gas');
  const amount = sp.get('amount');
  const mode = sp.get('mode');
  // 注意: v1 parser は `chain` パラメタを認識しない (sp.get しない)。
  // これが silent fund misdirection の根本原因 — 新 client が付加した
  // chain=arbitrum を旧 client は読まずに token-based default で処理する。

  if (!to) return { ok: false, error: 'no to' };
  if (!isAddress(to)) return { ok: false, error: 'bad to' };
  if (token !== 'jpyc' && token !== 'usdc') return { ok: false, error: 'bad token' };
  if (mode !== null && mode !== 'gasless' && mode !== 'direct') {
    return { ok: false, error: 'bad mode' };
  }
  const gas: LegacyGasMode = gasRaw === 'merchant' ? 'merchant' : 'customer';
  return {
    ok: true,
    params: {
      to: getAddress(to),
      token,
      // v1 の hard-coded mapping
      resolvedChain: token === 'jpyc' ? 'polygon' : 'base',
      gas,
      amount: amount && amount.length > 0 ? amount : undefined,
      mode: mode === 'direct' ? 'direct' : 'gasless',
    },
  };
}

const MERCHANT = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

describe('Legacy v1 parser fixture (rollback silent misdirection の証拠)', () => {
  function search(query: string): URLSearchParams {
    return new URLSearchParams(query);
  }

  it('v1 parser は chain= パラメタを silent ignore する (root cause)', () => {
    const r = legacyParsePayParams(
      search(`to=${MERCHANT}&token=usdc&chain=arbitrum&amount=10`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // chain=arbitrum を URL に含めても、v1 parser は token から固定 mapping で
      // base に解決してしまう。新 client が発行した URL を旧 client が処理すると
      // 顧客は意図 (Arbitrum) と異なるチェーン (Base) で送金される。
      expect(r.params.resolvedChain).toBe('base');
      expect(r.params.token).toBe('usdc');
      expect(r.params.amount).toBe('10');
    }
  });

  it.each(['arbitrum', 'optimism', 'polygon', 'invalid-chain'])(
    'chain=%s でも v1 は無視して base に倒す (silent ignore のため未知値も拒否しない)',
    (chain) => {
      const r = legacyParsePayParams(
        search(`to=${MERCHANT}&token=usdc&chain=${chain}`),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.params.resolvedChain).toBe('base');
    },
  );

  it('v1 parser の正常 path: chain なし URL は破壊なく動く (forward compat)', () => {
    const r = legacyParsePayParams(search(`to=${MERCHANT}&token=usdc`));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.resolvedChain).toBe('base');
  });

  it('v1 parser は jpyc + chain= 系の組合せでも token 由来 polygon に倒す', () => {
    const r = legacyParsePayParams(
      search(`to=${MERCHANT}&token=jpyc&chain=arbitrum`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.resolvedChain).toBe('polygon');
  });
});

describe('現実装 (multi-chain) との挙動差分 — rollback 危険性の対比', () => {
  it('現実装は chain=arbitrum を Arbitrum に解決、v1 fixture は Base に倒す → 同 URL で chain が変わる', async () => {
    const url = `to=${MERCHANT}&token=usdc&chain=arbitrum&amount=10`;
    const sp = new URLSearchParams(url);

    // v1 parser (rollback 後)
    const legacy = legacyParsePayParams(sp);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.params.resolvedChain).toBe('base');
    }

    // 現実装 (Phase 1 multi-chain)
    const { parsePayParams } = await import('@/lib/url');
    const current = parsePayParams(sp);
    expect(current.ok).toBe(true);
    if (current.ok) {
      expect(current.params.chain).toBe('arbitrum');
    }

    // 同じ URL で resolved chain が異なる → rollback すると顧客送金先 chain が
    // silent に変わる = fund misdirection。これが README 警告の根拠。
  });
});
