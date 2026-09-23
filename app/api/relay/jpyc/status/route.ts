// 署名済み JPYC EIP-3009 intent の read-only 解決 endpoint。
// relay POST の処理・冪等 claim・broadcast は一切呼ばず、KV と on-chain state/log の読み取りだけで
// response-unknown を settled / unused / indeterminate に分類する。

import { NextResponse } from 'next/server';
import {
  createPublicClient,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { chainObjectForId, transportForChain } from '@/lib/chains';
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
import { hasMatchingForwarderSettlement } from '@/lib/relay/settlementReceipt';
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
  forwarder?: Address;
  settlement?: ForwarderSettleParams;
  transfer?: Pick<Eip3009Authorization, 'to' | 'value'>;
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
    if (!used) {
      // broadcast 済み hash がある場合、unused を新しい支払いの許可に使うと二重払いへ
      // 波及しうる。未確定/置換を区別できない間は既存 indeterminate に閉じる。
      return json({ ok: true, state: idem.state === 'hash' ? 'indeterminate' : 'unused' });
    }

    if (idem.state === 'hash' && await receiptMatchesIntent(parsed, token, idem.txHash)) {
      return json({ ok: true, state: 'settled', txHash: idem.txHash });
    }

    // KV hash は別 authorization の置換 tx の可能性がある。対象 nonce の実行 tx を再解決し、
    // こちらも receipt を照合してから返す。used/cancelled フラグだけでは決済成功としない。
    const txHash = await findAuthorizationUsedTransactionHash(
      parsed.chainId,
      token,
      parsed.from,
      parsed.nonce,
    );
    if (!txHash || !(await receiptMatchesIntent(parsed, token, txHash))) {
      return json({ ok: true, state: 'indeterminate' });
    }
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

const AUTHORIZATION_TRANSFER_EVENTS = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

async function receiptMatchesIntent(parsed: ParsedIntent, token: Address, txHash: Hex): Promise<boolean> {
  try {
    const chain = chainObjectForId(parsed.chainId);
    if (!chain) return false;
    const client = createPublicClient({ chain, transport: transportForChain(parsed.chainId) });
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') return false;

    if (parsed.forwarder) {
      return hasMatchingForwarderSettlement(
        receipt.logs,
        parsed.forwarder,
        parsed.from,
        parsed.nonce,
        parsed.settlement,
      );
    }

    const logs = receipt.logs.filter((log) => isAddressEqual(log.address, token));
    const used = parseEventLogs({
      abi: AUTHORIZATION_TRANSFER_EVENTS,
      eventName: 'AuthorizationUsed',
      logs,
      strict: true,
    }).some(({ args }) =>
      isAddressEqual(args.authorizer, parsed.from) &&
      args.nonce.toLowerCase() === parsed.nonce.toLowerCase(),
    );
    if (!used) return false;

    // free 経路の nonce は分割 commitment ではないため、同じ JPYC receipt 内の Transfer も
    // 必須。署名付き照会は宛先/額まで照合し、nonce-only は authorizer 自身の送金を確認する。
    return parseEventLogs({
      abi: AUTHORIZATION_TRANSFER_EVENTS,
      eventName: 'Transfer',
      logs,
      strict: true,
    }).some(({ args }) =>
      isAddressEqual(args.from, parsed.from) &&
      (!parsed.transfer || (
        isAddressEqual(args.to, parsed.transfer.to) && args.value === parsed.transfer.value
      )),
    );
  } catch (error) {
    // 旧 KV hash の receipt 不在/RPC 障害が、正しい AuthorizationUsed tx の回復まで
    // 巻き込むのを断つ。証拠を読めない hash は成功扱いせず、呼出元で再解決/indeterminate。
    logger.warn('relay.jpyc.status.receipt_unreadable', {
      chainId: parsed.chainId,
      txHash,
      error,
    });
    return false;
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
      forwarder: jpycForwarderFor(raw.chainId) ?? undefined,
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
      forwarder,
      settlement: params,
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
    transfer: auth,
    verifySignature: () =>
      recoverTransferAuthorizationSigner(auth, chainId, token, signature),
  };
}
