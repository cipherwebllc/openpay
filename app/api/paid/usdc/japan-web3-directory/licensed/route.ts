import { getAddress, isAddress, zeroAddress } from 'viem';
import { DIRECTORY_LICENSE, DIRECTORY_LICENSE_PERMISSIONS } from '@/lib/directory/licenseTerms';
import {
  directoryContentHash, signDirectoryLicense,
  DIRECTORY_LICENSE_EIP712_DOMAIN, DIRECTORY_LICENSE_TYPES,
} from '@/lib/directory/licenseAttestation';
import { receiptSignerAddress } from '@/lib/x402/receipt';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  createDirectoryEnvelope,
  queryDirectory,
} from '@/lib/directory/query';
import type { DirectoryQuery } from '@/lib/directory/types';
import {
  USDC_DIRECTORY_LICENSED,
  USDC_DIRECTORY_LICENSED_BAZAAR,
} from '@/lib/directory/usdcResource';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_QUERY: DirectoryQuery = {
  // 全件 export を検索用の 50 件上限で切らない。非公開行は queryDirectory が除外する。
  limit: DIRECTORY_ENTRIES.length,
  offset: 0,
};

async function directoryLicensedContent({ payer }: { payer?: string }): Promise<NextResponse> {
  const verificationSnapshot = await readDirectoryVerificationSnapshot();
  if (verificationSnapshot === null) {
    // 4xx/5xx は gate が settle しない = 買い手は課金されない。
    return NextResponse.json(
      { ok: false, error: 'storage_unavailable' },
      { status: 503 },
    );
  }
  const result = queryDirectory(DIRECTORY_ENTRIES, LIST_QUERY);
  const envelope = createDirectoryEnvelope(
    LIST_QUERY,
    result,
    new Date().toISOString(),
    verificationSnapshot,
  );
  // licensee は checksum 表記で返す (署名 message と応答で表記を揃える)。payer 不明は null (署名は zero address)。
  const licensee = payer && isAddress(payer) ? getAddress(payer) : null;
  const issuedAt = new Date().toISOString();
  const message = {
    licensee: licensee ?? zeroAddress,
    licenseId: DIRECTORY_LICENSE.id,
    contentHash: directoryContentHash(envelope.items),
    rows: envelope.items.length,
    issuedAt: Math.floor(Date.parse(issuedAt) / 1000),
  };
  const signature = await signDirectoryLicense(message);
  return NextResponse.json({
    ...envelope,
    license: {
      id: DIRECTORY_LICENSE.id,
      name: DIRECTORY_LICENSE.name,
      url: DIRECTORY_LICENSE.urlFor('en'),
      licensee,
      issuedAt,
      ...DIRECTORY_LICENSE_PERMISSIONS,
    },
    attestation: signature ? { message, signature } : null,
    signer: receiptSignerAddress(),
    verify: {
      method: 'EIP-712 recoverTypedDataAddress',
      domain: DIRECTORY_LICENSE_EIP712_DOMAIN,
      types: DIRECTORY_LICENSE_TYPES,
    },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.enableWeb3Directory) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }
  return handleVanillaPaidGet(
    request,
    {
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}${USDC_DIRECTORY_LICENSED.path}`,
      description: USDC_DIRECTORY_LICENSED.description,
      serviceName: USDC_DIRECTORY_LICENSED.serviceName,
      tags: USDC_DIRECTORY_LICENSED.tags,
      price: USDC_DIRECTORY_LICENSED.price,
      outputSchema: {
        input: { type: 'http', method: 'GET', discoverable: true },
      },
      bazaar: USDC_DIRECTORY_LICENSED_BAZAAR,
    },
    directoryLicensedContent,
  );
}
