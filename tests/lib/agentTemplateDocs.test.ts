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

  // 第 7 回レビュー E17 follow-up (Codex): 日付境界の保証は delta だけ。snapshot は直近 limit 件で切る。
  it('limit の日付境界は delta に限り、snapshot は直近 limit 件と書く', () => {
    expect(doc).toContain('delta(`changedSince` あり)の `limit` は**日付境界で丸められます**');
    expect(doc).toContain('スナップショット(`changedSince` なし)は直近 `limit` 件を返すので、同じ日の途中で切れることがあります');
    expect(doc).not.toContain('- `limit` は**日付境界で丸められます**'); // 限定なしの書き方に戻さない
  });

  it('Payment Monitor の重複排除キーと slug 移行の手順を書く', () => {
    expect(doc).toContain('重複排除の鍵は `slug + date + changeCategory`');
    expect(doc).toContain('`slug` が付く前に保存したイベントは `provider` の鍵で残っているので、`slug` つきの行は同じ行の `provider` で組んだ旧い鍵とも照合してください');
    expect(doc).toContain('`provider` はイベントを記録した時点の表示名で固定され、ディレクトリ側の名称変更には追随しません');
    expect(doc).not.toContain('ディレクトリ側の名称変更で変わることがあります');
  });

  it('MCP 設定の JSON に秘密鍵の欄を置かない', () => {
    const json = doc.slice(doc.indexOf('"mcpServers"'), doc.indexOf('## スクリプト例'));
    expect(json).not.toMatch(/PRIVATE_KEY/);
  });
});
