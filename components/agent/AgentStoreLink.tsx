'use client';

import Link from 'next/link';
import { trackAgentEvent } from '@/lib/agentTrack';

export function AgentStoreLink({ locale, children }: { locale: string; children: React.ReactNode }) {
  return <Link href={`/${locale}/discovery`} prefetch={false} className="inline-block rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white" onClick={() => trackAgentEvent('agent_store_click', { locale })}>{children}</Link>;
}
