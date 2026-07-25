// 署名済み JPYC EIP-3009 intent の read-only 解決 endpoint。
// relay POST の処理・冪等 claim・broadcast は一切呼ばず、KV と on-chain state/log の読み取りだけで
// response-unknown を settled / unused / indeterminate に分類する。

import { NextResponse } from 'next/server';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import {
  jpycAddressFor,
  PROVIDER,
  readAuthorizationUsed,
  findAuthorizationUsedTransactionHash,
  SUPPORTED_CHAINS,
} from '@/lib/relay/relayProvider';
import { checkIpRateLimit, readIdempotency } from '@/lib/relay/relayGuards';
import { MAX_BODY_BYTES, anonymizeIp, isDec } from '@/lib/relay/relayRoute';
import { jpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { feeReceiverFor } from '@/lib/relay/forwarderSettleService';
import {
  buildForwarderNonce,
  type ForwarderSettleParams,
} from '@/lib/relay/forwarderIntent';
import { recoverReceiveWithAuthorizationSigner } from '@/lib/relay/forwarderSettle';
import {
  recoverTransferAuthorizationSigner,
  type Eip3009Authorization,
} from '@/lib/jpycEip3009';

export const runtime = 'nodejs';
export const maxDuration = 15;

type ParsedIntent = {
  chainId: number;
  from: Address;
  nonce: Hex;
  verifySignature: () => Promise<Address>;
};

type StatusBody =
  | { ok: true; state: 'settled'; txHash: Hex | null }
  | { ok: true; state: 'unused' }
  | { ok: true; state: 'indeterminate' };

const json = (body: StatusBody) => NextResponse.json(body, { status: 200 });

export async function POST(req: Request): Promise<NextResponse> {
  // Client が relay を選び得る既存 flag と実 provider の双方に相乗りする。OFF/未構成時は endpoint
  // 自体を公開せず、別の relay 環境であることを 404 で表す。
  if (!env.enableJpycEip3009 || PROVIDER === null) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  const ip = clientIp(req);
  if (!(await checkIpRateLimit('relay-status', hashIp(ip), 30, 60))) {
    logger.warn('relay.jpyc.status.rate_limited', {
      ipPrefix: anonymizeIp(ip ?? ''),
    });
    return NextResponse.json(
      { ok: false, error: 'ip_rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const raw = await readBody(req);
  if (!raw) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }
  const parsed = parseIntent(raw);
  if (!parsed) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  let signer: Address;
  try {
    signer = await parsed.verifySignature();
  } catch {
    return NextResponse.json({ ok: false, error: 'signature_invalid' }, { status: 400 });
  }
  if (getAddress(signer) !== parsed.from) {
    return NextResponse.json({ ok: false, error: 'signature_mismatch' }, { status: 400 });
  }

  try {
    const idem = await readIdempotency(
      'relay:idem:',
      parsed.chainId,
      parsed.from,
      parsed.nonce,
    );
    if (idem.state === 'indeterminate') return json({ ok: true, state: 'indeterminate' });
    if (idem.state === 'hash') {
      return json({ ok: true, state: 'settled', txHash: idem.txHash });
    }

    const token = jpycAddressFor(parsed.chainId);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: 'unsupported_chain' },
        { status: 400 },
      );
    }
    const used = await readAuthorizationUsed(
      parsed.chainId,
      token,
      parsed.from,
      parsed.nonce,
    );
    if (!used) return json({ ok: true, state: 'unused' });

    const txHash = await findAuthorizationUsedTransactionHash(
      parsed.chainId,
      token,
      parsed.from,
      parsed.nonce,
    );
    return json({ ok: true, state: 'settled', txHash });
  } catch (error) {
    // KV/RPC の一過性障害を HTTP error にすると client の停止条件が分岐する。解決不能だけを
    // ok:true indeterminate に閉じ込め、既存 relay 送金処理へ波及させない。
    logger.warn('relay.jpyc.status.indeterminate', {
      chainId: parsed.chainId,
      ipPrefix: anonymizeIp(ip ?? ''),
      error,
    });
    return json({ ok: true, state: 'indeterminate' });
  }
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseIntent(raw: Record<string, unknown>): ParsedIntent | null {
  if (raw.lookup === 'nonce') {
    if (
      typeof raw.chainId !== 'number' ||
      !Number.isInteger(raw.chainId) ||
      !(raw.chainId in SUPPORTED_CHAINS) ||
      !isAddress(raw.from as string) ||
      typeof raw.nonce !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(raw.nonce)
    ) {
      return null;
    }
    const from = getAddress(raw.from as string);
    return {
      chainId: raw.chainId,
      from,
      nonce: raw.nonce as Hex,
      // nonce は 32-byte random/forwarder commitment で列挙不能、route は rate-limit 済みかつ
      // read-only。リロード後に署名を再保存せず結果照会できるよう signer は from に固定する。
      verifySignature: async () => from,
    };
  }
  if (
    typeof raw.chainId !== 'number' ||
    !Number.isInteger(raw.chainId) ||
    !(raw.chainId in SUPPORTED_CHAINS) ||
    !isAddress(raw.from as string) ||
    !isDec(raw.validAfter) ||
    !isDec(raw.validBefore) ||
    typeof raw.signature !== 'string' ||
    !isHex(raw.signature)
  ) {
    return null;
  }
  const chainId = raw.chainId;
  const from = getAddress(raw.from as string);
  const validAfter = BigInt(raw.validAfter);
  const signature = raw.signature as Hex;
  const token = jpycAddressFor(chainId);
  if (!token) return null;

  const forwarder = jpycForwarderFor(chainId);
  if (forwarder) {
    if (
      !isAddress(raw.merchant as string) ||
      !isDec(raw.merchantValue) ||
      !isDec(raw.feeValue) ||
      typeof raw.intentSalt !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(raw.intentSalt)
    ) {
      return null;
    }
    const feeReceiver = feeReceiverFor(chainId);
    if (!feeReceiver) return null;
    const params: ForwarderSettleParams = {
      from,
      merchant: getAddress(raw.merchant as string),
      merchantValue: BigInt(raw.merchantValue),
      feeReceiver,
      feeValue: BigInt(raw.feeValue),
      validAfter,
      validBefore: BigInt(raw.validBefore),
      intentSalt: raw.intentSalt as Hex,
    };
    return {
      chainId,
      from,
      nonce: buildForwarderNonce(params, chainId, forwarder),
      verifySignature: () =>
        recoverReceiveWithAuthorizationSigner(
          params,
          chainId,
          token,
          forwarder,
          signature,
        ),
    };
  }

  if (
    !isAddress(raw.to as string) ||
    !isDec(raw.value) ||
    typeof raw.nonce !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.nonce)
  ) {
    return null;
  }
  const auth: Eip3009Authorization = {
    from,
    to: getAddress(raw.to as string),
    value: BigInt(raw.value),
    validAfter,
    validBefore: BigInt(raw.validBefore),
    nonce: raw.nonce as Hex,
  };
  return {
    chainId,
    from,
    nonce: auth.nonce,
    verifySignature: () =>
      recoverTransferAuthorizationSigner(auth, chainId, token, signature),
  };
}
