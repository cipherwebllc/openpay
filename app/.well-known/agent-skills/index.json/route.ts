// Agent Skills Discovery の目録 (2026-11-27)。載せるのは skills/openpay-agent/SKILL.md の 1 つだけ。
// digest は同じ build で配る SKILL.md の bytes から作る (lib/agentDiscovery.ts)。

import { agentSkillsIndex, readAgentSkillMd } from '@/lib/agentDiscovery';

export const dynamic = 'force-static';

export function GET(): Response {
  return Response.json(agentSkillsIndex(readAgentSkillMd()));
}
