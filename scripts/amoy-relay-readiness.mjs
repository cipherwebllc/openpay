// Amoy 並行 submit 検証 (Phase B) の前提チェック。読み取り専用。
// relayer EOA の POL 残高 / forwarder・JPYC の存在 / KV 到達性 / 署名元 (buyer) 候補の JPYC 残高を確認。
// 使い方: node scripts/amoy-relay-readiness.mjs [buyerAddress]
// 機密は出さない (RELAYER_PRIVATE_KEY は address だけ導出して表示)。

import { createPublicClient, http, getAddress, formatEther, formatUnits } from 'viem';
import { polygonAmoy } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(join(__dirname, '..', '.env.local'));

const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const RPC = process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL || 'https://rpc-amoy.polygon.technology';
const FORWARDER = process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY;
const FEE_RECEIVER = process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS;
const buyer = process.argv[2];

const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

const client = createPublicClient({ chain: polygonAmoy, transport: http(RPC) });

function ok(b) {
  return b ? '✅' : '❌';
}

async function main() {
  console.log('=== Amoy relay readiness ===');
  console.log('RPC:', RPC);

  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk) {
    console.log('❌ RELAYER_PRIVATE_KEY 未設定');
    process.exit(1);
  }
  const relayer = privateKeyToAccount(pk).address;
  console.log('relayer:', relayer);

  const [pol, relJpyc, sym, nm] = await Promise.all([
    client.getBalance({ address: relayer }),
    client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [relayer] }),
    client.readContract({ address: JPYC, abi: erc20, functionName: 'symbol' }),
    client.readContract({ address: JPYC, abi: erc20, functionName: 'name' }),
  ]);
  const polEth = Number(formatEther(pol));
  console.log(`relayer POL: ${formatEther(pol)} ${ok(polEth >= 0.02)} (>=0.02 推奨)`);
  console.log(`JPYC token: ${nm}/${sym} ${ok(nm && sym)}`);
  console.log(`relayer JPYC: ${formatUnits(relJpyc, 18)} (gas 専用なので 0 が正常)`);

  const fwdCode = await client.getCode({ address: getAddress(FORWARDER) });
  console.log(`forwarder ${FORWARDER}: ${ok(fwdCode && fwdCode !== '0x')} (deployed)`);

  if (FEE_RECEIVER) {
    const frJpyc = await client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [getAddress(FEE_RECEIVER)] });
    console.log(`feeReceiver ${FEE_RECEIVER} JPYC: ${formatUnits(frJpyc, 18)}`);
  }

  if (buyer) {
    const [bPol, bJpyc] = await Promise.all([
      client.getBalance({ address: getAddress(buyer) }),
      client.readContract({ address: JPYC, abi: erc20, functionName: 'balanceOf', args: [getAddress(buyer)] }),
    ]);
    console.log(`\nbuyer ${buyer}:`);
    console.log(`  POL: ${formatEther(bPol)} (gas 不要・署名のみなので 0 でも可)`);
    console.log(`  JPYC: ${formatUnits(bJpyc, 18)} ${ok(bJpyc > 0n)} (並行 submit 件数×(merchant+fee) 以上必要)`);
  } else {
    console.log('\n(buyer address を引数で渡すと JPYC 残高も確認します)');
  }

  // KV 到達性
  const kvUrl = process.env.KV_REST_API_URL;
  const kvTok = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvTok) {
    try {
      const res = await fetch(`${kvUrl.replace(/\/$/, '')}/ping`, {
        headers: { Authorization: `Bearer ${kvTok}` },
      });
      console.log(`\nKV reachable: ${ok(res.ok)} (status ${res.status})`);
    } catch (e) {
      console.log(`\nKV reachable: ❌ (${e.message})`);
    }
  } else {
    console.log('\nKV: ❌ 未設定 (mainnet は必須・Amoy 並行テストでも idempotency 検証に推奨)');
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
