import type { HostedLabel } from '@/lib/x402/hostedStore';

export const DELIVERY_FORMATS = [
  { id: 'download', contentKind: 'url', label: 'download' },
  { id: 'pdf', contentKind: 'url', label: 'pdf' },
  { id: 'zip', contentKind: 'url', label: 'zip' },
  { id: 'external', contentKind: 'url', label: 'external' },
  { id: 'prompt', contentKind: 'text', label: 'prompt' },
  { id: 'api', contentKind: 'text', label: 'api' },
] as const;

export type DeliveryFormatId = (typeof DELIVERY_FORMATS)[number]['id'];

type DeliveryFormatFields = { contentKind: 'url' | 'text'; label: HostedLabel };

export function deliveryFormatOf(value: DeliveryFormatFields): DeliveryFormatId | null {
  return DELIVERY_FORMATS.find(({ contentKind, label }) =>
    contentKind === value.contentKind && label === value.label,
  )?.id ?? null;
}

export function deliveryFormatFields(id: DeliveryFormatId): DeliveryFormatFields {
  const { contentKind, label } = DELIVERY_FORMATS.find((format) => format.id === id)!;
  return { contentKind, label };
}
