// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('wallet release documentation', () => {
  it('documents atomic recovery, absolute storage and RPC guarantees without changing the reviewed threat model', async () => {
    const readme = await readFile('packages/x402-mcp/README.md', 'utf8');
    for (const text of ['hard link', 'wallet_home_not_absolute', 'walletErrorMessage', 'Do not delete this file', 'only copy of the key', 'validated DNS addresses are pinned']) {
      expect(readme).toContain(text);
    }
    const model = readme.slice(readme.indexOf('## Local wallet threat model\n'), readme.indexOf('\n## Steward Setup'));
    expect(createHash('sha256').update(model).digest('hex')).toBe('3fe7f4546af4dceae176a6f7523736afcdc2f8d3240fa1688691258061c09778');
    const changelog = (await readFile('packages/x402-mcp/CHANGELOG.md', 'utf8')).split('## 0.14.0')[0];
    for (const text of ['## 0.15.0', 'hard link', 'do-not-delete', 'absolute', 'one payment executor', 'every activated key', 'DNS pinning', 'fake timers']) {
      expect(changelog).toContain(text);
    }
  });
});
