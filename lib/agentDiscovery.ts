// AI エージェント向けの発見用の文書 (2026-11-27・Cloudflare の isitagentready の診断項目)。
// - /.well-known/api-catalog (RFC 9727): API の一覧 = 今ある /openapi.json と説明文書を指すだけ。
// - /.well-known/agent-skills/index.json (Agent Skills Discovery v0.2.0): 今ある
//   skills/openpay-agent/SKILL.md を 1 つだけ載せる。digest は配る bytes そのものの sha256。
// 新しい機能や約束は足さない。ここに載せるのは、すでに公開している文書の場所だけ。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_SITE_ORIGIN = 'https://open-pay.jp';
export const API_DOC_URL =
  'https://github.com/cipherwebllc/openpay/blob/main/docs/API.md';
export const AGENT_SKILL_PATH =
  '/.well-known/agent-skills/openpay-agent/SKILL.md';

/** RFC 9727 §2: カタログ自身を rel="api-catalog" で指す Link (GET と HEAD の両方に付く)。 */
export const API_CATALOG_LINK = '</.well-known/api-catalog>; rel="api-catalog"';

export function apiCatalog() {
  return {
    linkset: [
      {
        // /openapi.json の servers と同じ基点 (各 API の path は /api/...)。
        anchor: AGENT_SITE_ORIGIN,
        'service-desc': [
          { href: `${AGENT_SITE_ORIGIN}/openapi.json`, type: 'application/json' },
        ],
        'service-doc': [
          { href: API_DOC_URL, type: 'text/html' },
          { href: `${AGENT_SITE_ORIGIN}/llms.txt`, type: 'text/plain' },
        ],
      },
    ],
  };
}

/** build 時に読む (配る route は force-static)。 */
export function readAgentSkillMd() {
  return readFileSync(join(process.cwd(), 'skills', 'openpay-agent', 'SKILL.md'));
}

/** SKILL.md の先頭の front matter から name と description を取る。 */
export function skillFrontMatter(md: string): { name: string; description: string } {
  const block = md.match(/^---\n([\s\S]*?)\n---/);
  if (!block) throw new Error('SKILL.md has no front matter');
  const field = (key: string) => {
    const line = block[1].split('\n').find((l) => l.startsWith(`${key}:`));
    const value = line?.slice(key.length + 1).trim();
    if (!value) throw new Error(`SKILL.md front matter has no ${key}`);
    return value;
  };
  return { name: field('name'), description: field('description') };
}

export function agentSkillsIndex(skillMd: Buffer) {
  const { name, description } = skillFrontMatter(skillMd.toString('utf8'));
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [
      {
        name,
        type: 'skill-md',
        description,
        url: AGENT_SKILL_PATH,
        digest: `sha256:${createHash('sha256').update(skillMd).digest('hex')}`,
      },
    ],
  };
}
