// アドレスの大文字小文字 (EIP-55 checksum) のフェンス。
// viem は checksum の合わない混在表記を「不正なアドレス」として拒否する (readContract / writeContract とも)。
// 2026-10-05: World Chain / Sonic の USDC が誤記のまま本番に出ていて、cross-chain の残高照会と支払いが
// 失敗していた (Sentry の breadcrumb `[xchain-diag] ... Address ... is invalid` で発覚)。既存テストは
// toLowerCase() で比べていたので気づけなかった。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, isAddress } from 'viem';

const SOURCE_ROOTS = ['lib', 'app', 'components', 'hooks', 'packages/x402-sdk/src', 'packages/x402-mcp/src'];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(path);
      } else if (/\.(tsx?|m?js|json)$/.test(entry.name)) files.push(path);
    }
  };
  SOURCE_ROOTS.forEach(walk);
  return files;
}

describe('アドレス表記の checksum', () => {
  it('ソース中の大文字小文字が混ざったアドレスはすべて EIP-55 の checksum どおり', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
        const hex = m[0].slice(2);
        // 全部小文字 / 全部大文字は checksum を持たない表記として viem も受け付ける。
        if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) continue;
        checked += 1;
        const expected = getAddress(m[0].toLowerCase());
        if (expected !== m[0]) wrong.push(`${file}: ${m[0]} → ${expected}`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(wrong).toEqual([]);
  });

  describe('TOKEN_DEPLOYMENTS の全アドレスが viem の厳密な検査を通る', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
      vi.resetModules();
    });

    it.each(['testnet', 'mainnet'])('%s', async (network) => {
      vi.resetModules();
      process.env.NEXT_PUBLIC_NETWORK_ENV = network;
      process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS = '0xdead000000000000000000000000000000001234';
      process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
      process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_test';
      const { TOKEN_DEPLOYMENTS } = await import('@/lib/tokens');
      expect(TOKEN_DEPLOYMENTS.length).toBeGreaterThan(5);
      const invalid = TOKEN_DEPLOYMENTS.filter((d) => !isAddress(d.address)).map(
        (d) => `${d.symbol}@${d.chainId}: ${d.address}`,
      );
      expect(invalid).toEqual([]);
    });
  });
});
