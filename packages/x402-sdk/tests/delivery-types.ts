import {
  DeliveryError, createDeliveryGate, verifyDeliveryTicket, ticketFromRequest, deliveryKeyThumbprint,
  type DeliveryErrorCode, type DeliveryOptions, type DeliveryPublicJwk, type DeliveryVerification, type DeliveryReplayStore,
} from 'openpay-x402-sdk/delivery';
// @ts-expect-error Delivery types deliberately do not escape through the Node root.
import type { DeliveryGate as RootDeliveryGate } from 'openpay-x402-sdk';

// Compiled by the repository typecheck; never executed.
export async function deliveryTypeContracts(request: Request, key: DeliveryPublicJwk) {
  const replayStore: DeliveryReplayStore = { async consume(jti, expSeconds) {
    const id: string = jti; const expires: number = expSeconds;
    return id.length > 0 && expires > 0;
  } };
  const options: DeliveryOptions = { product: 'h_' + 'a'.repeat(32), audience: 'https://files.example',
    issuer: 'https://open-pay.jp', origin: 'https://keys.example', fetch: globalThis.fetch,
    now: Date.now, keys: [key], maxSkewSeconds: 30, replayStore };
  const gate = createDeliveryGate(options);
  const ready: void = await gate.ready();
  const extracted: string | null = ticketFromRequest(request);
  const verified: DeliveryVerification = await gate.verifyRequest(request);
  const direct: DeliveryVerification = await verifyDeliveryTicket({ ...options, ticket: extracted ?? '' });
  const fromString: DeliveryVerification = await gate.verify(extracted ?? '');
  const thumbprint: string = await deliveryKeyThumbprint(key.x);
  const code: DeliveryErrorCode = new DeliveryError('unsupported_crypto').code;
  // @ts-expect-error Audience is mandatory seller configuration.
  createDeliveryGate({ product: options.product });
  // @ts-expect-error No synchronous or non-boolean consume store contract.
  const invalid: DeliveryReplayStore = { consume() { return true; } };
  // @ts-expect-error Only documented errors are supported.
  new DeliveryError('network_error');
  const rootType: RootDeliveryGate | undefined = undefined;
  return { ready, verified, direct, fromString, thumbprint, code, invalid, rootType };
}
