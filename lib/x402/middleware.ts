// x402-next の withX402 を OpenPay の config + safety で wrap する。
//
//   - X402_TEST_MODE=true は payment 検証を bypass (config.ts の起動 guard で
//     production への流出を阻止済)。
//   - withX402 内部の throw (facilitator 不通など) は Next の default 500 でなく
//     402 + logger.warn (Sentry) に倒す。content は絶対に渡さない。

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
