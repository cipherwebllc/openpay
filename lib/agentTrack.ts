'use client';

import { track } from '@vercel/analytics';
import type { AgentClient, AgentMode } from '@/lib/agentSetup';

type AgentEventName = 'agent_prompt_copy' | 'agent_config_generate' | 'agent_config_copy' | 'agent_store_click';
type ConfigProperties = { locale: string; client: AgentClient; mode: AgentMode };

export function trackAgentEvent(name: 'agent_config_generate' | 'agent_config_copy', properties: ConfigProperties): void;
export function trackAgentEvent(name: 'agent_prompt_copy' | 'agent_store_click', properties: { locale: string }): void;
export function trackAgentEvent(name: AgentEventName, properties: { locale: string; client?: AgentClient; mode?: AgentMode }): void {
  try {
    // 掟 13: 計測障害をコピーやリンク遷移などの UI 操作へ波及させない隔離。
    // 明示したプロパティだけを送信し、アドレス・上限値・ホスト名は送らない。
    const data = name === 'agent_config_generate' || name === 'agent_config_copy'
      ? { locale: properties.locale, client: properties.client!, mode: properties.mode! }
      : { locale: properties.locale };
    track(name, data);
  } catch {
    // 付帯処理の失敗で本来の操作を止めない。
  }
}
