# CLAUDE.md — OpenPay リポの掟

AI エージェント（Claude/Codex/その他）と人間の両方が守る、このリポ固有の不変ルール。
すべて**実際に起きた事故**に由来する（根拠は各行末）。変更はチーム合意で。

## コマンド

```bash
npm run typecheck        # tsc --noEmit
npx vitest run           # unit/integration 全 suite (~35s)。summary は末尾 5 行を読む
                         #   ⚠️ 出力を grep すると test 内の意図的エラーログ (SA init noise 等) に誤マッチする
npm run e2e:local        # Playwright (ローカル環境依存 → 下記「e2e は CI が権威」参照)
npm run build            # next build (page export 検査を含む・下記参照)
node scripts/audit-gate.mjs   # CI と同一の npm audit 判定
node scripts/lockfile-gate.mjs # CI と同一の依存取得元判定 (公式 npm レジストリのみ)
node scripts/dev-shot.mjs     # dev/prod サーバの実機スクショ (mobile/desktop・print 対応)
node scripts/ci-wait.mjs <PR> # PR の CI settle 待ち+conclusion 判定 (--once/--timeout 分)
```

## 不変ルール（違反すると壊れる順）

1. **Prettier 厳禁**。このリポに Prettier は無い（設定・deps・package.json key すべて）。`npx prettier` を実行すると全行ダブルクオート化の巨大 diff になる。整形は ESLint（シングルクオート・2 スペース）: `npx eslint --fix` か手書き。
2. **e2e はローカル結果を信用しない — CI が権威**。ローカル `.env.local`（recover ON・実キー）と CI（最小 env・flag OFF）で手数料表示等の描画が別物。ローカル基準で e2e を書き換えて main を赤くした実績あり。CI green を merge 条件にする。既知 flaky: `create.spec` の ChevronDown CSS transform・`tip.spec`・`chain-chooser`（mobile-safari）→ diff 無関係を確認して `gh run rerun <id> --failed`。
3. **`app/**/page.tsx` は規定外の value export 禁止**（default / generateMetadata / generateStaticParams / metadata 等のみ）。違反は typecheck/vitest を**通過**し `next build` でのみ落ちる（#109 で Vercel deploy 失敗）。素材/部品は components/ へ。`tests/lib/pageExports.test.ts` が CI で検査する。
4. **可視 UI 文字列を一括変更したら全域 grep**（`components/ lib/ app/ messages/ tests/ e2e/`）で旧文言の残存ゼロを確認。**grep の出力を head で切らない**（「JPYC 公式」統一時に tests → e2e → en spec と 3 回見落とし、CI で発覚）。
5. **i18n は messages/ja.json と en.json の完全 parity**（`tests/lib/i18nKeys.test.ts` が検証）。ただし**同名キー（signInRequired 等）が複数 namespace にある**ため、一次一致で挿入すると誤った namespace に入り、parity テストは偽陽性で pass する。挿入は必ず namespace を明示して確認。
6. **広く render される component / hook に依存を足したら full vitest 必須**。兄弟テストの vi.mock が新依存を欠いて落ちる（wagmi useAccount 追加で HistoryView 系 3 file が破壊）。jsdom には `tests/setup.ts` に matchMedia 既定 stub あり。
7. **SIWE を要する flag を新設したら `components/WalletBadge.tsx` の `siweEnabled` に追加**。忘れるとヘッダからサインインできず機能が不到達になる（CsvPassPaywall・PushNotifyPanel で計 3 回発生）。機能パネル側にも自前 sign-in ボタンを検討。
8. **可視テキストを含まない aria-label 単独付与は禁止**。Lighthouse の label-content-name-mismatch（WCAG 2.5.3）で CI が hard fail（#66 実害）。a11y 名は可視テキストから導出する。
9. **env を足したら `.env.local.example` と README の env テーブルを同時更新**（ドリフト厳禁・`tests/lib/envDocs.test.ts` が CI で検査する）。server 秘密（VAPID 秘密鍵等）は client 共有の `lib/env.ts` に入れず `import 'server-only'` モジュールに閉じる。
10. **commitlint: subject は 100 字以内**（詳細は body へ・body の行長制限なし）。
11. **開発サーバでの検証はポートを明示**（`next start -p XXXX`）し、**そのポートの URL で readiness を確認してから**テストする。port 3000 が占有済みだと next は無言で 3001 に逃げ、古いサーバを検証して誤診断する（push E2E で実害）。
12. **money-path（relay/settle/fee/order 検証）への変更は「追加のみ」を原則**とし、既存の制御フロー・応答・エラー処理を変えない。post-response 処理は `after()`（next/server）を使う（unawaited promise は serverless で凍結・応答内 await は latency 悪化）。
13. **防御的プログラミングの基準**（2026-07-04 user 確定）: **意味のない防御は禁止・障害を隣に波及させないための意図的な防御は必須**。禁止 = 起こり得ない状態への保険、エラー握りつぶしによる偽成功（cookie は出すがセッション保存失敗、等）、仕様を曖昧にする fallback。必須 = 付帯処理が本体を巻き込まない隔離 — 例: push/通知/メーターは no-throw で決済本体に波及させない・localStorage/ブラウザ API は既存パターンの try-catch・rate limit ストレージ障害で本体機能を止めない fail-open。防御を書くときは**「何の波及を断つための防御か」をコメントで示す**（示せないならその防御は不要の疑い）。
14. **手数料・チェーン対応・課金条件を変えたら「開示 3 点セット」を同期**（2026-07-07 user 確定）: ①LP（`messages/` の `Landing.benefitsFee*`/`supportFee*`/FAQ）②法務文書（`lib/legal.ts` の `DISCLOSED_*` 定数 + Terms/免責/特商法）③**`public/llms.txt`**。①②は `tests/app/legal.test.tsx` 等、③は `tests/lib/llmsTxtDisclosure.test.ts`（DISCLOSED_* と価格 SoT から期待文字列を導出）が CI で検出する。**③のフェンスは「料率・価格の言及行の型」に依存する**ので、llms.txt の文言の型を変えたらフェンスも同時に更新する（放置すると AI 検索・AI エージェントが古い料率を引用し続ける）。
15. **money-path / x402 wire / 秘密情報に触れる変更は「初期生成」と「正式採用」を分離**（2026-07-18 採用）: AI が実装しテストが green でも、merge 前に人間（user）の明示レビューを必須とし、決済状態の判定を LLM の出力に委ねる実装（"paid" 文字列や会話履歴を信じて解錠する等）を導入しない。決済状態の真実は facilitator の verify/settle とオンチェーンのみ。
16. **依存の追加は公式 npm レジストリのみ**（2026-07-20 採用）: git URL・独自レジストリ・http 取得を lockfile に入れない（`scripts/lockfile-gate.mjs` が CI で全 package-lock.json を検査）。install スクリプトを持つ新規パッケージ・既存名と紛らわしい類似名は導入前に個別確認し、AI エージェントには依存追加の前に追加予定一覧を出させる。

## 自律運転の型（全モデル共通・Fable/Opus/Sonnet/Codex）

**確認なしで進めてよい**（止まると逆に遅い）:

- ブランチ作成・commit・push・PR 作成・CI 監視・検証一式（typecheck/lint/vitest/build/実機スクショ）
- CI 失敗の真因調査と、意図が変わらない範囲の修正 → 再 push
- 既知 flaky（掟 2）の diff 無関係確認 → rerun
- scratchpad への一時ファイル・調査・grep・メモリ更新

**必ず user の明示承認を待つ**（一言でよい）:

- 公開文言の確定（LP・法務・README・llms.txt）— 案は出してよいが merge 前に承認
- merge の実行（「merge して」を待つ。CI green でも先走らない）
- flag 点灯・env 変更・deploy・npm publish・外部サービスへの申請/投稿
- money-path の仕様変更（掟 12 の範囲を超えるもの）

**作業の型**（モデルの記憶力に頼らない）:

- git/gh の状態確認は `コマンド > ファイル` → Read で読む。**自分の記憶や「成功したはず」を根拠にしない**（Fable ですら幻覚した実績あり・2026-07-06）
- CI 待ちは `node scripts/ci-wait.mjs <PR番号>`（settle まで待って conclusion 一覧を出す・全 SUCCESS で exit 0）→ 出力ファイルを Read → **HEAD 一致と nonSUCCESS=0 を確認してから** merge
- 迷ったら「最小の可逆な一歩」を選び、不可逆な一歩の前でだけ止まる

## PR / 検証の型

- ブランチ → conventional commit → push → `gh pr create` → CI 監視 → **conclusion を明示確認**（`gh pr checks` の `--watch` は旧 run で exit したり checks 登録前に終わることがある。登録を待ってから watch し、最後に一覧で pass を確認）→ squash merge → main 同期。
- コミット trailer: `Co-Authored-By` と `Claude-Session`（エージェント作業時）。
- UI 変更は実機スクショで検証（`scripts/dev-shot.mjs`）。印刷面（ポスター/kit）は `emulateMedia('print')` で A4 フィット（scrollHeight ≤ viewport）まで確認。
- **page ファイルを含む変更の検証には `npm run build` を含める**（掟 3 の検出はこれのみ）。

## エージェント委譲（Codex/Opus 等）に渡す規約前文

委譲プロンプトには「**このリポの CLAUDE.md（掟 1〜16）に従うこと。最後に typecheck / eslint(変更ファイル) / full vitest、page 変更時は next build を実行して結果を報告**」を含める。個別規約の再列挙は不要（本ファイルが単一情報源）。

## 参照

- 運用 runbook / go-live SOP: `docs/DEPLOY_CHECKLIST.md`（§15 Push・§15.7 オフライン QR・§14 x402）
- 実装計画の置き場: `plans/`（gitignore 対象・ローカル）
- Web Push の自動 E2E は不可（Playwright Chromium は FCM キー欠如・自動化 Chrome も push service 拒否）→ 実機 smoke（DEPLOY_CHECKLIST §15.6）
