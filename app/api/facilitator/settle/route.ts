// x402 facilitator: POST /api/facilitator/settle
// body { x402Version, paymentPayload, paymentRequirements } を検証 → 既存 forwarder で **アトミック
// 分割 settle** を broadcast → 確定待ち → { success, transaction, network, payer, errorReason? } を返す
// (x402 v2 の SettleResponse 形)。OpenPay は JPYC に触れない (relayer はガスのみ・非カストディ)。
// settle 本体は recover relay /settle と同一の共有コア (settleViaForwarder) を使う。
// flag OFF は 404・self-host relayer 未構成 / facilitator 未準備は 503。
//
// 受領証明 (receipt) の署名・添付は X4 (lib/x402/receipt) で success 分岐に配線する。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  PROVIDER,
  MAINNET_CHAINS,
  relayMaxGasCostWei,
  jpycAddressFor,
} from '@/lib/relay/relayProvider';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { settleViaForwarder } from '@/lib/relay/forwarderSettleService';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { MAX_BODY_BYTES } from '@/lib/relay/relayRoute';
import { x402FacilitatorReady } from '@/lib/x402/facilitatorConfig';
import { parseFacilitatorRequest } from '@/lib/x402/facilitatorSettle';
import { caip2ForChainId } from '@/lib/x402/network';
import {
  makeSettlementReceipt,
  signReceipt,
  type SignedX402Receipt,
} from '@/lib/x402/receipt';
import { recordSettlement } from '@/lib/x402/registry';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  // settle は forwarder.settle を自前 EOA で broadcast するため self-host relayer 必須。
  if (PROVIDER !== 'self-host') {
    return NextResponse.json(
      { success: false, errorReason: 'relay_not_configured' },
      { status: 503 },
    );
  }
  if (
    !(await checkIpRateLimit(
      'relay-admission',
      hashIp(clientIp(req)),
      120,
      60,
    ))
  ) {
    // IP 単位の濫用を署名検証/RPC 前で止め、relayer 資源と daily budget への波及を断つ。
    return NextResponse.json(
      { error: 'ip_rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json(
      { success: false, errorReason: 'invalid_json' },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, errorReason: 'payload_too_large' },
      { status: 413 },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { success: false, errorReason: 'invalid_json' },
      { status: 400 },
    );
  }

  const parsed = parseFacilitatorRequest(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, errorReason: parsed.reason },
      { status: 400 },
    );
  }
  const { chainId, params, signature, expectedFeeValue } = parsed.parsed;
  const network = caip2ForChainId(chainId);
  const payer = params.from;

  // mainnet self-host hardening (recover route と同一): gas-cost ceiling 必須 + KV 必須
  // (idempotency が fail-open になると二重 submit しうる)。testnet (Amoy) は緩く運用可。
  if (MAINNET_CHAINS.has(chainId)) {
    if (relayMaxGasCostWei(chainId) === 0n) {
      logger.error('x402.facilitator.gas_ceiling_required', { chainId });
      return NextResponse.json(
        { success: false, errorReason: 'gas_ceiling_required' },
        { status: 503 },
      );
    }
    if (!isKvConfigured()) {
      logger.error('x402.facilitator.kv_required', { chainId });
      return NextResponse.json(
        { success: false, errorReason: 'kv_required' },
        { status: 503 },
      );
    }
  }

  const ready = x402FacilitatorReady(chainId);
  if (!ready.ready) {
    return NextResponse.json(
      { success: false, errorReason: ready.reason },
      { status: 503 },
    );
  }

  // 検証 (server 権威 feeValue 照合 / 署名 / 残高 / nonce 未使用 / 冪等 / 日次予算) + forwarder 健全性 +
  // submit/poll は共有 settleViaForwarder。forwarderFor は raw (a1 非依存)・idempotency は専用名前空間。
  const result = await settleViaForwarder({
    chainId,
    params,
    signature,
    rateLimitKeys: [params.from],
    expectedFeeValue,
    forwarderFor: configuredJpycForwarderFor,
    idemPrefix: 'x402fac:idem:',
  });

  switch (result.kind) {
    case 'success': {
      // 受領証明: settle 成功を OpenPay 鍵で EIP-712 署名 (鍵未設定なら receipt=null・settle は成立)。
      const jpyc = jpycAddressFor(chainId);
      const forwarder = configuredJpycForwarderFor(chainId);
      let receipt: SignedX402Receipt | null = null;
      if (jpyc && forwarder) {
        const r = makeSettlementReceipt(result.txHash, chainId, forwarder, jpyc, params);
        const sig = await signReceipt(r);
        if (sig) receipt = { ...r, signature: sig };
      }
      // settlement を会計用に記録 (fail-quiet: money-path を壊さない)。
      try {
        await recordSettlement({
          id: crypto.randomUUID(),
          payer,
          payTo: params.merchant,
          amount: params.merchantValue.toString(),
          fee: params.feeValue.toString(),
          txHash: result.txHash,
          network,
          receiptSig: receipt?.signature,
          createdAt: Date.now(),
        });
      } catch (e) {
        logger.warn('x402.facilitator.settlement_record_failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return NextResponse.json({
        success: true,
        transaction: result.txHash,
        network,
        payer,
        receipt,
      });
    }
    case 'reverted':
      logger.warn('x402.facilitator.reverted', { txHash: result.txHash, chainId });
      return NextResponse.json({
        success: false,
        errorReason: 'reverted',
        transaction: result.txHash,
        network,
        payer,
      });
    case 'pending':
      // broadcast 済だが未確定。client は再送してはならない (二重支払い防止) → 202。
      logger.warn('x402.facilitator.pending', { txHash: result.txHash, chainId });
      return NextResponse.json(
        {
          success: false,
          errorReason: 'pending',
          transaction: result.txHash ?? null,
          network,
          payer,
        },
        { status: 202 },
      );
    case 'rejected':
      return NextResponse.json(
        { success: false, errorReason: result.reason, network, payer },
        { status: result.httpStatus },
      );
    case 'relay_error':
      logger.warn('x402.facilitator.relay_error', { detail: result.detail, chainId });
      return NextResponse.json(
        { success: false, errorReason: 'relay_error', network, payer },
        { status: 502 },
      );
  }
}
