// Run the real CLI with fixture-only I/O. Never fall through to live fetch or inherit credentials.
import { readFileSync, writeSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(0, 'utf8'));
const now = Date.parse('2026-09-30T23:59:59.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};

let index = 0;
globalThis.fetch = async (url, init) => {
  // A separate pipe keeps the actual stdout/stderr byte fixtures free of harness output.
  writeSync(3, `${JSON.stringify({ url, ...init })}\n`);
  const reply = fixture.replies[index++];
  if (!reply) throw new Error('Unexpected fixture request');
  if (reply.throw) {
    const error = new Error(reply.throw.message);
    error.name = reply.throw.name;
    throw error;
  }
  return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status ?? 200 });
};

// Extraction necessarily moves stack locations. Keep the uncaught name/message and exit 1,
// omitting only Node's source excerpt, stack frames and version banner from error goldens.
process.on('uncaughtException', (error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
