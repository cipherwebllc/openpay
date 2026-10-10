// 公式 npm レジストリの tarball URL を厳密に読む (scripts/lockfile-gate.mjs と scripts/installed-scripts-gate.mjs が共用)。
// 許す形は
//   https://registry.npmjs.org/<name>/-/<unscoped>-<version>.tgz
//   (<name> は name か @scope/name。scope の @ は %40、区切りの / は %2f / %2F でもよい = npm が出す正規の形)
// だけ。dot segment (生・%2e) は URL 正規化で `/-/` より前の名前をすり替えられるので、形の検査は
// `new URL()` で正規化した pathname に対して行い、生の文字列にも `.`/`..` の segment を許さない。
// query / fragment / userinfo / port 指定・大文字のホスト・http は不許可 (取得元として同一でも形を 1 つに固定する)。

export const OFFICIAL_REGISTRY_PREFIX = 'https://registry.npmjs.org/';

const NAME_SEGMENT = '[^/@%]+';
const TARBALL_PATH = new RegExp(`^/((?:@|%40)${NAME_SEGMENT}(?:/|%2f|%2F)${NAME_SEGMENT}|${NAME_SEGMENT})/-/([^/]+)\\.tgz$`);

/**
 * @param {unknown} resolved lockfile の resolved
 * @returns {{ name: string, basename: string } | null} 取得元として許可できる tarball なら名前 (@ と / に正規化済み)。
 */
export function parseRegistryTarball(resolved) {
  if (typeof resolved !== 'string' || !resolved.startsWith(OFFICIAL_REGISTRY_PREFIX)) return null;
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return null;
  }
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) return null;
  const rawPath = resolved.slice('https://registry.npmjs.org'.length);
  // 生の path に dot segment (生・エンコード) があれば正規化で消えていても不許可。
  if (rawPath.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) return null;
  const match = TARBALL_PATH.exec(url.pathname);
  if (!match || url.pathname !== rawPath) return null;
  const name = match[1].replace(/^%40/, '@').replace(/%2f/i, '/');
  const basename = match[2];
  const unscoped = name.slice(name.lastIndexOf('/') + 1);
  if (unscoped === '.' || unscoped === '..' || !basename.startsWith(`${unscoped}-`)) return null;
  return { name, basename };
}
