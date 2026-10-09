#!/usr/bin/env node
// CI 用 lockfile 取得元 gate。package-lock.json の全依存が公式 npm レジストリ
// (https://registry.npmjs.org) から解決されていることを機械検査する。
//
// 動機 (2026-07-20 採用): AI コーディングエージェントは README/セットアップ手順を
// 信用して依存を追加するため、git URL・独自レジストリ・タイポスクワット経由の
// サプライチェーン汚染が「追加されたコード」より先に混入しうる (掟 15 の依存関係版)。
// 依存の**取得元**を lockfile 単位で固定し、公式レジストリ以外が 1 件でも
// 現れたら CI を fail させる。第三者 linter に依存せず Node 標準 API と Git で判定する
// (このゲート自体が新規依存を持つのは本末転倒のため)。
//
// 検査対象: Git 管理下の全 package-lock.json / npm-shrinkwrap.json と全 .npmrc (隠し dir も含む)。
// npm ci より前に実行する。.npmrc の許可キーは legacy-peer-deps のみ。
// 許容: resolved が `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz` の形 (dot segment・
// query・fragment・userinfo・port 指定なし)、または workspace link (link:true か root package 自身)。
// lockfileVersion は 2 以上で `packages` を持つものだけ (v1 は packages が無く検査にならない)。
//
// 追加 (2026-10-10・第 7 回レビュー E4・user 裁定 R4): install script を持つパッケージ
// (lockfile の hasInstallScript) は scripts/lib/installScriptAllowlist.mjs の名前だけ許容し、
// 新規の名前が現れたら fail。取得元が公式でも、install script 付きの新規パッケージは
// npm ci の時点で任意コードを走らせるため、掟 16 第 2 文の「導入前の個別確認」を機械化する。
// 注意: hasInstallScript は npm が lockfile に書く値で、手書きで消せば検査をすり抜ける。
// binding.gyp の暗黙 node-gyp rebuild・bundled 依存・link の prepare もフラグに出ない。
// そのため npm ci の直後に実体を走査する scripts/installed-scripts-gate.mjs を併用し (検出)、
// lockfile の diff (このフラグが消える diff) は PR レビューで見る。

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { INSTALL_SCRIPT_ALLOWLIST } from './lib/installScriptAllowlist.mjs';

const ALLOWED_PREFIX = 'https://registry.npmjs.org/';
// userconfig/globalconfig 経由の別設定ファイルや proxy/CA による取得元の偽装が
// npm ci に波及するのを防ぐ。新しいキーは用途をレビューしてから明示的に追加する。
const ALLOWED_NPMRC_KEYS = new Set(['legacy-peer-deps']);

// Git 管理下のファイルだけを列挙する (隠しディレクトリも含む)。CI の npm ci が読むのは commit された
// lockfile なので、checkout に残った未追跡の lockfile は対象外。
function trackedFiles(patterns, what) {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', ...patterns], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean);
  } catch {
    // Git の列挙失敗が「検査対象ゼロ」の偽成功へ波及するのを防ぐ。
    console.error(`lockfile-gate: cannot list tracked ${what}; source validation did not complete`);
    process.exit(1);
  }
}

// npm の INI と同様に引用符・escape・コメントを読む。引用された設定キー
// による検査すり抜けが npm ci の取得元へ波及するのを防ぐ。依存追加は不要。
function iniToken(raw) {
  let value = raw.trim();
  const quoted = (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted) {
    if (value.startsWith("'")) value = value.slice(1, -1);
    try {
      return JSON.parse(value);
    } catch {
      // INI は JSON でない単一引用符内の文字列をそのまま使う (例: 'https://...')。
      return value;
    }
  }
  return value.replace(/\\([\\;#])|[;#].*$/g, (_match, escaped) => escaped ?? '').trim();
}

// 公式レジストリの tarball URL を厳密に読む。許す形は
//   https://registry.npmjs.org/<name>/-/<unscoped>-<version>.tgz   (<name> は name か @scope/name か @scope%2fname)
// だけ。dot segment (生・%2e) は URL 正規化で `/-/` より前の名前をすり替えられるので、形の検査は
// `new URL()` で正規化した pathname に対して行い、生の文字列にも `.`/`..` の segment を許さない。
// 返り値: { name, basename } か null (= 取得元として不許可)。
// scope の先頭 @ は npm が %40 で書くこともある (`%40parcel/watcher`・`%40parcel%2Fwatcher`)。名前照合では @ に戻す。
const NAME_SEGMENT = '[^/@%]+';
const TARBALL_PATH = new RegExp(`^/((?:@|%40)${NAME_SEGMENT}(?:/|%2f|%2F)${NAME_SEGMENT}|${NAME_SEGMENT})/-/([^/]+)\\.tgz$`);
function parseRegistryTarball(resolved) {
  if (typeof resolved !== 'string' || !resolved.startsWith(ALLOWED_PREFIX)) return null;
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

const npmrcs = trackedFiles(['.npmrc', '**/.npmrc'], '.npmrc files');
const lockfiles = trackedFiles(
  ['package-lock.json', '**/package-lock.json', 'npm-shrinkwrap.json', '**/npm-shrinkwrap.json'],
  'lockfiles',
);
if (lockfiles.length === 0) {
  console.error('lockfile-gate: Git 管理下に package-lock.json / npm-shrinkwrap.json が見つかりません');
  process.exit(1);
}

let bad = 0;
// install script を持つ名前のうち、どの lockfile にも現れなかった allowlist エントリ (= 削除候補)。
const installScriptNamesSeen = new Set();
// lockfile の path (例: node_modules/playwright/node_modules/fsevents) からパッケージ名を取る。
// workspace 自身のエントリ (例: packages/x402-sdk) は node_modules/ を含まないので path をそのまま名前にする。
const packageNameOf = (path) => {
  const at = path.lastIndexOf('node_modules/');
  return at === -1 ? path : path.slice(at + 'node_modules/'.length);
};

for (const file of npmrcs) {
  const lines = readFileSync(file, 'utf8').split(/\r\n|[\r\n]/);
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:[;#]|$)/.test(line)) continue;
    const separator = line.indexOf('=');
    const rawKey = separator === -1 ? line : line.slice(0, separator);
    const key = String(iniToken(rawKey)).replace(/\[\]$/, '');
    if (!ALLOWED_NPMRC_KEYS.has(key)) {
      // 値には env 展開や認証情報があり得るので、エラーには場所と key のみを出す。
      console.error(`NG ${file}:${index + 1}: ${key} is not permitted; only legacy-peer-deps is allowed in committed .npmrc files`);
      bad++;
    }
  }
}

for (const file of lockfiles) {
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  // lockfileVersion 1 は packages を持たず (dependencies ツリーのみ)、検査対象ゼロで通ってしまう。
  const version = lock?.lockfileVersion;
  const packages = lock?.packages;
  if (!Number.isInteger(version) || version < 2 || packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    console.error(`NG ${file}: lockfileVersion must be >= 2 with a packages object (got lockfileVersion ${JSON.stringify(version ?? null)}); regenerate with a current npm`);
    bad++;
    continue;
  }
  for (const [name, pkg] of Object.entries(packages)) {
    if (name === '') continue; // root package 自身
    if (pkg === null || typeof pkg !== 'object') {
      console.error(`NG ${file}: ${name} is not a package entry`);
      bad++;
      continue;
    }
    // npm は hasInstallScript を truthy で見て script を走らせるので、boolean 以外 ("true" 等) は検査を
    // すり抜ける値として fail にする。
    if (Object.hasOwn(pkg, 'hasInstallScript') && typeof pkg.hasInstallScript !== 'boolean') {
      console.error(`NG ${file}: ${name} has a non-boolean hasInstallScript (${JSON.stringify(pkg.hasInstallScript)}); npm treats it as truthy`);
      bad++;
    }
    const tarball = parseRegistryTarball(pkg.resolved);
    // install script 付きは取得元に関係なく名前で allowlist 照合する (link も含む)。
    if (pkg.hasInstallScript === true) {
      const packageName = packageNameOf(name);
      installScriptNamesSeen.add(packageName);
      if (!Object.hasOwn(INSTALL_SCRIPT_ALLOWLIST, packageName)) {
        console.error(
          `NG ${file}: ${name} has an install script (preinstall/install/postinstall) and is not in INSTALL_SCRIPT_ALLOWLIST ` +
            '(scripts/lib/installScriptAllowlist.mjs). Review the package before adding it (CLAUDE.md 掟 16).',
        );
        bad++;
      } else {
        // allowlist の名前でも、別名 (lockfile の name が違う) や別パッケージの tarball・取得元の分からない実体は通さない。
        // path の名前は依存の宣言側が付ける名前なので、npm の別名 ("esbuild": "npm:evil@1.0.0") で allowlist の名前を
        // 名乗った別のパッケージを install script ごと通しうる。取得元の tarball の名前とも一致したときだけ効かせる。
        const fetchedName = tarball?.name ?? null;
        const declaredName = typeof pkg.name === 'string' ? pkg.name : packageName;
        if (fetchedName !== packageName || declaredName !== packageName) {
          console.error(
            `NG ${file}: ${name} has an install script and is allowlisted by name, but the package actually fetched is ` +
              `${fetchedName ?? '(no official registry tarball)'} (lockfile name: ${declaredName}). ` +
              'An npm alias or a non-registry source cannot borrow an allowlisted name (CLAUDE.md 掟 16).',
          );
          bad++;
        }
      }
    }
    const resolved = pkg.resolved;
    // workspace link (例: "packages/x402-sdk" を link 参照) は resolved がリポ内
    // 相対 path。https 以外でも link エントリだけは許容する。
    if (pkg.link === true) continue;
    if (resolved === undefined) {
      // npm は bundled/optional 等で resolved を省略することがある。取得元の偽装は
      // resolved を持つエントリで起きるため、省略自体は fail にしない (過剰検出防止)。
      continue;
    }
    if (tarball === null) {
      console.error(`NG ${file}: ${name} -> ${resolved} (not an official registry tarball URL of the form https://registry.npmjs.org/<name>/-/<name>-<version>.tgz)`);
      bad++;
    }
  }
  console.log(`OK ${file}: ${Object.keys(packages).length - 1} entries checked`);
}

if (bad > 0) {
  console.error(
    `lockfile-gate: 許可されていない .npmrc 設定・依存の取得元・install script 付きの新規パッケージが ${bad} 件あります。` +
      'git URL / 独自レジストリ / http 取得は禁止、install script 付きの新規パッケージは個別確認のうえ allowlist に追加 (CLAUDE.md 掟 16)。',
  );
  process.exit(1);
}
// allowlist にあるが lockfile に install script 付きで現れない名前 = upstream で script が消えた/依存から外れた。
// fail にはしない (npm update で native 依存が消えた PR を止めない) が、allowlist の掃除候補として出す。
const stale = Object.keys(INSTALL_SCRIPT_ALLOWLIST).filter((n) => !installScriptNamesSeen.has(n));
if (stale.length > 0) {
  console.log(`lockfile-gate: stale install script allowlist entries (no longer have install scripts): ${stale.join(', ')}`);
}
console.log(
  `lockfile-gate: 全 lockfile は公式 npm レジストリのみ、install script 付きは allowlist の ${installScriptNamesSeen.size} 名のみ、` +
    'Git 管理下の全 .npmrc は許可キーのみです',
);
