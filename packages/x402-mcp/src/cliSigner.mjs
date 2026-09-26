import { execFile } from 'node:child_process';
import { verifyTypedData } from 'viem';

// Only configured fixed messages may cross the SDK, which recreates Error(message).
class CliSigningError extends Error {}

function childEnvironment(env, excludedEnvPrefixes, excludedEnvKeys) {
  // 不要な OpenPay / 他 provider の秘密が第三者 CLI へ流れる波及を断つ。
  // Filter own keys before reading values, so excluded getters are never evaluated.
  return Object.fromEntries(Object.keys(env)
    .filter((key) => key !== 'BUYER_PRIVATE_KEY' && !excludedEnvKeys.includes(key) && !excludedEnvPrefixes.some((prefix) => key.startsWith(prefix)))
    .map((key) => [key, env[key]]));
}

function runCli(execFileImpl, bin, args, env, deadlineMs, failed) {
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
    const deadline = setTimeout(() => stop(new CliSigningError(failed)), deadlineMs);
    try {
      child = execFileImpl(bin, args, {
        shell: false,
        timeout: deadlineMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024, // Bounds stdout AND stderr.
        encoding: 'utf8',
        env,
      }, (error, stdout, stderr) => {
        clearTimeout(deadline);
        resolve({ error, stdout, stderr });
      });
      // This noninteractive signer never supplies prompt input; EOF ends stdin waits.
      child.stdin.on('error', stop);
      child.stdin.end();
    } catch (error) {
      stop(error);
    }
  });
}

export function createCliSigner({
  address, env, execFileImpl = execFile, bin, args, deadlineMs,
  excludedEnvPrefixes, excludedEnvKeys = [], parseResponse, parseStderr, errors,
}) {
  const failure = () => new CliSigningError(errors.failed);
  return {
    mode: 'custom',
    address,
    async signTypedData({ domain, types, primaryType, message }, { deadlineMs: callDeadlineMs = deadlineMs } = {}) {
      try {
        const typedData = { domain, types, primaryType, message };
        const json = JSON.stringify(typedData, (_key, value) =>
          typeof value === 'bigint' ? value.toString(10) : value,
        );
        const { error, stdout, stderr } = await runCli(execFileImpl, bin, args(typedData, json),
          childEnvironment(env, excludedEnvPrefixes, excludedEnvKeys), callDeadlineMs, errors.deadline ?? errors.failed);
        if (error?.code === 'ENOENT') throw new CliSigningError(errors.notFound);
        // Timeout, signals, spawn failures and output overflow take priority over partial JSON.
        // Only an ordinary nonzero exit can still carry a complete error envelope.
        if (error && (error.killed || error.signal || !Number.isInteger(error.code))) {
          throw failure();
        }
        // Only adapters that explicitly opt in may interpret stderr envelopes.
        const stderrResponse = parseStderr && stderr ? parseStderr(stderr) : undefined;
        const { signature, errorCode } = stderrResponse ?? parseResponse(stdout);
        if (errorCode !== undefined) {
          throw new CliSigningError(Object.hasOwn(errors.response, errorCode) ? errors.response[errorCode] : errors.failed);
        }
        // A strict end assertion also rejects a trailing newline (JavaScript's $ allows one).
        if (error || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}(?![\s\S])/.test(signature)) {
          throw failure();
        }
        if (!await verifyTypedData({ ...typedData, address, signature })) throw failure();
        return signature;
      } catch (error) {
        // Child output, native errors (including command/args), and viem errors can carry
        // secrets. Contain them here rather than relying on the SDK's known-secret redaction.
        throw error instanceof CliSigningError ? error : failure();
      }
    },
  };
}
