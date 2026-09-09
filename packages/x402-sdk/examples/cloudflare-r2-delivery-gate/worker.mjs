import { createDeliveryGate } from 'openpay-x402-sdk/delivery';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Disposition': 'attachment',
};
const instances = new WeakMap();

async function startup(env) {
  if (!instances.has(env)) {
    const pending = (async () => {
      const objects = JSON.parse(env.OBJECT_KEYS ?? '{"1":"file-v1.zip"}');
      if (!objects || Array.isArray(objects) || typeof objects !== 'object' ||
        Object.entries(objects).some(([rev, key]) => !/^[1-9][0-9]*$/.test(rev) || typeof key !== 'string' || !key)) {
        throw new Error('invalid_object_map');
      }
      const gate = createDeliveryGate({
        product: env.OPENPAY_PRODUCT_ID, audience: env.AUDIENCE,
        replayStore: env.REPLAY ? {
          async consume(jti, expSeconds) {
            const id = env.REPLAY.idFromName(`${env.OPENPAY_PRODUCT_ID}:${new URL(env.AUDIENCE).origin}:${jti}`);
            const response = await env.REPLAY.get(id).fetch('https://replay.internal/consume', {
              method: 'POST', body: JSON.stringify({ expSeconds }),
            });
            if (response.status !== 200) throw new Error('replay_store_error');
            return response.json();
          },
        } : undefined,
      });
      // Workers cannot fetch at module evaluation: initialize on the first event,
      // before any file operation. Failed startup can retry on the next request.
      await gate.ready();
      return { gate, objects };
    })();
    instances.set(env, pending);
    pending.catch(() => instances.delete(env));
  }
  return instances.get(env);
}

const worker = {
  async fetch(request, env) {
    try {
      const { gate, objects } = await startup(env);
      const verified = await gate.verifyRequest(request);
      if (new URL(request.url).origin !== new URL(env.AUDIENCE).origin ||
        !['GET', 'HEAD'].includes(request.method) || !Object.hasOwn(objects, String(verified.revision))) {
        throw new Error('denied');
      }
      // Product is pinned by the gate; revision selects only this trusted map.
      // No Cache API lookup, request-derived object key, or public bucket URL.
      const key = objects[String(verified.revision)];
      const file = await (request.method === 'HEAD' ? env.FILES.head(key) : env.FILES.get(key));
      if (!file || verified.exp * 1000 <= Date.now()) throw new Error('denied');
      // This small template ignores Range/conditional headers and serves a full
      // 200 (HEAD returns metadata). Every such request still requires a ticket.
      return new Response(request.method === 'HEAD' ? null : file.body, {
        headers: { ...PRIVATE_HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
      });
    } catch {
      // Do not expose request URLs, tickets, R2 keys or upstream exceptions.
      return Response.json({ error: 'delivery_denied' }, { status: 403, headers: PRIVATE_HEADERS });
    }
  },
};

export default worker;

// One private Durable Object per namespaced jti. Only the binding can reach it.
export class Replay {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const { expSeconds } = await request.json();
    const consumed = await this.state.blockConcurrencyWhile(async () => {
      if (!Number.isSafeInteger(expSeconds) || expSeconds * 1000 <= Date.now() ||
        await this.state.storage.get('consumed')) return false;
      await this.state.storage.put('consumed', true);
      await this.state.storage.setAlarm(expSeconds * 1000);
      return true;
    });
    return Response.json(consumed);
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
