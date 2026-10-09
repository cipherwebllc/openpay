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
// 検査対象: リポ内の全 package-lock.json と Git 管理下の全 .npmrc (隠し dir も含む)。
// npm ci より前に実行する。.npmrc の許可キーは legacy-peer-deps のみ。
// 許容: resolved が https://registry.npmjs.org/ 始まり、または workspace link
// (resolved がリポ内相対 path で link:true か、root package 自身のエントリ)。
//
// 追加 (2026-10-10・第 7 回レビュー E4・user 裁定 R4): install script を持つパッケージ
// (lockfile の hasInstallScript) は scripts/lib/installScriptAllowlist.mjs の名前だけ許容し、
// 新規の名前が現れたら fail。取得元が公式でも、install script 付きの新規パッケージは
// npm ci の時点で任意コードを走らせるため、掟 16 第 2 文の「導入前の個別確認」を機械化する。
// 注意: hasInstallScript は npm が lockfile に書く値で、手書きで消せば検査をすり抜ける。
// lockfile の diff は PR レビューの対象 (このフラグが消える diff は疑う)。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { INSTALL_SCRIPT_ALLOWLIST } from './lib/installScriptAllowlist.mjs';

const ALLOWED_PREFIX = 'https://registry.npmjs.org/';
// userconfig/globalconfig 経由の別設定ファイルや proxy/CA による取得元の偽装が
// npm ci に波及するのを防ぐ。新しいキーは用途をレビューしてから明示的に追加する。
const ALLOWED_NPMRC_KEYS = new Set(['legacy-peer-deps']);

function collectLockfiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectLockfiles(p, out);
    else if (name === 'package-lock.json') out.push(p);
  }
  return out;
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

const lockfiles = collectLockfiles(process.cwd());
let npmrcs;
try {
  npmrcs = execFileSync('git', ['ls-files', '-z', '--', '.npmrc', '**/.npmrc'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
} catch {
  // Git の列挙失敗が「検査対象ゼロ」の偽成功へ波及するのを防ぐ。
  console.error('lockfile-gate: cannot list tracked .npmrc files; source validation did not complete');
  process.exit(1);
}
if (lockfiles.length === 0) {
  console.error('lockfile-gate: package-lock.json が見つかりません');
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
  const packages = lock.packages ?? {};
  for (const [name, pkg] of Object.entries(packages)) {
    if (name === '') continue; // root package 自身
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
    if (!resolved.startsWith(ALLOWED_PREFIX)) {
      console.error(`NG ${file}: ${name} -> ${resolved}`);
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
