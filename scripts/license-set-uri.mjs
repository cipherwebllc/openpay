import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, stringToHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';

const abi = parseAbi([
  'function uri(uint256 id) view returns (string)',
  'function setURI(uint256 id,string tokenURI)',
]);

export async function main(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args, options: {
    product: { type: 'string' }, chain: { type: 'string', default: 'polygon' }, send: { type: 'boolean', default: false },
  } });
  if (!/^h_[0-9a-f]{32}$/.test(values.product ?? '')) throw new Error('invalid product');
  if (!['polygon', 'amoy'].includes(values.chain)) throw new Error('invalid chain');
  const amoy = values.chain === 'amoy';
  const chain = amoy ? polygonAmoy : polygon;
  const address = getAddress((amoy ? env.NEXT_PUBLIC_LICENSE_NFT_AMOY : env.NEXT_PUBLIC_LICENSE_NFT_POLYGON) ?? '');
  if (address === zeroAddress) throw new Error('missing contract');
  const transport = http((amoy ? env.NEXT_PUBLIC_POLYGON_AMOY_RPC_URL : env.NEXT_PUBLIC_POLYGON_RPC_URL) || chain.rpcUrls.default.http[0]);
  const rpc = createPublicClient({ chain, transport });
  // lib/license/paymentKey.ts の computeLicenseTokenId と同じ UTF-8 hash。
  const tokenId = keccak256(stringToHex('openpay:license:' + values.product));
  const newUri = 'https://open-pay.jp/api/license/metadata/' + values.product;
  const currentUri = await rpc.readContract({ address, abi, functionName: 'uri', args: [BigInt(tokenId)] });
  const call = { address, abi, functionName: 'setURI', args: [BigInt(tokenId), newUri] };
  console.log(JSON.stringify({ mode: values.send ? 'send' : 'dry-run', chain: values.chain, contract: address,
    tokenId, currentUri, newUri, calldata: encodeFunctionData(call) }, null, 2));
  if (!values.send) return;
  const account = privateKeyToAccount(env.LICENSE_OWNER_PRIVATE_KEY);
  const { request } = await rpc.simulateContract({ ...call, account });
  const wallet = createWalletClient({ account, chain, transport });
  const hash = await wallet.writeContract(request);
  console.log('tx hash:', hash);
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  console.log('receipt status:', receipt.status);
  if (receipt.status !== 'success') throw new Error('transaction reverted');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // viem / Node のエラー文には鍵は含まれない (鍵は env からしか読まず、文字列化しない)。
    console.error(error instanceof Error ? error.message.split('\n')[0] : String(error));
    // viem の例外には入力や RPC URL が含まれ得るため、秘密を CLI ログへ波及させない。
    console.error('license-set-uri failed. Check arguments, contract/RPC configuration and owner key; if a tx hash was printed, check its receipt before retrying.');
    process.exitCode = 1;
  });
}
