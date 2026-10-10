// scripts/ci-wait.mjs の純関数部 (期待 check 集合と判定)。
//
// 動機 (第 7 回レビュー E8): 以前の ci-wait は「出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED なら
// exit 0」だった。push 直後に CI の job だけが check として登録され、e2e / lighthouse の workflow run
// がまだ現れていない瞬間に呼ぶと、そこだけで SETTLED / exit 0 になりうる。また必須 job が
// SKIPPED でも緑扱いだった。merge 判定は「必須 check が全部そろって SUCCESS」を肯定形で確認する
// (memory: feedback_merge_gate_ci_wait_only)。
//
// 期待集合の正本は scripts/ci-expected-checks.json (`{"checks": [...]}` だけ・main 向け PR で必ず走る check 名)。
// 実行時にローカルの workflow から導出すると、監視している PR の HEAD と結び付かない (job を足した PR を
// main から監視すると旧集合で exit 0) ので、ファイルにして tests/scripts/ci-wait.test.ts が workflow との
// ドリフトを検出する: scripts/lib/ciWaitWorkflows.mjs の analyzeWorkflows() が .github/workflows を `yaml` で解析し、
// PR で必ず走る job 名の集合が JSON と一致すること・解析できない形が現れたら unsupported として test を落とすこと
// (fail-closed・黙って除外しない)。workflow の解析をこのモジュールに置かないのは、CLI が YAML を読まない (= `yaml` に
// 依存しない) ため。
//
// CLI は JSON を「対象 PR の HEAD にあるファイル」から読み、parseExpectedChecksJson() で形を検証する
// (必須 job と JSON を同時に足した PR を main 側のスクリプトで監視しても、PR 側の集合で判定するため)。
// 正本が JS の定数だった頃は PR 側の JS ソースを字句解析して読んでいて、テンプレート文字列内の見本や別名の
// export を定数と取り違える穴が残った。データを JSON に分け、JSON.parse + 形の検証だけで読むことで、その種の
// 取り違えを構造的に無くす。このモジュールの EXPECTED_PR_CHECKS もローカルの同じ JSON から作る。
//
// 期待集合を適用するのは PR の base が main のときだけ。積み上げ PR (base が main 以外) では
// 届かない check を待ち続けないよう、従来の判定 (出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED) に戻す。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAIN_BRANCH = 'main';

// 期待集合の正本 (repo root からの path)。workflow の job を足す / 外す PR はこのファイルも更新する。
export const EXPECTED_CHECKS_PATH = 'scripts/ci-expected-checks.json';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 期待集合の JSON を読む。形は `{"checks": ["audit", ...]}` だけ (余計なキー無し・空でない配列・
 * 空でない文字列・重複無し)。重複キーは JSON.parse が黙って後勝ちにし、人が読む値と採用する値がずれるので、
 * 正規形 (JSON.stringify(…, null, 2) + 末尾改行) と一致することも求める。読めなければ理由を返す (部分採用しない)。
 * @param {string} text
 * @returns {{ checks: string[] } | { error: string }}
 */
export function parseExpectedChecksJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { error: `JSON として読めません (${err instanceof Error ? err.message : String(err)})` };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { error: 'トップレベルが object ではありません' };
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== 'checks') return { error: `キーは checks だけにすること (${keys.join(', ') || 'キー無し'})` };
  const { checks } = data;
  if (!Array.isArray(checks)) return { error: 'checks が配列ではありません' };
  if (checks.length === 0) return { error: 'checks が空です' };
  const badIndex = checks.findIndex((c) => typeof c !== 'string' || c.trim() === '');
  if (badIndex !== -1) return { error: `checks[${badIndex}] が空でない文字列ではありません (${JSON.stringify(checks[badIndex])})` };
  const duplicate = checks.find((c, i) => checks.indexOf(c) !== i);
  if (duplicate !== undefined) return { error: `checks に重複があります (${duplicate})` };
  if (text !== `${JSON.stringify(data, null, 2)}\n`) return { error: '正規形 (JSON.stringify(…, null, 2) + 末尾改行) ではありません' };
  return { checks: [...checks] };
}

/** ローカルの正本を読む。壊れていれば throw する (空集合や古い値で黙って続けない)。 */
function readLocalExpectedChecks() {
  const parsed = parseExpectedChecksJson(readFileSync(join(REPO_ROOT, EXPECTED_CHECKS_PATH), 'utf8'));
  if ('error' in parsed) throw new Error(`${EXPECTED_CHECKS_PATH}: ${parsed.error}`);
  return parsed.checks;
}

// main 向け PR で必ず走る check 名 (ローカルの正本から作る・別に書き写さない)。
export const EXPECTED_PR_CHECKS = Object.freeze(readLocalExpectedChecks());

export const PENDING_STATES = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'EXPECTED']);
// 期待集合に無い check (将来足された第三者 app 等)・base が main 以外のときの従来どおりの合格条件。
export const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
// vercel の deploy check は判定から除外する (merge 条件は repo CI のみ)。
const IGNORED_CHECK_RE = /vercel/i;

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/**
 * `gh pr view --json statusCheckRollup` の配列を name/status/conclusion に揃え、vercel を除外する。
 * CheckRun は name/status/conclusion、StatusContext は context/state を持つ。
 */
export function normalizeRollup(rollup) {
  return (rollup ?? [])
    .map((c) => ({
      name: c.name ?? c.context ?? '(unnamed)',
      status: c.status ?? c.state ?? '',
      conclusion: c.conclusion ?? c.state ?? '',
    }))
    .filter((c) => !IGNORED_CHECK_RE.test(c.name));
}

/** base branch から期待集合を決める。main 以外 (積み上げ PR) は空 = 従来の判定。 */
export function expectedChecksFor(baseRefName) {
  return baseRefName === MAIN_BRANCH ? [...EXPECTED_PR_CHECKS] : [];
}

/**
 * 判定。settled = pending 無し かつ 期待 check が全部そろっている。ok = settled かつ失敗無し。
 * 期待 check は SUCCESS のみ合格 (SKIPPED / NEUTRAL は必須 job が走っていないので失敗)。
 * 期待集合に無い check は従来どおり PASS_CONCLUSIONS で判定する。
 * @param {{ name: string, status: string, conclusion: string }[]} checks
 * @param {readonly string[]} expected
 */
export function evaluateChecks(checks, expected) {
  const expectedSet = new Set(expected);
  const present = new Set(checks.map((c) => c.name));
  const pending = checks.filter((c) => PENDING_STATES.has(c.status));
  const missing = expected.filter((name) => !present.has(name));
  const failed = checks.filter((c) =>
    expectedSet.has(c.name) ? c.conclusion !== 'SUCCESS' : !PASS_CONCLUSIONS.has(c.conclusion),
  );
  const settled = checks.length > 0 && pending.length === 0 && missing.length === 0;
  return { pending, missing, failed, settled, ok: settled && failed.length === 0 };
}
