import 'server-only';

import { kvEval, kvGet } from '@/lib/kv';
import { normalizeAgentAddress } from './purchaseAddress';

export const AGENT_BINDINGS_MAX = 20;
type Binding = { owner: string; at: string };
type StorageError = { ok: false; reason: 'storage_error' };
const storageError = (): StorageError => ({ ok: false, reason: 'storage_error' });
const boundKey = (address: string) => `agent:bound:${address}`;
const ownerKey = (owner: string) => `agent:owner:${owner}`;

// Validate every snapshot before any write. A concurrent bind/unbind must never
// split ownership from either owner's index; a lost CAS is reported as 503.
const UPDATE_BINDINGS = `
for i = 1, #KEYS do
  if (redis.call('GET', KEYS[i]) or '') ~= ARGV[i] then return 0 end
end
for i = 1, #KEYS do
  local value = ARGV[#KEYS + i]
  if value == '' then
    redis.call('DEL', KEYS[i])
  else
    redis.call('SET', KEYS[i], value)
  end
end
return 1
`;

async function read(key: string): Promise<string | null> {
  const result = await kvGet(key);
  if (!result.ok) throw new Error('storage_error');
  return result.value;
}

function parseBinding(raw: string | null): Binding | null {
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (!value || !normalizeAgentAddress(value.owner) || value.owner !== value.owner.toLowerCase() ||
      typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new Error('storage_error');
  return { owner: value.owner, at: value.at };
}

function parseAddresses(raw: string | null): string[] {
  if (raw === null) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > AGENT_BINDINGS_MAX ||
      value.some((address) => !normalizeAgentAddress(address) || address !== address.toLowerCase()) ||
      new Set(value).size !== value.length) throw new Error('storage_error');
  return value;
}

async function update(keys: string[], before: (string | null)[], after: (string | null)[]): Promise<boolean> {
  const result = await kvEval<number>(UPDATE_BINDINGS, keys, [...before, ...after].map((raw) => raw ?? ''));
  return result.ok && result.value === 1;
}

const addressList = (addresses: string[]) => addresses.length ? JSON.stringify(addresses) : null;

export async function bindAgent(address: string, owner: string): Promise<
  { ok: true; address: string; boundAt: string } | StorageError | { ok: false; reason: 'binding_limit' }
> {
  const a = normalizeAgentAddress(address);
  const o = normalizeAgentAddress(owner);
  if (!a || !o) return storageError();
  try {
    const rawBound = await read(boundKey(a));
    const previous = parseBinding(rawBound);
    const previousOwner = previous && previous.owner !== o ? previous.owner : null;
    const [rawOwner, rawPreviousOwner] = await Promise.all([
      read(ownerKey(o)), previousOwner ? read(ownerKey(previousOwner)) : Promise.resolve(null),
    ]);
    const addresses = parseAddresses(rawOwner);
    if (!addresses.includes(a) && addresses.length >= AGENT_BINDINGS_MAX) return { ok: false, reason: 'binding_limit' };
    const boundAt = new Date().toISOString();
    const keys = [boundKey(a), ownerKey(o)];
    const before = [rawBound, rawOwner];
    const after: (string | null)[] = [JSON.stringify({ owner: o, at: boundAt }), JSON.stringify([...addresses.filter((item) => item !== a), a])];
    if (previousOwner) {
      keys.push(ownerKey(previousOwner));
      before.push(rawPreviousOwner);
      after.push(addressList(parseAddresses(rawPreviousOwner).filter((item) => item !== a)));
    }
    if (!(await update(keys, before, after))) return storageError();
    return { ok: true, address: a, boundAt };
  } catch {
    // Failed/partial storage reads must not grant ownership or report a false success.
    return storageError();
  }
}

export async function unbindAgent(address: string, owner: string): Promise<
  { ok: true } | StorageError | { ok: false; reason: 'not_bound' }
> {
  const a = normalizeAgentAddress(address);
  const o = normalizeAgentAddress(owner);
  if (!a || !o) return storageError();
  try {
    const rawBound = await read(boundKey(a));
    if (parseBinding(rawBound)?.owner !== o) return { ok: false, reason: 'not_bound' };
    const rawOwner = await read(ownerKey(o));
    const addresses = parseAddresses(rawOwner).filter((item) => item !== a);
    if (!(await update([boundKey(a), ownerKey(o)], [rawBound, rawOwner], [null, addressList(addresses)]))) return storageError();
    return { ok: true };
  } catch {
    // Storage failure must never be acknowledged as a completed revocation.
    return storageError();
  }
}

export async function isOwner(address: string, owner: string): Promise<
  { ok: true; isOwner: boolean; boundAt: string | null } | StorageError
> {
  const a = normalizeAgentAddress(address);
  const o = normalizeAgentAddress(owner);
  if (!a || !o) return storageError();
  try {
    const binding = parseBinding(await read(boundKey(a)));
    const matches = binding?.owner === o;
    return { ok: true, isOwner: matches, boundAt: matches ? binding.at : null };
  } catch {
    // Ownership checks fail closed when the authoritative bound key is unavailable.
    return storageError();
  }
}

export async function listAgentBindings(owner: string): Promise<
  { ok: true; addresses: { address: string; boundAt: string }[] } | StorageError
> {
  const o = normalizeAgentAddress(owner);
  if (!o) return storageError();
  try {
    const addresses = parseAddresses(await read(ownerKey(o)));
    const bindings = await Promise.all(addresses.map(async (address) => ({
      address, binding: parseBinding(await read(boundKey(address))),
    })));
    // The bound record is authoritative even if an index is stale or a rebind races this read.
    return { ok: true, addresses: bindings.flatMap(({ address, binding }) =>
      binding?.owner === o ? [{ address, boundAt: binding.at }] : []) };
  } catch {
    // Never turn storage failure into a successful empty ownership list.
    return storageError();
  }
}
