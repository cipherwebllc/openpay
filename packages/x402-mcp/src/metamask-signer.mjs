import { getAddress } from 'viem';
import { createCliSigner } from './cliSigner.mjs';

const LOGIN_CODES = [
  'AUTH_FAILED', 'SESSION_EXPIRED', 'SESSION_NOT_FOUND',
  'TOKEN_INVALID', 'TOKEN_NOT_FOUND', 'REFRESH_CLI_TOKEN_FAILED',
];

export function createMetamaskSigner(env = process.env, { execFileImpl } = {}) {
  if (['MM_CLI_TOKEN', 'MM_MNEMONIC', 'MM_PASSWORD'].some((key) => key in env)) {
    throw new Error('MM_CLI_TOKEN, MM_MNEMONIC and MM_PASSWORD must not be set for SIGNER_MODE=metamask');
  }
  const rawAddress = env.METAMASK_AGENT_ADDRESS?.trim();
  if (!rawAddress) throw new Error('METAMASK_AGENT_ADDRESS is required when SIGNER_MODE=metamask');
  let address;
  try {
    address = getAddress(rawAddress);
  } catch {
    // Invalid configuration must not echo an accidentally pasted secret at startup.
    throw new Error('METAMASK_AGENT_ADDRESS must be an EVM address when SIGNER_MODE=metamask');
  }
  const bin = env.MM_BIN?.trim() || 'mm';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bin)) {
    throw new Error('MM_BIN must be a PATH executable name');
  }
  const signer = createCliSigner({
    address, env, execFileImpl, bin,
    deadlineMs: 30_000,
    excludedEnvPrefixes: ['STEWARD_', 'KOVA_'],
    excludedEnvKeys: ['POLYGON_RPC_URL'],
    args({ domain, primaryType }, json) {
      const chain = String(domain.chainId);
      if (chain !== '137' && chain !== '80002') throw new Error('metamask_sign_failed');
      const intent = primaryType === 'ReceiveWithAuthorization' ? 'OpenPay x402 payment'
        : primaryType === 'Proof' ? 'OpenPay wallet proof (no payment)' : 'OpenPay signature';
      return ['wallet', 'sign-typed-data', '--chain-id', chain, '--payload', json,
        '--intent', intent, '--wait', '--wallet-timeout', '20', '--json'];
    },
    parseStderr(stderr) {
      // mm 7.0.0 は成功時にも stderr へ `Intent: …` を 1 行出す (2026-09-26 実測)。
      // 失敗封筒 (ok:false の JSON) だけを解釈し、それ以外の stderr は stdout の判定に委ねる。
      let body;
      try {
        body = JSON.parse(stderr);
      } catch {
        return undefined;
      }
      if (body?.ok !== false) return undefined;
      return { errorCode: LOGIN_CODES.includes(body?.error?.code) ? 'LOGIN' : 'FAILED' };
    },
    parseResponse(stdout) {
      const body = JSON.parse(stdout);
      if (body?.ok !== true || body?.data?.mode !== 'server') return { errorCode: 'FAILED' };
      const { status, signature, pollingId } = body.data;
      if (status === 'SIGNED') return { signature };
      if (status === 'REJECTED' || status === 'BLOCKED') return { errorCode: 'DENIED' };
      if (['EVALUATING', 'AWAITING_MFA', 'SIGNING'].includes(status) || pollingId != null) {
        return { errorCode: 'PENDING' };
      }
      return { errorCode: 'FAILED' };
    },
    errors: {
      failed: 'metamask_sign_failed',
      notFound: 'metamask_not_found',
      deadline: 'metamask_approval_pending',
      response: {
        LOGIN: 'metamask_login_required',
        PENDING: 'metamask_approval_pending', DENIED: 'metamask_denied',
      },
    },
  });
  // Serialize proof and payment signing so mm session/token refreshes cannot race.
  // Recover the queue after rejection without changing the caller's failed result.
  let queue = Promise.resolve();
  return {
    ...signer,
    signTypedData(typedData) {
      const result = queue.then(() => signer.signTypedData(typedData));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
