# npm リリース手順 — openpay-x402-sdk / openpay-x402-mcp

2 パッケージは**依存関係でつながっているので順序が固定**される。MCP の
`package-lock.json` は SDK を**公式 npm レジストリから**解決する (掟 16) ため、
**SDK を publish するまで MCP の lockfile は再生成できない**。したがって
「バージョン bump の commit」と「publish 後の lockfile 追従 commit」は必ず分かれる。

publish は **user が自分の npm 認証で実行する**。エージェントは publish しない
(自律運転の型: npm publish は user の明示承認事項)。

---

## 前提 (エージェントがここまで済ませている状態)

- `packages/x402-sdk/package.json` の `version` を新バージョンへ
- `packages/x402-sdk/CHANGELOG.md` に新バージョンの節
- `packages/x402-mcp/package.json` の `version` と
  `dependencies["openpay-x402-sdk"]` = `^<SDK 新バージョン>`
- `packages/x402-mcp/CHANGELOG.md` に新バージョンの節
- ルート `package-lock.json` の `packages/x402-sdk` エントリが新バージョン
  (ルートは `file:packages/x402-sdk` 参照なので `npm install` で追従する)
- `packages/x402-mcp/package-lock.json` は**旧 SDK バージョンのまま**
  (= 手編集しない。整合しない `integrity` を書くと install が壊れる)

この状態では `tests/packages/x402-mcp-entrypoint.test.ts` の
「MCP lockfile の SDK version == SDK package.json の version」フェンスが
**意図どおり失敗する**。publish 後の手順 2 で解消する。

---

## 手順

### 1. SDK を publish (作業ブランチ上)

```bash
cd packages/x402-sdk
npm publish --dry-run     # files / version / 同梱物を目視
npm publish --access public
```

### 2. MCP の lockfile を再生成して commit

```bash
cd ../x402-mcp
npm install               # 公式 registry から新 SDK を解決し integrity を書き込む
node -e "console.log(require('./package-lock.json').packages['node_modules/openpay-x402-sdk'])"
# → version が新バージョン・resolved が https://registry.npmjs.org/... であること
git add package-lock.json
git commit                # 例: chore(mcp): SDK <ver> publish 後の lockfile を公式 registry から再生成
```

### 3. 検証

```bash
npx vitest run tests/packages
node scripts/lockfile-gate.mjs
npm run typecheck
```

手順 2 の前に失敗していた entrypoint テストがここで green になる。ならない場合は
lockfile の `resolved` が registry を向いていないか、version が食い違っている。

### 4. push → PR → CI green → squash merge

CI が権威 (掟 2)。`node scripts/ci-wait.mjs <PR番号>` で settle を待ち、
nonSUCCESS=0 を確認してから merge。merge は user の指示を待つ。

### 5. MCP を publish (merge 済みの main から)

```bash
git checkout main && git pull
cd packages/x402-mcp
npm publish --dry-run
npm publish --access public
```

MCP を先に publish すると、まだ存在しない SDK バージョンに依存する tarball が
公開されてしまう。必ず SDK が先。

### 6. 公開後の確認とドキュメント追従

```bash
npm view openpay-x402-sdk version
npm view openpay-x402-mcp version
npm view openpay-x402-mcp dependencies
```

バージョンを明記している箇所を grep して更新する:

```bash
grep -rn "openpay-x402-mcp" --exclude-dir=node_modules --exclude-dir=.git . | grep -E "0\.[0-9]+\.[0-9]+"
grep -rn "openpay-x402-sdk" --exclude-dir=node_modules --exclude-dir=.git . | grep -E "0\.[0-9]+\.[0-9]+"
```

対象は README / `docs/` / `public/llms.txt` / `lib/aiPayGuide.ts` 等。
**現状、固定バージョンを引用している箇所は無い** (README の
「`openpay-x402-mcp` パッケージ (≥ 0.9.0)」は profile 分割の下限を示す表現で、
新版でも真のまま)。llms.txt を書き換える場合は掟 14 の開示 3 点セットに従い、
公開文言の確定は user の承認を待つ。

---

## 逸脱時の注意

- `packages/x402-mcp/package-lock.json` を**手編集しない**。`integrity` は
  publish 済み tarball のハッシュで、手で正しい値は作れない。
- SDK だけ publish して MCP の追従 commit を忘れると、main は
  entrypoint フェンスで赤いままになる。手順 2 まで一続きで行う。
- publish を取り消したくなっても `npm unpublish` は 72 時間制限や
  再利用不可バージョンの制約がある。`--dry-run` を必ず先に通す。
