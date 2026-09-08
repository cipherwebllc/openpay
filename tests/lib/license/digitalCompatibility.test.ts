// 既存デジタル money-path の Lua 文字列を PR B 前の SHA-256 で固定する。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const original = {
  "QUOTE_RATE_LIMIT": "432485e228b9b3021f594e941625f7350d93dcb4d2556f7e5f230a4db3251a37",
  "CLAIM_SIGNED_INTENT": "341bec0178e7032279f3879a8b21b89cf9c6f84803443372af8f9bc07721921a",
  "CLAIM_SETTLEMENT": "7b201a3779490d00e2260c736f12237d6b65e10dfc567d9bb123533002e77c2a",
  "CAS_PENDING_INTENT": "d80ebc0fe8baa3a2b61ef2eecda30d688391262f69234f0cc42d656b907acee4",
  "RECORD_PURCHASE_TRANSACTION": "a6bd96b8cd6205d8019322a7103f8b9a6744209955155265a6ca4eb921ebd989",
  "ADOPT_RECONCILED_TRANSACTION": "71eed7aacf97e5750e64f916f1a918c4621b54fc3074a38c7d537259125e9ec4",
  "MARK_PURCHASE_INDETERMINATE": "e65ef51e1e05ae2af000ef3ae409009e64b2f61294fdef04ad3a864190dde323",
  "MARK_PURCHASE_FAILED_PREBROADCAST": "b2d954adb5bb5ec8e57857782334dfe045f4907149dd8462975e586c180ee66b",
  "FINALIZE_PURCHASE": "ebd93d0584f3779519bea44a5baf921756a455baae9afc274db115ffd6f9dd81",
  "READ_LIBRARY_SCORE": "d53af4dba82c29d6233a029895ada37af892fe301e51f013770d6dcc7578d294",
  "LIST_PENDING_INTENTS": "ebc0aa83da3ec1d2b2a7d62bc3c0526e3960b1b028b6d41600faf1c75f63f8ee",
  "REMOVE_TERMINAL_PENDING_MEMBER": "2ed9113e68b2a73df3561f865523449aa8de3fae45416f8e27616eff1173b291",
  "QUARANTINE_PENDING_MEMBER": "fff5b143e7f894679d9c6f47f3f4e9261265c9236fcb45550e52b15fc53cb11d"
};
describe('digital purchase Lua byte compatibility', () => {
  it('preserves every pre-existing script byte for byte', () => {
    const source = readFileSync('lib/x402/purchaseIntent.ts', 'utf8');
    const scripts = Object.fromEntries([...source.matchAll(/const ([A-Z_]+) = `([\s\S]*?)`;/g)].map((m) => [m[1], createHash('sha256').update(m[2]!).digest('hex')]));
    for (const [name, hash] of Object.entries(original)) expect(scripts[name], name).toBe(hash);
  });
});
