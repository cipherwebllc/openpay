import { getAddress } from 'viem';
import { createCliSigner } from './cliSigner.mjs';

const LOGIN_CODES = [
  'AUTH_FAILED', 'AUTH_ERROR', 'TOKEN_INVALID', 'TOKEN_REFRESH_FAILED',
  'NO_AUTH_TOKEN', 'NO_PROJECT_ID', 'SESSION_EXPIRED', 'SESSION_NOT_FOUND',
  'REFRESH_CLI_TOKEN_FAILED',
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
        const start = stderr.startsWith('{') ? 0 : stderr.indexOf('\n{');
        if (start < 0) return undefined;
        body = JSON.parse(stderr.slice(start));
      } catch {
        return undefined;
      }
      if (body?.ok !== false) return undefined;
      const code = body?.error?.code;
      return { errorCode: LOGIN_CODES.includes(code) ? 'LOGIN' : code === 'JOB_TIMEOUT' ? 'PENDING' : 'FAILED' };
    },
    parseResponse(stdout) {
      const body = JSON.parse(stdout);
      if (body?.ok !== true || body?.data?.mode !== 'server') return { errorCode: 'FAILED' };
      const { status, signature, pollingId } = body.data;
      if (status === 'SIGNED') return { signature };
      if (status === 'REJECTED' || status === 'BLOCKED') return { errorCode: 'DENIED' };
      if (['EXPIRED', 'CANCELLED', 'FAILED', 'SIGNING_FAILED'].includes(status)) return { errorCode: 'FAILED' };
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
      const enqueuedAt = Date.now();
      const result = queue.then(() => {
        const deadlineMs = 30_000 - (Date.now() - enqueuedAt);
        if (deadlineMs <= 0) throw new Error('metamask_sign_failed');
        return signer.signTypedData(typedData, { deadlineMs });
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
