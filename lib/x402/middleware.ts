// 任意の Next.js App Router route handler に x402 課金 gate を付ける wrapper。
// 内部で x402-next の withX402 を呼ぶ。これは「verify → handler 実行 → settle」
// の順序を保証し、settle が失敗したら content を返さない (= 課金成立後のみ
// content delivery)。
//
// 設計上の重要点:
//   - X402_TEST_MODE=true (production 以外) では payment 検証を bypass。dev / e2e で
//     便利。config.ts の起動 guard で prod 流出を防いでいる。
//   - withX402 内で facilitator 通信 / handler / settle のいずれかが throw した
//     場合、Next.js は 500 を返してしまうため、ここで catch して安全側 402 に倒す
//     (user 仕様: 「例外時は 500 ではなく可能な限り安全側に倒して 402/403 を返す」)。
//   - エラーは Sentry に logger.warn で集計 (audit dropout を完全 silent にしない)。

import { withX402 } from 'x402-next';
import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { x402Config } from './config';
import type { PaidRouteOverrides } from './types';

type PaidHandler<T = unknown> = (
  request: NextRequest,
) => Promise<NextResponse<T>>;

export function withX402Payment<T = unknown>(
  handler: PaidHandler<T>,
  overrides?: PaidRouteOverrides,
): PaidHandler<T | unknown> {
  if (x402Config.testMode) {
    // payment 層を完全に bypass。X402_TEST_MODE=true は dev / e2e のみで動く。
    return handler;
  }

  const wrapped = withX402(
    handler,
    x402Config.payTo,
    {
      price: overrides?.price ?? x402Config.defaultPrice,
      network: overrides?.network ?? x402Config.network,
      config: {
        description: overrides?.description ?? 'OpenPay paid API',
        mimeType: overrides?.mimeType ?? 'application/json',
        maxTimeoutSeconds: overrides?.maxTimeoutSeconds,
      },
    },
    // x402-next の FacilitatorConfig.url は templated `${string}://${string}` 型。
    // 起動時 guard で https 強制 (production)、形式は信頼して cast。
    {
      url: x402Config.facilitatorUrl as `${string}://${string}`,
    },
  );

  return async function safeWrappedHandler(
    request: NextRequest,
  ): Promise<NextResponse<T | unknown>> {
    try {
      return await wrapped(request);
    } catch (err) {
      // facilitator unreachable / 内部例外でも 500 を返さず、x402 spec に
      // 沿って 402 を返す。content は絶対に渡さない。
      logger.warn('x402.middleware.error', {
        error: err instanceof Error ? err.message : String(err),
        route: request.nextUrl.pathname,
      });
      return NextResponse.json(
        {
          x402Version: 1,
          error: 'payment_facility_unavailable',
          message: 'Payment verification failed. Please retry later.',
        },
        { status: 402 },
      );
    }
  };
}
