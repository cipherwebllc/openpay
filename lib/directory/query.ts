import {
  DIRECTORY_CATEGORIES,
  DIRECTORY_CHAINS,
  DIRECTORY_LANGUAGES,
  DIRECTORY_STATUSES,
  DIRECTORY_TOKENS,
  type DirectoryCategory,
  type DirectoryChain,
  type DirectoryEnvelope,
  type DirectoryEntry,
  type DirectoryLanguage,
  type DirectoryQuery,
  type DirectoryStatus,
  type DirectoryToken,
  type DirectoryVerificationSnapshot,
} from '@/lib/directory/types';

export const DIRECTORY_DEFAULT_LIMIT = 20;
export const DIRECTORY_MAX_LIMIT = 50;
export const DIRECTORY_MAX_OFFSET = 1000;
export const DIRECTORY_MAX_KEYWORD_LENGTH = 100;
export const DIRECTORY_LICENSE_NOTICE =
  'Directory metadata is provided for informational purposes. Verify current details with each cited source before use. sourceOk reports source URL reachability only, not whether the information is true.';

/** 受理するクエリキーの単一情報源 (openapi/Bazaar 宣言がここからずれると 400 を踏む)。 */
export const QUERY_KEYS = new Set([
  'keyword',
  'category',
  'token',
  'chain',
  'language',
  'supportsJpyc',
  'supportsUsdc',
  'supportsX402',
  'supportsMcp',
  'status',
  'limit',
  'offset',
]);

type QueryError = {
  ok: false;
  error: 'invalid_query';
};

export type DirectoryQueryValidation =
  | { ok: true; value: DirectoryQuery }
  | QueryError;

function allowlisted<T extends string>(
  raw: string | null,
  values: readonly T[],
): T | undefined | null {
  if (raw === null || raw === '') return undefined;
  const normalized = raw.toLowerCase();
  return values.includes(normalized as T) ? (normalized as T) : null;
}

function booleanFilter(raw: string | null): boolean | undefined | null {
  if (raw === null || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

function boundedInteger(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min) return null;
  return Math.min(parsed, max);
}

export function validateDirectoryQuery(
  searchParams: URLSearchParams,
): DirectoryQueryValidation {
  for (const key of searchParams.keys()) {
    if (!QUERY_KEYS.has(key)) return { ok: false, error: 'invalid_query' };
  }

  const keywordRaw = searchParams.get('keyword');
  const keyword = keywordRaw?.trim() || undefined;
  if (keyword && keyword.length > DIRECTORY_MAX_KEYWORD_LENGTH) {
    return { ok: false, error: 'invalid_query' };
  }

  const category = allowlisted(
    searchParams.get('category'),
    DIRECTORY_CATEGORIES,
  );
  const token = allowlisted(searchParams.get('token'), DIRECTORY_TOKENS);
  const chain = allowlisted(searchParams.get('chain'), DIRECTORY_CHAINS);
  const language = allowlisted(
    searchParams.get('language'),
    DIRECTORY_LANGUAGES,
  );
  const status = allowlisted(searchParams.get('status'), DIRECTORY_STATUSES);
  const supportsJpyc = booleanFilter(searchParams.get('supportsJpyc'));
  const supportsUsdc = booleanFilter(searchParams.get('supportsUsdc'));
  const supportsX402 = booleanFilter(searchParams.get('supportsX402'));
  const supportsMcp = booleanFilter(searchParams.get('supportsMcp'));
  const limit = boundedInteger(
    searchParams.get('limit'),
    DIRECTORY_DEFAULT_LIMIT,
    1,
    DIRECTORY_MAX_LIMIT,
  );
  const offset = boundedInteger(
    searchParams.get('offset'),
    0,
    0,
    DIRECTORY_MAX_OFFSET,
  );

  if (
    category === null ||
    token === null ||
    chain === null ||
    language === null ||
    status === null ||
    supportsJpyc === null ||
    supportsUsdc === null ||
    supportsX402 === null ||
    supportsMcp === null ||
    limit === null ||
    offset === null
  ) {
    return { ok: false, error: 'invalid_query' };
  }

  return {
    ok: true,
    value: {
      ...(keyword ? { keyword } : {}),
      ...(category ? { category: category as DirectoryCategory } : {}),
      ...(token ? { token: token as DirectoryToken } : {}),
      ...(chain ? { chain: chain as DirectoryChain } : {}),
      ...(language ? { language: language as DirectoryLanguage } : {}),
      ...(supportsJpyc === undefined ? {} : { supportsJpyc }),
      ...(supportsUsdc === undefined ? {} : { supportsUsdc }),
      ...(supportsX402 === undefined ? {} : { supportsX402 }),
      ...(supportsMcp === undefined ? {} : { supportsMcp }),
      ...(status ? { status: status as DirectoryStatus } : {}),
      limit,
      offset,
    },
  };
}

export function capDirectoryLimit(
  query: DirectoryQuery,
  maxLimit: number,
): DirectoryQuery {
  return { ...query, limit: Math.min(query.limit, maxLimit) };
}

export function publishedDirectoryEntries(
  entries: readonly DirectoryEntry[],
): readonly DirectoryEntry[] {
  return entries.filter((entry) => entry.status === 'published');
}

export function findPublishedDirectoryEntry(
  entries: readonly DirectoryEntry[],
  slug: string,
): DirectoryEntry | undefined {
  return entries.find(
    (entry) => entry.status === 'published' && entry.slug === slug,
  );
}

export function queryDirectory(
  entries: readonly DirectoryEntry[],
  query: DirectoryQuery,
): { items: readonly DirectoryEntry[]; total: number } {
  const keyword = query.keyword?.toLowerCase();
  const matches = publishedDirectoryEntries(entries).filter((entry) => {
    const facts = entry.facts;
    if (
      keyword &&
      ![
        entry.name,
        entry.nameJa,
        facts.description,
        ...facts.tags,
      ].some((value) => value.toLowerCase().includes(keyword))
    ) {
      return false;
    }
    if (query.category && facts.category !== query.category) return false;
    if (query.token && !facts.tokens.includes(query.token)) return false;
    if (query.chain && !facts.chains.includes(query.chain)) return false;
    if (query.language && !facts.languages.includes(query.language)) return false;
    if (
      query.supportsJpyc !== undefined &&
      facts.supportsJpyc !== query.supportsJpyc
    ) {
      return false;
    }
    if (
      query.supportsUsdc !== undefined &&
      facts.supportsUsdc !== query.supportsUsdc
    ) {
      return false;
    }
    if (
      query.supportsX402 !== undefined &&
      facts.supportsX402 !== query.supportsX402
    ) {
      return false;
    }
    if (
      query.supportsMcp !== undefined &&
      facts.supportsMcp !== query.supportsMcp
    ) {
      return false;
    }
    if (query.status && entry.status !== query.status) return false;
    return true;
  });

  return {
    items: matches.slice(query.offset, query.offset + query.limit),
    total: matches.length,
  };
}

export function createDirectoryEnvelope<TQuery>(
  query: TQuery,
  result: { items: readonly DirectoryEntry[]; total: number },
  generatedAt: string,
  verificationSnapshot: DirectoryVerificationSnapshot,
): DirectoryEnvelope<TQuery> {
  let oldest: string | null = null;
  let newestVerifiedAt: string | null = null;
  let oldestSourceCheckedAt: string | null = null;
  const attribution = new Set<string>();
  const items = result.items.map((entry) => {
    const candidate = verificationSnapshot[entry.slug];
    const source = candidate?.sourceUrl === entry.sourceUrl ? candidate : null;
    if (
      source &&
      (oldestSourceCheckedAt === null || source.checkedAt < oldestSourceCheckedAt)
    ) {
      oldestSourceCheckedAt = source.checkedAt;
    }
    return {
      ...entry,
      sourceCheckedAt: source?.checkedAt ?? null,
      sourceOk: source?.ok ?? null,
    };
  });

  for (const entry of items) {
    if (oldest === null || entry.verifiedAt < oldest) oldest = entry.verifiedAt;
    if (newestVerifiedAt === null || entry.verifiedAt > newestVerifiedAt) {
      newestVerifiedAt = entry.verifiedAt;
    }
    attribution.add(entry.attribution);
  }

  return {
    schemaVersion: '1.0',
    query,
    items,
    total: result.total,
    generatedAt,
    dataFreshness: { oldest, newestVerifiedAt, oldestSourceCheckedAt },
    licenseNotice: DIRECTORY_LICENSE_NOTICE,
    attribution: [...attribution],
  };
}

export function directoryCategoryCounts(
  entries: readonly DirectoryEntry[],
): readonly { category: DirectoryCategory; count: number }[] {
  const counts = new Map<DirectoryCategory, number>();
  for (const entry of publishedDirectoryEntries(entries)) {
    const category = entry.facts.category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return DIRECTORY_CATEGORIES.flatMap((category) => {
    const count = counts.get(category);
    return count === undefined ? [] : [{ category, count }];
  });
}

export function directoryStats(entries: readonly DirectoryEntry[]): {
  entryCount: number;
  categoryCount: number;
  lastUpdated: string | null;
} {
  const published = publishedDirectoryEntries(entries);
  let lastUpdated: string | null = null;

  for (const entry of published) {
    if (lastUpdated === null || entry.updatedAt > lastUpdated) {
      lastUpdated = entry.updatedAt;
    }
  }

  return {
    entryCount: published.length,
    categoryCount: directoryCategoryCounts(published).length,
    lastUpdated,
  };
}

export function directoryTagCounts(
  entries: readonly DirectoryEntry[],
): readonly { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of publishedDirectoryEntries(entries)) {
    for (const tag of new Set(entry.facts.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
