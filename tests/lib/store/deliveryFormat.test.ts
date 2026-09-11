import { describe, expect, it } from 'vitest';
import { DELIVERY_FORMATS, deliveryFormatFields, deliveryFormatOf } from '@/lib/store/deliveryFormat';

describe('delivery formats', () => {
  const cases = [
    ['download', 'url', 'download'],
    ['pdf', 'url', 'pdf'],
    ['zip', 'url', 'zip'],
    ['external', 'url', 'external'],
    ['prompt', 'text', 'prompt'],
    ['api', 'text', 'api'],
  ] as const;

  it('keeps the six formats in display order', () => {
    expect(DELIVERY_FORMATS.map(({ id }) => id)).toEqual(cases.map(([id]) => id));
  });

  it.each(cases)('%s round-trips its stored fields', (id, contentKind, label) => {
    expect(deliveryFormatFields(id)).toEqual({ contentKind, label });
    expect(deliveryFormatOf({ contentKind, label })).toBe(id);
  });

  it('does not normalize unusual existing combinations', () => {
    expect(deliveryFormatOf({ contentKind: 'text', label: 'download' })).toBeNull();
    expect(deliveryFormatOf({ contentKind: 'url', label: 'api' })).toBeNull();
  });
});
