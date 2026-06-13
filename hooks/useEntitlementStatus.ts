'use client';

// 期限付き利用権 status の react-query 共通 hook。各 entitlement は query key / endpoint /
// boolean field / fallback error だけを指定し、公開データ形は field の literal type を維持する。

import { useQuery, type QueryKey } from '@tanstack/react-query';

type EntitlementStatusData<TField extends string> = Record<TField, boolean> & {
  expiresAt: number | null;
  bypass: boolean;
};

type EntitlementStatusConfig<TField extends string> = {
  queryKey: QueryKey;
  enabled: boolean;
  endpoint: string;
  field: TField;
  fallbackError: string;
};

export function useEntitlementStatus<TField extends string>({
  queryKey,
  enabled,
  endpoint,
  field,
  fallbackError,
}: EntitlementStatusConfig<TField>) {
  return useQuery<EntitlementStatusData<TField>>({
    queryKey,
    enabled,
    queryFn: async () => {
      const res = await fetch(endpoint, { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as
        | (EntitlementStatusData<TField> & { ok: true })
        | { ok?: false; error?: string };
      if (!res.ok || !('ok' in json) || !json.ok) {
        throw new Error(
          'error' in json && json.error ? json.error : fallbackError,
        );
      }
      return {
        [field]: json[field],
        expiresAt: json.expiresAt,
        bypass: json.bypass,
      } as EntitlementStatusData<TField>;
    },
  });
}
