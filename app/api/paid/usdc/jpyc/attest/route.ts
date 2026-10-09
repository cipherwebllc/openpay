import { NextResponse, type NextRequest } from 'next/server';
import { getAddress, isAddress, zeroAddress, type Hex } from 'viem';
import { parseRequiredChainParam } from '@/lib/jpyc/live';
import { readJpycPaymentRecord } from '@/lib/jpyc/paymentRecord';
import {
  JPYC_PAYMENT_ATTESTATION_EIP712_DOMAIN, JPYC_PAYMENT_ATTESTATION_TYPES,
  signJpycPaymentAttestation, transfersHash,
} from '@/lib/jpyc/paymentAttestation';
import { receiptSignerAddress, receiptSigningAccount } from '@/lib/x402/receipt';
import { USDC_JPYC_ATTEST } from '@/lib/jpyc/liveResources';
import { envelope, gated, invalidQuery, rpcUnavailable, signerUnavailable } from '@/lib/jpyc/liveRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const KEYS = new Set(['chain', 'tx']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = new URL(request.url).searchParams;
  for (const key of sp.keys()) if (!KEYS.has(key) || sp.getAll(key).length !== 1) return invalidQuery();
  const chainRaw = sp.get('chain');
  const chain = parseRequiredChainParam(chainRaw);
  const tx = sp.get('tx');
  if ((chainRaw !== null && !chain) || (tx !== null && !/^0x[0-9a-fA-F]{64}$/.test(tx))) return invalidQuery();
  return gated(request, USDC_JPYC_ATTEST, async ({ payer }) => {
    // 署名付きの証明が商品なので、署名鍵が無ければ課金しない (第 7 回レビュー E3・RPC を読む前に)
    if (!receiptSigningAccount()) return signerUnavailable();
    if (!chain || !tx) return invalidQuery();
    const result = await readJpycPaymentRecord(chain, tx as Hex);
    if (result.kind === 'rpc_error') return rpcUnavailable();
    if (result.kind !== 'ok') {
      return NextResponse.json({ ok: false, error: result.kind === 'not_found' ? 'tx_not_found' : 'no_jpyc_transfer' }, { status: 404 });
    }
    const licensee = payer && isAddress(payer) ? getAddress(payer) : null;
    const message = {
      chainId: result.record.chainId, txHash: result.record.txHash, blockNumber: result.record.blockNumber,
      transfersHash: transfersHash(result.record.transfers),
      issuedAt: Math.floor(Date.parse(result.record.observedAt) / 1000), licensee: licensee ?? zeroAddress,
    };
    const signature = await signJpycPaymentAttestation(message);
    return envelope({
      schemaVersion: '1.0', ...result.record, licensee,
      attestation: { message, signature },
      signer: receiptSignerAddress(),
      verify: { method: 'EIP-712 recoverTypedDataAddress', domain: JPYC_PAYMENT_ATTESTATION_EIP712_DOMAIN, types: JPYC_PAYMENT_ATTESTATION_TYPES },
    });
  });
}
