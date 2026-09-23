import { createHash } from 'node:crypto';

// Shared by the registry and the standalone inventory. Only scheme/host case and
// default ports change: URL.toString() would also rewrite paths, escapes and '/'.
// This identity deliberately differs from hiddenUrlLedger's moderation identity:
// retain raw path/query/fragment, userinfo and other host spellings here. Broadening
// equality would change existing claims; it requires a separate migration policy.
export function normalizeResourceUrl(url) {
  const parts = /^(https?):\/\/([^/?#\\]*)([\s\S]*)$/i.exec(url);
  if (!parts || !URL.canParse(url)) throw new Error('invalid_resource_url');
  const scheme = parts[1].toLowerCase();
  const authority = parts[2];
  const userEnd = authority.lastIndexOf('@') + 1;
  const user = authority.slice(0, userEnd);
  const hostPort = authority.slice(userEnd);
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]*))?$/.exec(hostPort);
  if (!match) throw new Error('invalid_resource_url');
  const port = match[2];
  const defaultPort = scheme === 'https' ? 443 : 80;
  return scheme + '://' + user + match[1].toLowerCase()
    + (port !== undefined && Number(port) !== defaultPort ? ':' + port : '') + parts[3];
}

export function resourceUrlClaimKey(url) {
  return 'x402:resource:urlclaim:' + createHash('sha256').update(normalizeResourceUrl(url), 'utf8').digest('hex');
}

// Read-only guard; callers publish the claim with their record mutation in the
// same EVAL. Hidden active records also reserve the URL. Malformed claim targets
// fail closed so storage corruption cannot let another seller replace a recipient.
// Ordinary string concatenation only (Next's minifier has broken Lua templates).
export const URL_CLAIM_GUARD =
  'local function claimAvailable(key,id) ' +
  "local held=redis.call('GET',key); " +
  'if held and held~=id then ' +
  "local raw=redis.call('GET','x402:resource:'..held); " +
  'if raw then local valid,claimed=pcall(cjson.decode,raw); ' +
  "if not valid or type(claimed)~='table' or type(claimed.active)~='boolean' then return -6 end; " +
  'if claimed.active then return -5 end; end; end; return 1; end; ';
