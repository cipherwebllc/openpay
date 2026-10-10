export const OFFICIAL_REGISTRY_PREFIX: string;
export function parseRegistryTarball(resolved: unknown): { name: string; basename: string } | null;
export function declaresBundledDependencies(manifest: unknown): boolean;
