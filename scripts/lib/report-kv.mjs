// Shared transport for the three read-only reports, with their existing credentials explicit.
// Keep the original plain-JSON wire and failure policy until B-R8. The backup client's
// base64 header, endpoint validation, limits, redirects and error redaction would change it.
export function createReportKv({ url, token }) {
  return async function kv(command) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
    // JSON already preserves strings recursively, arrays (including flat HGETALL), numbers
    // and nulls. Switching to the backup client's Uint8Array results needs a text adapter.
    return (await res.json()).result;
  };
}
