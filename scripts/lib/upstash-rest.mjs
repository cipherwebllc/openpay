// Read-only backup transport. Credentials and server error text never leave this module.
export class UpstashError extends Error {
  constructor(code, status) {
    super(`Upstash ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}
export class UpstashTimeoutError extends UpstashError {
  constructor() { super('timeout'); }
}
export class UpstashHttpError extends UpstashError {
  constructor(status) { super('http_error', status); }
}
export class UpstashLimitError extends UpstashError {
  constructor() { super('size_limit'); }
}
export class UpstashCommandError extends UpstashError {
  constructor(code = 'command_error') { super(code); }
}

const isLimit = (text) => /max(?:imum)? (?:request|response) size|(?:request|response).*(?:too large|size.*exceed)/i.test(text);

export function decodeResponse(value) {
  if (value === null || Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(decodeResponse);
  if (typeof value === 'string') {
    if (value === 'OK') return value;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new UpstashError('invalid_base64');
    return new Uint8Array(bytes);
  }
  throw new UpstashError('invalid_response');
}

function unwrap(entry) {
  if (typeof entry?.error === 'string') {
    if (isLimit(entry.error)) return new UpstashLimitError();
    return new UpstashCommandError(/WRONGTYPE/i.test(entry.error) ? 'wrong_type'
      : /NOPERM|NOAUTH|WRONGPASS|unauthorized|forbidden/i.test(entry.error) ? 'permission_denied' : 'command_error');
  }
  if (!entry || !Object.hasOwn(entry, 'result')) throw new UpstashError('invalid_response');
  return decodeResponse(entry.result);
}

export function createUpstashClient({
  env = process.env, url = env.KV_BACKUP_REST_URL, token = env.KV_BACKUP_REST_TOKEN,
  fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000, reqBytes = 4 * 1024 * 1024,
} = {}) {
  if (!url || !token) throw new UpstashError('missing_backup_credentials');
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new UpstashError('invalid_endpoint'); }
  // Reject credentials in URLs so an HTTP failure cannot expose a token via its URL.
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !['', '/'].includes(endpoint.pathname)) throw new UpstashError('invalid_endpoint');

  async function request(path, commands, batch) {
    const body = JSON.stringify(commands);
    if (Buffer.byteLength(body) > reqBytes) throw new UpstashLimitError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint.origin}${path}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Upstash-Encoding': 'base64' }, body,
      });
      if (response.status === 413) {
        response.body?.cancel().catch(() => {});
        throw new UpstashLimitError();
      }
      // Base64 expands decoded bytes by 4/3. Bound the wire buffer before JSON.parse.
      const maxWire = Math.ceil(reqBytes / 3) * 4 + 65536;
      const chunks = [];
      let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxWire) throw new UpstashLimitError();
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!response.ok) {
        if (isLimit(raw)) throw new UpstashLimitError();
        throw new UpstashHttpError(response.status);
      }
      let data;
      try { data = JSON.parse(raw); } catch { throw new UpstashError('invalid_json'); }
      if (batch) {
        if (!Array.isArray(data)) {
          const error = unwrap(data);
          throw error instanceof Error ? error : new UpstashError('invalid_response');
        }
        if (data.length !== commands.length) throw new UpstashError('invalid_response');
        return data.map(unwrap); // Per-command failures retain their positions, including MULTI/EXEC.
      }
      const value = unwrap(data);
      if (value instanceof Error) throw value;
      return value;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new UpstashTimeoutError();
      if (error instanceof UpstashError) throw error;
      // Network errors may echo request headers/URLs; expose only a stable classification.
      throw new UpstashError('network_error');
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    host: endpoint.host,
    command: (argv) => request('', argv, false),
    pipeline: (argvs) => request('/pipeline', argvs, true),
    multiExec: (argvs) => request('/multi-exec', argvs, true),
  };
}
