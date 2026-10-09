// install script (preinstall / install / postinstall) を持つパッケージの allowlist。
// scripts/lockfile-gate.mjs が package-lock.json の `hasInstallScript` と突き合わせ、
// ここに無い名前が 1 件でも現れたら CI を fail させる (CLAUDE.md 掟 16・第 7 回レビュー E4・user 裁定 R4)。
//
// 動機: npm ci は lockfile に載った全パッケージの install script を実行するため、Renovate /
// npm update で推移的依存が差し替わると「コードの追加」より先に任意コードが CI と開発機で
// 走りうる。取得元 (registry.npmjs.org) の検査だけでは typosquat・乗っ取られた新 version を
// 止められないので、install script 付きの**名前**を現状で固定し、増えたら PR レビューで明示的に
// 足す (ここを書き換える diff がレビューの単位になる)。
//
// 鍵はパッケージ名 (lockfile の path から最後の node_modules/ 以降)。nested copy
// (例: node_modules/playwright/node_modules/fsevents) も同じ名前で許容する。
// version は固定しない (version の更新は Renovate / npm update の通常 PR で見る)。
//
// 削除の目安: lockfile-gate が "stale" と出したら (= その名前にもう install script が無い)
// この一覧から外す。追加は「用途・何のための native build か」を 1 行で書く。
//
// 2026-10-10 時点の固定 (package-lock.json の hasInstallScript 12 entries = 10 名)。
// 「経由」は package-lock.json の dependencies / optionalDependencies / peerDependencies から
// 名前を引く側 (直接の親) を書く (2026-10-10 lockfile 実測)。
// link (workspace / file:) で node_modules に入る**リポ内ディレクトリ**のうち、install-time script
// (preinstall / install / postinstall / prepare・binding.gyp) を持ってよいもの。鍵は realpath の repo 相対 path
// (例: 'packages/x402-sdk')。registry 用の上の一覧は link には効かせない (ローカルの dir を allowlist の名前で
// link し manifest 名を合わせれば、公式パッケージへの承認を別実体に流用できてしまうため)。
// 2026-10-10 時点: link は packages/x402-sdk (scripts = test / prepublishOnly のみ) だけで install-time script は無し → 空。
export const LINKED_PACKAGE_SCRIPT_ALLOWLIST = Object.freeze({});

export const INSTALL_SCRIPT_ALLOWLIST = Object.freeze({
  '@parcel/watcher': 'ファイル監視の native binary。next-intl の依存',
  '@sentry/cli': 'Sentry CLI binary の取得 (sourcemap upload)。@sentry/bundler-plugin-core の依存',
  '@swc/core': 'SWC の native binary。next-intl の依存',
  bufferutil: 'ws の native 高速化 (optional peer)。websocket / @metamask/sdk-communication-layer / rpc-websockets 経由',
  'es5-ext': 'postinstall は注意文の表示のみ (optional)。websocket → d / es6-iterator / esniff / event-emitter 経由',
  esbuild: 'esbuild binary の取得。vite (vitest) の依存 (dev)',
  fsevents: 'macOS のファイル監視 native (optional)。chokidar / playwright / rollup / vite 経由',
  keccak: 'keccak256 の native 実装 (JS fallback あり)。cbw-sdk (Coinbase Wallet SDK) の依存',
  'unrs-resolver': 'eslint-import-resolver-typescript の native resolver (dev)',
  'utf-8-validate': 'ws の native 高速化 (optional peer)。websocket / @metamask/sdk-communication-layer / rpc-websockets 経由',
});
