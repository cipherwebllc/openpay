// docs/agent-templates の MCP 設定例が、/agent が生成する設定 (lib/agentSetup.ts) から離れないことを検証する。
// 旧例は `BUYER_PRIVATE_KEY: "0x..."` で、コピーすると MCP が起動時に停止した。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_MCP_SPEC } from '@/lib/agentSetup';

const doc = readFileSync(
  join(process.cwd(), 'docs/agent-templates/jpyc-service-monitor.md'),
  'utf8',
);

describe('docs/agent-templates/jpyc-service-monitor.md の MCP 設定例', () => {
  it('/agent と同じ版固定のパッケージと keystore 署名を使う', () => {
    expect(doc).toContain(`"args": ["--yes", "${AGENT_MCP_SPEC}"]`);
    expect(doc).toContain('"SIGNER_MODE": "keystore"');
  });

  it('MCP 設定の JSON に秘密鍵の欄を置かない', () => {
    const json = doc.slice(doc.indexOf('"mcpServers"'), doc.indexOf('## スクリプト例'));
    expect(json).not.toMatch(/PRIVATE_KEY/);
  });
});
