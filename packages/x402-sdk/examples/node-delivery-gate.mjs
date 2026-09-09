import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDeliveryGate } from 'openpay-x402-sdk/delivery';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'Content-Disposition': 'attachment',
};

async function presignObject({ key, method, expiresAt, expiresInSeconds }) {
  // Implement with YOUR storage SDK and private bucket. Bind key and method (GET/HEAD), and
  // set the signature's absolute expiry <= expiresAt (not "now + 60"). If the
  // SDK only takes a duration, anchor its signing time before this function's
  // async work and cap it to expiresInSeconds. Never log the URL or ticket.
  void key; void method; void expiresAt; void expiresInSeconds;
  throw new Error('Implement seller presigning before starting this example');
}

export function createDeliveryHandler({ gate, audience, objectKeys, presign = presignObject, now = Date.now }) {
  return async (req, res) => {
    try {
      // Preserve duplicate Authorization fields so the SDK rejects ambiguity.
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const request = new Request(new URL(req.url, audience), { method: req.method, headers });
      const verified = await gate.verifyRequest(request);
      if (new URL(request.url).origin !== new URL(audience).origin ||
        !['GET', 'HEAD'].includes(req.method) || !Object.hasOwn(objectKeys, String(verified.revision))) throw new Error('denied');
      const key = objectKeys[String(verified.revision)];
      if (typeof key !== 'string' || !key) throw new Error('denied');
      const expiresAt = verified.exp * 1000;
      const expiresInSeconds = Math.floor((expiresAt - now()) / 1000);
      if (expiresInSeconds <= 0) throw new Error('expired');
      const location = new URL(await presign({ key, method: req.method, expiresAt, expiresInSeconds }));
      if (location.protocol !== 'https:' || location.username || location.password || now() >= expiresAt) throw new Error('denied');
      // HEAD/Range/conditional requests are authorized here too. A presigned URL
      // is a separate bearer capability; its expiry must satisfy the stub above.
      res.writeHead(302, { ...PRIVATE_HEADERS, Location: location.href });
      res.end();
    } catch {
      res.writeHead(403, { ...PRIVATE_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'delivery_denied' }));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const audience = process.env.AUDIENCE;
  const gate = createDeliveryGate({ product: process.env.OPENPAY_PRODUCT_ID, audience });
  await gate.ready(); // Fail startup on unsupported Ed25519 or unavailable JWKS.
  const objectKeys = JSON.parse(process.env.OBJECT_KEYS ?? '{"1":"file-v1.zip"}');
  createServer(createDeliveryHandler({ gate, audience, objectKeys })).listen(8787, '127.0.0.1');
  // Place behind HTTPS at AUDIENCE; keep the bucket private. This example permits
  // ticket replay within its TTL; inject an atomic replayStore to make it single-use.
}
