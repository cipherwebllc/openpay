import { execFile } from 'node:child_process';
import { getAddress, verifyTypedData } from 'viem';

const CHAINS = new Map([
  ['eip155:137', 'polygon'],
  ['eip155:80002', 'polygon-amoy'],
]);

// Only these fixed messages may cross the SDK, which recreates Error(message).
class KovaSigningError extends Error {}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when SIGNER_MODE=kova`);
  return value;
}

function childEnvironment(env) {
  // Kova に不要な OpenPay の秘密が第三者 CLI へ流れる波及を断つ。
  // Filter own keys before reading values, so excluded getters are never evaluated.
  return Object.fromEntries(Object.keys(env)
    .filter((key) => key !== 'BUYER_PRIVATE_KEY' && !key.startsWith('STEWARD_'))
    .map((key) => [key, env[key]]));
}

function runKova(execFileImpl, bin, args, env) {
  return new Promise((resolve, reject) => {
    let child;
    function stop(error) {
      clearTimeout(deadline);
      reject(error);
      try {
        child?.kill('SIGKILL');
      } catch {
        // An OS kill failure must not prevent the already-rejected payment from releasing its queue.
      }
    }
    // SDK の pay は直列化されるため、止まった子プロセスが以後の x402_pay 全部を
    // 詰まらせる波及を断つ防御。Node の終了 callback に依存しない期限で打ち切る。
    const deadline = setTimeout(() => stop(new KovaSigningError('kova_sign_failed')), 30_000);
    try {
      child = execFileImpl(bin, args, {
        shell: false,
        timeout: 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024, // Bounds stdout AND stderr.
        encoding: 'utf8',
        env,
      }, (error, stdout) => {
        clearTimeout(deadline);
        resolve({ error, stdout });
      });
      // This noninteractive signer never supplies prompt input; EOF ends stdin waits.
      child.stdin.on('error', stop);
      child.stdin.end();
    } catch (error) {
      stop(error);
    }
  });
}

export function createKovaSigner(env = process.env, { execFileImpl = execFile } = {}) {
  const wallet = required(env, 'KOVA_WALLET');
  const rawAddress = required(env, 'KOVA_AGENT_ADDRESS');
  let address;
  try {
    address = getAddress(rawAddress);
  } catch {
    // Invalid configuration must not echo an accidentally pasted secret through startup errors.
    throw new Error('KOVA_AGENT_ADDRESS must be an EVM address when SIGNER_MODE=kova');
  }
  const bin = env.KOVA_BIN?.trim() || 'kova';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bin)) {
    throw new Error('KOVA_BIN must be a PATH executable name');
  }
  return {
    mode: 'custom',
    address,
    async signTypedData({ domain, types, primaryType, message }) {
      try {
        // The installed SDK derives domain.chainId from the validated 402 network and
        // passes only typed-data to this hook. Never take a chain override from env.
        const chain = CHAINS.get(`eip155:${domain.chainId}`);
        if (!chain) throw new KovaSigningError('kova_sign_failed');
        const typedData = { domain, types, primaryType, message };
        const json = JSON.stringify(typedData, (_key, value) =>
          typeof value === 'bigint' ? value.toString(10) : value,
        );
        const { error, stdout } = await runKova(execFileImpl, bin,
          ['sign', 'typed-data', '--name', wallet, '--chain', chain, '--data', json], childEnvironment(env));
        if (error?.code === 'ENOENT') throw new KovaSigningError('kova_not_found');
        // Timeout, signals, spawn failures and output overflow take priority over partial JSON.
        // Only an ordinary nonzero exit can still carry a complete policy-denial envelope.
        if (error && (error.killed || error.signal || !Number.isInteger(error.code))) {
          throw new KovaSigningError('kova_sign_failed');
        }
        const body = JSON.parse(stdout);
        if (body?.ok === false && body?.error?.code === 'POLICY_DENIED') {
          throw new KovaSigningError('kova_policy_denied');
        }
        // Unknown envelopes/recoveryId encodings are not repaired. Actual CLI exit/JSON
        // and sign_allowlist maxValue semantics still require the Amoy acceptance run.
        const signature = body?.data?.signature;
        // A strict end assertion also rejects a trailing newline (JavaScript's $ allows one).
        if (error || body?.ok !== true || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}(?![\s\S])/.test(signature)) {
          throw new KovaSigningError('kova_sign_failed');
        }
        if (!await verifyTypedData({ ...typedData, address, signature })) {
          throw new KovaSigningError('kova_sign_failed');
        }
        return signature;
      } catch (error) {
        // Child output, native errors (including command/args), and viem errors can carry
        // secrets. Contain them here rather than relying on the SDK's known-secret redaction.
        throw error instanceof KovaSigningError ? error : new KovaSigningError('kova_sign_failed');
      }
    },
  };
}
