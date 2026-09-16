#!/usr/bin/env node
// Read-only by default. --send is an operator action; never print/load a key before discovery.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, pad, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const argv = process.argv.slice(2);
const option = (key) => argv[argv.indexOf(key) + 1];
const required = (key) => {
  if (!argv.includes(key) || !option(key) || option(key).startsWith('--')) throw new Error(`Required: ${key}`);
  return option(key);
};
if (argv.includes('--help')) {
  console.log('Node >= 22.18: node scripts/arc-forward-rescue.mjs --network testnet|mainnet --burn 0x... --source-domain 6 --source-token 0x... --recipient 0x... --amount 1000000 --gross ... --max-fee ... --from-block ... [--send]');
  process.exit(0);
}
const network = required('--network');
if (!['mainnet', 'testnet'].includes(network)) throw new Error('Invalid network');
process.env.NEXT_PUBLIC_NETWORK_ENV = network;
const moduleUrl = pathToFileURL(resolve('lib/crossChain/cctp.ts')).href;
// Node type stripping + the one extensionless runtime import in cctp.ts. The verifier is shared
// with the app so rescue cannot silently use receipt-status-only completion.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === moduleUrl && specifier === '../env') return nextResolve(new URL('../env.ts', moduleUrl).href, context);
  return nextResolve(specifier, context);
} });
const cctp = await import(moduleUrl);
const chain = defineChain({ id: network === 'mainnet' ? 5042 : 5042002, name: `Arc ${network}`,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [network === 'mainnet' ? required('--rpc') : 'https://rpc.testnet.arc.io'] } } });
const destClient = createPublicClient({ chain, transport: http() });
const sourceDomain = Number(required('--source-domain'));
const burn = required('--burn');
const message = await cctp.pollIrisForward(sourceDomain, burn);
const nonce = message?.decodedMessage?.nonce ?? message?.eventNonce;
if (!nonce || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error('Circle nonce unavailable; wait or contact Circle with the burn hash');
const expected = { destClient, sourceDomain, nonce, mintRecipient: required('--recipient'),
  mintToken: cctp.ARC_USDC_ADDRESS, burnToken: required('--source-token'),
  minAmount: BigInt(required('--amount')), grossAmount: BigInt(required('--gross')), maxFee: BigInt(required('--max-fee')) };
let cursor = BigInt(required('--from-block'));
const head = await destClient.getBlockNumber();
while (cursor <= head) {
  const found = await cctp.findForwardMintByNonce(destClient, { nonce, sourceDomain, fromBlock: cursor });
  for (const txHash of found.hashes) {
    const verified = await cctp.verifyForwardMint({ ...expected, txHash });
    if (verified.ok) { console.log(`Already verified: ${txHash}`); process.exit(0); }
    throw new Error(`Nonce already delivered but expected payment does not match (${verified.reason}); do not resend`);
  }
  if (found.scannedToBlock >= head) break;
  cursor = found.nextBlock;
}
if (!message?.message || !message?.attestation || message.attestation === 'PENDING') {
  throw new Error(`Attestation unavailable. Try POST ${cctp.CCTP_IRIS_API_BASE_URL}/v2/reattest/${nonce}, then poll again; contact Circle if unresolved.`);
}
const body = cctp.decodeBurnMessageBody(`0x${message.message.slice(2 + 148 * 2)}`);
// Operator typo/mismatched burn must not spend relayer gas on an unrelated payment.
if (Number(BigInt(`0x${message.message.slice(10, 18)}`)) !== sourceDomain ||
    Number(BigInt(`0x${message.message.slice(18, 26)}`)) !== 26 ||
    body.burnToken.toLowerCase() !== pad(expected.burnToken).toLowerCase() ||
    body.mintRecipient.toLowerCase() !== pad(expected.mintRecipient).toLowerCase() ||
    body.amount !== expected.grossAmount || body.maxFee !== expected.maxFee ||
    body.hookData !== cctp.CCTP_FORWARD_HOOK_DATA ||
    `0x${message.message.slice(2 + 108 * 2, 2 + 140 * 2)}` !== pad(zeroAddress)) throw new Error('Message binding mismatch');
if (!argv.includes('--send')) { console.log(`No verified mint found. Review nonce ${nonce} and rerun with --send if authorized.`); process.exit(0); }
const key = process.env.MAINNET_RELAYER_PRIVATE_KEY;
if (!key) throw new Error('MAINNET_RELAYER_PRIVATE_KEY required for --send');
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http() });
const txHash = await wallet.sendTransaction({ to: cctp.CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
  data: cctp.encodeReceiveMessageCalldata(message.message, message.attestation) });
await destClient.waitForTransactionReceipt({ hash: txHash });
const verified = await cctp.verifyForwardMint({ ...expected, txHash });
if (!verified.ok) throw new Error(`Rescue not verified: ${txHash} (${verified.reason})`);
console.log(`Verified rescue: ${txHash}. The buyer can recheck to adopt this mint.`);
