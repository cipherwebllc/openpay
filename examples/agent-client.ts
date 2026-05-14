// AI agent simulation: x402-fetch でラップした fetch で paid API を叩く。
// 402 を受け取ったら自動で USDC を sign して再リクエストし、200 + content を取得する。
//
// 実行:
//   AGENT_PRIVATE_KEY=0x... PAID_URL=http://localhost:3000/api/paid/hello \
//     npx tsx examples/agent-client.ts
//
// 必要なもの:
//   - Base Sepolia (testnet) または Base (mainnet) の USDC 残高
//     testnet faucet: https://faucet.circle.com で配布
//   - 上記 chain の ETH (gas)、testnet は同 faucet で配布
//   - 上記を持つ EOA の private key (0x...)。本番秘密鍵を使う場合は
//     最低残高だけ送った "agent-only" の EOA を別途用意することを推奨。
//
// セキュリティ:
//   AGENT_PRIVATE_KEY は **絶対に** フロントエンドや repo にコミットしないこと。
//   本ファイルは server-side / CLI 実行を想定。

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { decodeXPaymentResponse, wrapFetchWithPayment } from 'x402-fetch';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const pk = requireEnv('AGENT_PRIVATE_KEY') as `0x${string}`;
  const url = process.env.PAID_URL ?? 'http://localhost:3000/api/paid/hello';
  const networkEnv = process.env.X402_NETWORK ?? 'base-sepolia';
  const chain = networkEnv === 'base' ? base : baseSepolia;

  const account = privateKeyToAccount(pk);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(),
  });

  // x402-fetch の signer 型は viem WalletClient の subset 期待。viem 側の型と
  // 細部が異なるため unknown 経由で cast (実コードは互換)。
  const paidFetch = wrapFetchWithPayment(
    fetch,
    walletClient as unknown as Parameters<typeof wrapFetchWithPayment>[1],
  );

  console.log(`[agent] requesting ${url}`);
  console.log(`[agent] from address ${account.address} on ${chain.name}`);
  console.log('');

  const res = await paidFetch(url);
  console.log(`[agent] HTTP ${res.status} ${res.statusText}`);

  const xPaymentRespHeader = res.headers.get('x-payment-response');
  if (xPaymentRespHeader) {
    const decoded = decodeXPaymentResponse(xPaymentRespHeader);
    console.log('[agent] x-payment-response:', JSON.stringify(decoded, null, 2));
  }

  const body = await res.json();
  console.log('[agent] body:', JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error('[agent] error:', err);
  process.exit(1);
});
