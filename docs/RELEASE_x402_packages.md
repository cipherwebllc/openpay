# npm リリース手順 — openpay-x402-sdk / openpay-x402-mcp

2 パッケージは**依存関係でつながっているので順序が固定**される (必ず SDK が先)。
MCP の `package-lock.json` は SDK を**公式 npm レジストリから**解決する (掟 16) ため、
MCP が要求する SDK の下限を上げるときは **SDK を publish するまで MCP の lockfile を
再生成できない**。

publish は **user が自分の npm 認証で実行する**。エージェントは publish しない
(自律運転の型: npm publish は user の明示承認事項)。

`tests/packages/x402-mcp-entrypoint.test.ts` のフェンスは「MCP の
`dependencies["openpay-x402-sdk"]` == `^<MCP lockfile が固定した SDK の version>`・
lockfile 側の依存表記も同じ・`resolved` が公式 registry」を見る。SDK の
`package.json` の version とは比べない。

リリースは次の 2 型のどちらか。

- **A. MCP の SDK 範囲を変えない** (例: SDK 0.10.3 / MCP 0.19.1。MCP は `^0.10.1` の
  まま)。MCP の lockfile は自分の `version` 2 か所だけ変わり、フェンスは green のまま。
  PR を merge してから、main で SDK → MCP の順に publish する (下の「A の手順」)。
- **B. MCP が新しい SDK を必要とする** (`^<SDK 新バージョン>` に上げる)。SDK を先に
  publish し、MCP の lockfile を registry から作り直してから merge する
  (下の「B の手順」)。

---

## 前提 (エージェントがここまで済ませている状態)

- `packages/x402-sdk/package.json` の `version` を新バージョンへ
- `packages/x402-sdk/tests/delivery-package.test.mjs` の `dry.version` の期待値を
  同じ新バージョンへ (`npm --prefix packages/x402-sdk test` と publish 時の
  `prepublishOnly` がこの値で落ちる)
- `packages/x402-sdk/CHANGELOG.md` に新バージョンの節
- `packages/x402-mcp/package.json` の `version` と、`packages/x402-mcp/package-lock.json`
  の `version`・`packages[""].version` を新バージョンへ
- B のときだけ `packages/x402-mcp/package.json` の
  `dependencies["openpay-x402-sdk"]` = `^<SDK 新バージョン>`
- `packages/x402-mcp/CHANGELOG.md` に新バージョンの節
- ルート `package-lock.json` の `packages/x402-sdk` エントリが新バージョン
  (ルートは `file:packages/x402-sdk` 参照。version 欄だけの変更)
- `packages/x402-mcp/package-lock.json` の `node_modules/openpay-x402-sdk` は
  **手編集しない** (整合しない `integrity` を書くと install が壊れる)

B では、この状態の entrypoint フェンスは MCP の依存表記と lockfile の SDK version が
食い違うので**意図どおり失敗する**。B の手順 2 で解消する。

---

## A の手順 (MCP の SDK 範囲を変えない)

PR を CI green で squash merge してから (merge は user の指示を待つ)、main で:

```bash
git checkout main && git pull
npm ci                    # SDK の node:test は root の node_modules (viem 等) を使う
cd packages/x402-sdk
npm publish --dry-run     # prepublishOnly で SDK の node:test が走る・files / version を目視
npm publish --access public
cd ../x402-mcp
npm publish --dry-run
npm publish --access public
```

その後「公開後の確認とドキュメント追従」を行う。

---

## B の手順 (MCP が新しい SDK を必要とする)

### 1. SDK を publish (作業ブランチ上)

```bash
cd packages/x402-sdk
npm publish --dry-run     # prepublishOnly で SDK の node:test が走る・files / version / 同梱物を目視
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

---

## 公開後の確認とドキュメント追従 (A・B 共通)

```bash
npm view openpay-x402-sdk version
npm view openpay-x402-mcp version
npm view openpay-x402-mcp dependencies
```

バージョンを明記している箇所を grep して更新する:

```bash
grep -rn "openpay-x402-mcp" --exclude-dir=node_modules --exclude-dir=.git . | grep -E "@0\.[0-9]+|0\.[0-9]+\.[0-9]+"
grep -rn "openpay-x402-sdk" --exclude-dir=node_modules --exclude-dir=.git . | grep -E "@0\.[0-9]+|0\.[0-9]+\.[0-9]+"
```

対象は README / `docs/` / `public/` / `components/` / `lib/` 等。
MCP は **minor 単位の pin** (`openpay-x402-mcp@0.19`) を `public/agent/setup.md`・
`components/x402/DiscoveryExamples.tsx`・`docs/agent-templates/`・
`packages/x402-mcp/README.md` が引用し、`tests/lib/agentSetupMd.test.ts` が検査する。
patch リリースではそのまま真なので変えない。minor を上げたときだけ更新する
(公開文言なので確定は user の承認を待つ)。README の「`openpay-x402-mcp` パッケージ
(≥ 0.9.0)」や SDK の「0.10.0 以降」は下限を示す表現で、新版でも真のまま。
llms.txt を書き換える場合は掟 14 の開示 3 点セットに従う。

---

## 逸脱時の注意

- `packages/x402-mcp/package-lock.json` の SDK エントリ (`node_modules/openpay-x402-sdk`
  の `version`/`resolved`/`integrity`) を**手編集しない**。`integrity` は publish 済み
  tarball のハッシュで、手で正しい値は作れない (手で変えてよいのは MCP 自身の `version` 2 か所だけ)。
- B で SDK だけ publish して MCP の追従 commit を忘れると、main は
  entrypoint フェンスで赤いままになる。B の手順 2 まで一続きで行う。
- A で MCP の publish を忘れても main は赤くならないが、npm の MCP は旧版のまま残る。
  `npm view openpay-x402-mcp version` で確かめる。
- publish を取り消したくなっても `npm unpublish` は 72 時間制限や
  再利用不可バージョンの制約がある。`--dry-run` を必ず先に通す。
