'use client';

import { track } from '@vercel/analytics';
import type { AgentClient, AgentMode, AgentOpenInApp } from '@/lib/agentSetup';

type AgentEventName = 'agent_prompt_copy' | 'agent_open_in' | 'agent_config_generate' | 'agent_config_copy' | 'agent_store_click' | 'agent_fund_send' | 'agent_try_prompt_copy' | 'agent_purchases_signin' | 'agent_proof_bound' | 'agent_purchases_view';
type ConfigProperties = { locale: string; client: AgentClient; mode: AgentMode };

export function trackAgentEvent(name: 'agent_config_generate' | 'agent_config_copy', properties: ConfigProperties): void;
export function trackAgentEvent(name: 'agent_prompt_copy' | 'agent_store_click' | 'agent_fund_send' | 'agent_purchases_signin' | 'agent_proof_bound' | 'agent_purchases_view', properties: { locale: string }): void;
export function trackAgentEvent(name: 'agent_open_in', properties: { locale: string; app: AgentOpenInApp }): void;
/** 「Agent に頼めること」のコピー。送るのは依頼文の id だけで、本文は送らない。 */
export function trackAgentEvent(name: 'agent_try_prompt_copy', properties: { locale: string; id: string }): void;
export function trackAgentEvent(name: AgentEventName, properties: { locale: string; client?: AgentClient; mode?: AgentMode; app?: AgentOpenInApp; id?: string }): void {
  try {
    // 掟 13: 計測障害をコピーやリンク遷移などの UI 操作へ波及させない隔離。
    // 明示したプロパティだけを送信し、アドレス・上限値・ホスト名は送らない。
    const data = name === 'agent_config_generate' || name === 'agent_config_copy'
      ? { locale: properties.locale, client: properties.client!, mode: properties.mode! }
      : name === 'agent_open_in'
        ? { locale: properties.locale, app: properties.app! }
        : name === 'agent_try_prompt_copy'
          ? { locale: properties.locale, id: properties.id! }
          : { locale: properties.locale };
    track(name, data);
  } catch {
    // 付帯処理の失敗で本来の操作を止めない。
  }
}
