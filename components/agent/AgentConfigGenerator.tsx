'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CodeBlock } from '@/components/guide/AgentGuidePieces';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { AGENT_CLIENTS, AGENT_MODES, DEFAULT_AGENT_CONFIG_INPUT, invalidAgentConfigFields, renderAgentConfig, type AgentClient, type AgentMode, type AgentConfigField } from '@/lib/agentSetup';
import { trackAgentEvent } from '@/lib/agentTrack';

export function AgentConfigGenerator({ locale, c }: { locale: string; c: AgentPageContent['generator'] }) {
  const t = useTranslations('AgentConfigGenerator');
  const [client, setClient] = useState<AgentClient>('claude-code');
  const [mode, setMode] = useState<AgentMode>('agent-pays');
  const [input, setInput] = useState({ ...DEFAULT_AGENT_CONFIG_INPUT });
  const [touched, setTouched] = useState<Partial<Record<AgentConfigField, boolean>>>({});
  const generated = useRef(false);
  const [copiedOutput, setCopiedOutput] = useState<string | null>(null);
  const { copy, copied, available: clipboardAvailable } = useCopyToClipboard();
  // details の中身は閉じていても SSR される。server と client でコピーボタンの有無が食い違う hydration エラーを避ける。
  const available = useHydrationSafeAvailable(clipboardAvailable);
  // human-pays に適用されない入力は検証・出力の対象から外す。
  const invalid = mode === 'human-pays' ? [] : invalidAgentConfigFields(input, mode);
  const output = invalid.length === 0 ? renderAgentConfig(client, mode, input) : null;
  const fields = {
    ...c.fields,
    ...(mode === 'agent-pays-kova' ? {
      kovaWallet: { label: t('kovaWallet.label'), hint: t('kovaWallet.hint') },
      kovaAgentAddress: { label: t('kovaAgentAddress.label'), hint: t('kovaAgentAddress.hint') },
    } : {}),
  };
  function recordInteraction(nextClient = client, nextMode = mode) {
    if (generated.current) return;
    generated.current = true;
    trackAgentEvent('agent_config_generate', { locale, client: nextClient, mode: nextMode });
  }
  const fieldClass = 'mt-2 block w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900';
  return (
    <details className="min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-8">
      <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600">
        {/* summary の中身は「phrasing content か見出し 1 つ」。見出しを保ってアウトライン (h2 の並び) から消さない。 */}
        <h2 className="inline text-lg font-bold text-slate-900">
          {c.title}
          <span className="mt-1 block pl-5 text-sm font-normal text-slate-500">{c.summaryHint}</span>
        </h2>
      </summary>
      <p className="mt-3 text-sm text-slate-700">{c.lead}</p>
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="min-w-0 text-sm font-medium">{c.modeLabel}
          <select className={fieldClass} value={mode} onChange={(e) => { const value = e.target.value as AgentMode; setMode(value); recordInteraction(client, value); }}>
            {AGENT_MODES.map((value) => <option key={value} value={value}>{t(`modeOptions.${value}`)}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-sm font-medium">{c.clientLabel}
          <select className={fieldClass} value={client} onChange={(e) => { const value = e.target.value as AgentClient; setClient(value); recordInteraction(value); }}>
            {AGENT_CLIENTS.map((value) => <option key={value} value={value}>{c.clientOptions[value]}</option>)}
          </select>
        </label>
        {mode !== 'human-pays' ? (Object.keys(fields) as AgentConfigField[]).map((field) => {
          const showValidation = !field.startsWith('kova') || touched[field];
          const hasError = showValidation && invalid.includes(field);
          return (
            <div key={field} className="min-w-0">
              <label htmlFor={`agent-${field}`} className="text-sm font-medium">{fields[field]!.label}</label>
              <input id={`agent-${field}`} className={fieldClass} type="text" inputMode={field.startsWith('max') ? 'decimal' : 'text'} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={input[field]} aria-invalid={showValidation ? hasError : undefined} aria-describedby={`agent-${field}-hint${hasError ? ` agent-${field}-error` : ''}`} onBlur={() => setTouched((previous) => ({ ...previous, [field]: true }))} onChange={(e) => { setInput({ ...input, [field]: e.target.value }); setTouched((previous) => ({ ...previous, [field]: true })); recordInteraction(); }} />
              <p id={`agent-${field}-hint`} className="mt-1 text-xs text-slate-500">{fields[field]!.hint}</p>
              {hasError ? <p id={`agent-${field}-error`} className="mt-1 text-xs text-red-700">{c.invalid}</p> : null}
            </div>
          );
        }) : null}
      </div>
      {mode !== 'human-pays' ? (
        <div className="mt-4">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={input.catalogTrust} aria-describedby="agent-catalog-hint" onChange={(e) => { setInput({ ...input, catalogTrust: e.target.checked }); recordInteraction(); }} />{c.catalogTrustLabel}</label>
          <p id="agent-catalog-hint" className="mt-2 text-xs leading-relaxed text-slate-500">{c.catalogTrustHint}</p>
        </div>
      ) : <p className="mt-4 text-sm text-slate-600">{c.humanPaysNote}</p>}
      {mode === 'agent-pays-kova' ? <div className="mt-4 space-y-2 text-xs leading-relaxed text-slate-600"><p>{t('providerNote')}</p><p>{t('policyNote')}</p><p>{t('balanceNote')}</p><p>{t('setupNote')}</p><p>{t('fundingNote')}</p></div> : null}
      {output !== null ? (
        <div>
          <CodeBlock label={c.outputLabel[client]} code={output} />
          {available ? <button type="button" className="mt-3 rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium" onClick={async () => {
            if (await copy(output)) {
              setCopiedOutput(output);
              trackAgentEvent('agent_config_copy', { locale, client, mode });
            }
          }}>{copied && copiedOutput === output ? c.copied : c.copy}</button> : null}
        </div>
      ) : null}
      {mode !== 'human-pays' ? <div className="mt-4 space-y-2 text-xs leading-relaxed text-slate-600">{mode === 'agent-pays' && output !== null ? <p>{c.keyNote}</p> : null}<p>{c.feeNote}</p></div> : null}
    </details>
  );
}
