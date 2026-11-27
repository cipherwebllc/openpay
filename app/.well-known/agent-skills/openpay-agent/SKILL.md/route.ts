// skills/openpay-agent/SKILL.md をそのまま配る (2026-11-27・Agent Skills Discovery の目録が指す先)。
// 目録の digest と一致するよう、加工せず bytes のまま返す。

import { readAgentSkillMd } from '@/lib/agentDiscovery';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(readAgentSkillMd(), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
