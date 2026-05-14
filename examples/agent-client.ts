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

import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { decodeXPaymentResponse, wrapFetchWithPayment } from 'x402-fetch';

type PaidApiResult = {
  status: number;
  body: unknown;
  paymentResponse: ReturnType<typeof decodeXPaymentResponse> | null;
};

// test 可能にするため walletClient と fetch を引数で受ける。
export async function callPaidApi(
  url: string,
  walletClient: WalletClient,
  fetchImpl: typeof fetch = fetch,
): Promise<PaidApiResult> {
  const paidFetch = wrapFetchWithPayment(
    fetchImpl,
    walletClient as unknown as Parameters<typeof wrapFetchWithPayment>[1],
  );
  const res = await paidFetch(url);
  const xPaymentRespHeader = res.headers.get('x-payment-response');
  const paymentResponse = xPaymentRespHeader
    ? decodeXPaymentResponse(xPaymentRespHeader)
    : null;
  const body = (await res.json()) as unknown;
  return { status: res.status, body, paymentResponse };
}

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

  console.log(`[agent] requesting ${url}`);
  console.log(`[agent] from address ${account.address} on ${chain.name}`);
  console.log('');

  const result = await callPaidApi(url, walletClient);
  console.log(`[agent] HTTP ${result.status}`);
  if (result.paymentResponse) {
    console.log(
      '[agent] x-payment-response:',
      JSON.stringify(result.paymentResponse, null, 2),
    );
  }
  console.log('[agent] body:', JSON.stringify(result.body, null, 2));
}

// 直接実行された時のみ main() を起動。import される時は副作用なし (test 可能)。
const isDirectRun =
  typeof require !== 'undefined'
    ? require.main === module
    : import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main().catch((err) => {
    console.error('[agent] error:', err);
    process.exit(1);
  });
}
