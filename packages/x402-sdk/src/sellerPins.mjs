function address(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase() : null;
}

export class SellerPinError extends Error {
  constructor(reason) {
    super(`OpenPay seller gate: ${reason}`);
    this.name = 'SellerPinError';
  }
}

export function assertSellerPins(resourceId, expectedRecipient, name = 'expectedRecipient') {
  if (typeof resourceId !== 'string' || resourceId.trim().length === 0) {
    throw new Error('resourceId is required from your own OpenPay listing');
  }
  if (!address(expectedRecipient)) {
    throw new Error(`${name} is required and must be a seller wallet address from your own config`);
  }
}

export function rejectSellerRequirements(reason) {
  // A registry mismatch must stop payment advertising/settlement, not become a rail fallback.
  console.error(`[openpay-x402] ${reason}`);
  throw new SellerPinError(reason);
}

export function validateJpycListing(item, resourceId, resourceUrl, expectedRecipient) {
  if (item?.id !== resourceId || item.resource !== resourceUrl) {
    rejectSellerRequirements('resource identity mismatch');
  }
  if (!Array.isArray(item.accepts)) {
    rejectSellerRequirements('resource has no payment requirements');
  }
  // Empty requirements signal JPYC configuration/availability, not a substituted recipient.
  if (item.accepts.length === 0) throw new Error('resource has no payment requirements');
  for (const accept of item.accepts) {
    const split = accept?.extra?.openpay;
    if (address(split?.merchant) !== address(expectedRecipient)) {
      rejectSellerRequirements('JPYC recipient mismatch');
    }
    if (split.mode !== 'forwarder-split' || !address(split.forwarder) ||
        address(accept.payTo) !== address(split.forwarder)) {
      rejectSellerRequirements('JPYC forwarder mismatch');
    }
  }
}

export function validateUsdcFace(face, resourceId, expectedRecipient, decode) {
  if (face?.resourceId !== resourceId) rejectSellerRequirements('USDC resource identity mismatch');
  let required;
  try {
    required = decode(face.paymentRequiredHeader);
  } catch {
    rejectSellerRequirements('invalid USDC payment requirements header');
  }
  if (!Array.isArray(required?.accepts) || required.accepts.length === 0) {
    rejectSellerRequirements('USDC header has no payment requirements');
  }
  const accepts = [face.v1Accepts, face.v2Accept, ...required.accepts];
  for (const accept of accepts) {
    if (address(accept?.payTo) !== address(expectedRecipient)) {
      rejectSellerRequirements('USDC recipient mismatch');
    }
  }
  const v1 = face.v1Accepts;
  const network = { base: 'eip155:8453', 'base-sepolia': 'eip155:84532' }[v1.network];
  for (const accept of accepts.slice(1)) {
    if (!network || accept.network !== network || accept.scheme !== v1.scheme ||
        !address(v1.asset) || address(accept.asset) !== address(v1.asset) ||
        accept.amount !== v1.maxAmountRequired) {
      rejectSellerRequirements('USDC requirements mismatch');
    }
  }
}
