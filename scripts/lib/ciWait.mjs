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
// ドリフトを検出する: analyzeWorkflows() が .github/workflows を解析し、PR で必ず走る job 名の集合が JSON と
// 一致すること・解析できない形が現れたら unsupported として test を落とすこと (fail-closed・黙って除外しない)。
//
// CLI は JSON を「対象 PR の HEAD にあるファイル」から読み、parseExpectedChecksJson() で形を検証する
// (必須 job と JSON を同時に足した PR を main 側のスクリプトで監視しても、PR 側の集合で判定するため)。
// 正本が JS の定数だった頃は PR 側の JS ソースを字句解析して読んでいて、テンプレート文字列内の見本や別名の
// export を定数と取り違える穴が残った。データを JSON に分け、JSON.parse + 形の検証だけで読むことで、その種の
// 取り違えを構造的に無くす。このモジュールの EXPECTED_PR_CHECKS もローカルの同じ JSON から作る。
//
// 期待集合を適用するのは PR の base が main のときだけ。積み上げ PR (base が main 以外) では
// 届かない check を待ち続けないよう、従来の判定 (出てきた check が全部 SUCCESS/NEUTRAL/SKIPPED) に戻す。

import { readdirSync, readFileSync } from 'node:fs';
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
// workflow 解析 (ドリフト検出用・実行時には使わない)
//
// 脅威モデル: 守る対象は、保守者が PR で走る workflow / job をうっかり足し (または外し)、期待集合
// (scripts/ci-expected-checks.json) の更新を忘れること。忘れたまま merge すると ci-wait は足された check を
// 待たずに exit 0 する (偽成功)。そのため、対応文法 (下記) だけで書かれていると確かめてから「必須 / 除外」を
// 判定し、対応文法の外は必ず unsupported にして test を落とす (fail-closed・黙って除外しない)。リポ内で意図的に
// 検査を欺く難読化はレビューで止める範囲で、この parser の目的外 (YAML を完全に解釈することは目指さない)。
//
// 本格的な YAML parser は依存に無い (掟 16 で足さない) ので、GitHub Actions workflow の定型だけを読む行指向の
// parser。検査は「文書構造 → トップレベル → on: / jobs:」の順で、文書構造かトップレベルに unsupported があれば
// on: / jobs: は読まない (形の分からない文書から「pull_request が無い」とは言わない)。
//   - 文書: 単一ドキュメントだけ。許すのは先頭の BOM と、最初の非空行の `---` 1 つ。2 つ目の `---`・`...`・
//     スペース以外の indent (タブ等)・BOM 以外の制御文字 (単独の CR・YAML が改行とみなす U+0085 / U+2028 /
//     U+2029 を含む) は文書単位で unsupported。
//   - トップレベル: plain の `key:` だけ。quote 付きの key は `"on":` (YAML 1.1 で on が真偽値になる回避の定型)
//     だけを例外にし、それ以外 (`"jobs":` 等)・アンカー/タグ/`? `/`<<:` 等の key でない行・重複 key は unsupported。
//   - on: イベント名 1 つ / flow 配列 / block 配列 / flow map / block map のどの形から来ても、各 entry を同じ
//     eventProblem() に通す (イベント名は EVENT_NAME_RE・値は空か対応する map だけ・アンカー/エイリアス/タグは
//     unsupported)。`on: []` / `{}` / `null` は今の workflow に無い形なので unsupported。
//   - jobs: block map だけ (indent は最初の子から検出)。check 名が静的に決まらない job は unsupported。
// 子の行は indent で親に囲われるので、YAML が見る key はこの parser が見る行の key の部分集合になる (quote 付きの
// key・アンカー/エイリアス・`<<:`・`? `・複数行の flow を拒否している前提で。複数行の scalar が行を飲み込むことは
// あっても key を作り出すことはない)。
// ---------------------------------------------------------------------------

const PR_FILTER_KEYS = new Set(['paths', 'paths-ignore', 'types']);
const PR_BRANCH_KEYS = new Set(['branches', 'branches-ignore']);
const GLOB_RE = /[*?[\]!+]/;

// 対応する scalar = quote / アンカー / エイリアス / タグ / flow 記号を含まない 1 語 (branch・path・job id・flow map の値)。
// これ以外 (`"main"`・`&x`・`*x`・`!!str x`・`{…}`・`[…]`・空白を含む) は読めない形として null / unsupported にする。
const PLAIN_SCALAR_RE = /^[A-Za-z0-9_][\w./*?-]*$/;
const EVENT_NAME_RE = /^[a-z][a-z_]*$/;

/** 行コメントと (quote の外の) 末尾コメントを落とす。 */
function stripComment(line) {
  if (/^\s*#/.test(line)) return '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function unquote(value) {
  const v = value.trim();
  const m = v.match(/^(['"])(.*)\1$/);
  return m ? m[2] : v;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * `key: value` の行を分解する。key の後に `:` が無ければ null。quote は key を囲む quote (plain なら null)。
 * quote 付きの key を受け付けるのはトップレベルの `"on":` だけで、それ以外は呼び出し側が unsupported にする。
 */
function splitKey(line) {
  const m = line.trim().match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*)):(?:\s+(.*))?$/);
  if (!m) return null;
  const quote = m[1] !== undefined ? '"' : m[2] !== undefined ? "'" : null;
  return { key: m[1] ?? m[2] ?? m[3], value: (m[4] ?? '').trim(), quote };
}

/** flow 形式の `[a, b]` / `{a: 1, b: {c: d}}` を、ネストを尊重して要素ごとに分ける。 */
function splitFlow(inner) {
  const parts = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** `[a, b]` → ['a', 'b'] (要素は生の文字列のまま・検査は呼び出し側)。flow 配列でなければ null。 */
function flowItems(value) {
  const v = value.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) return null;
  return splitFlow(v.slice(1, -1));
}

/** plain scalar だけの flow 配列 (branches / paths 等) → 要素。それ以外 (quote 付きの要素等) は null。 */
function flowList(value) {
  const items = flowItems(value);
  if (!items || items.some((item) => !PLAIN_SCALAR_RE.test(item))) return null;
  return items;
}

/**
 * `{a: x, b: {..}}` → [{ key, value, sub: [] }]。flow map でなければ null、
 * 読めない (quote 付きの key・`{a, b}` のような key だけの要素・重複 key) なら undefined。
 */
function flowMap(value) {
  const v = value.trim();
  if (!v.startsWith('{') || !v.endsWith('}')) return null;
  const inner = v.slice(1, -1).trim();
  if (!inner) return [];
  const entries = [];
  for (const part of splitFlow(inner)) {
    const entry = splitKey(part);
    if (!entry || entry.quote || entries.some((e) => e.key === entry.key)) return undefined;
    entries.push({ key: entry.key, value: entry.value, sub: [] });
  }
  return entries;
}

/** value が「空の map」(null / {} / 空) か。 */
function isEmptyValue(value) {
  const v = value.trim();
  return v === '' || v === '{}' || v === 'null' || v === '~';
}

/** flow map の値として対応する形か (空・plain scalar・plain scalar の flow 配列・同じ条件の flow map)。 */
function supportedFlowValue(value) {
  if (isEmptyValue(value) || PLAIN_SCALAR_RE.test(value) || flowList(value)) return true;
  const map = flowMap(value);
  return Array.isArray(map) && map.every((e) => supportedFlowValue(e.value));
}

/** 空行を除いた最初の行の indent (= その block の子の indent)。非空行が無ければ -1。 */
function childIndent(lines) {
  for (const line of lines) if (line.trim() !== '') return indentOf(line);
  return -1;
}

/** `- item` 行を集める (要素は生の文字列)。indent が揃わない・`- ` で始まらない行があれば null。 */
function blockItems(lines) {
  const items = lines.filter((l) => l.trim() !== '');
  if (items.length === 0) return null;
  const indent = indentOf(items[0]);
  const out = [];
  for (const line of items) {
    if (indentOf(line) !== indent || !line.trim().startsWith('- ')) return null;
    out.push(line.trim().slice(2).trim());
  }
  return out;
}

/** plain scalar だけの block 配列 (branches / paths 等) → 要素。それ以外 (quote 付きの要素等) は null。 */
function blockList(lines) {
  const items = blockItems(lines);
  if (!items || items.some((item) => !PLAIN_SCALAR_RE.test(item))) return null;
  return items;
}

// 読めなかった entry の子の行は、理由を積んだうえで読み飛ばす (同じ原因の行を何度も報告しない)
const SKIP = Symbol('skip');

/**
 * block の行を「子 (最初の非空行の indent) の `key: value` 行 + その下に続く行 (sub)」に分ける。
 * indent は 2 でも 4 でも最初の子から検出する。子より浅い行・子と同じ深さで key でない行・quote 付きの key・
 * 重複 key・親の無い深い行は errors に積む (fail-closed・黙って読み飛ばさない)。
 */
function mapEntries(lines, label) {
  const entries = [];
  const errors = [];
  const indent = childIndent(lines);
  if (indent === -1) {
    errors.push(`${label}: empty`);
    return { entries, errors };
  }
  let current = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const depth = indentOf(line);
    if (depth < indent) {
      errors.push(`${label}: inconsistent indent (${line.trim()})`);
      current = SKIP;
      continue;
    }
    if (depth === indent) {
      const entry = splitKey(line);
      // quote 付きの key (`"pull_request":` 等) は YAML としては plain と同じ key だが、デコードせず読めない形として扱う
      const reason = !entry ? 'unreadable line' : entry.quote ? 'quoted key' : entries.some((e) => e.key === entry.key) ? 'duplicate key' : null;
      if (reason) {
        errors.push(`${label}: ${reason} (${line.trim()})`);
        current = SKIP;
        continue;
      }
      current = { key: entry.key, value: entry.value, sub: [] };
      entries.push(current);
      continue;
    }
    if (current === SKIP) continue;
    if (!current) {
      errors.push(`${label}: inconsistent indent (${line.trim()})`);
      current = SKIP;
      continue;
    }
    current.sub.push(line);
  }
  return { entries, errors };
}

/** BOM 以外の制御文字か (C0 の \t 以外・DEL・C1・YAML が改行とみなす U+2028 / U+2029・途中の BOM・単独の CR)。 */
function isControlChar(ch) {
  const c = ch.codePointAt(0);
  return (c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff;
}

/**
 * 文書構造とトップレベルを検査し、トップレベルの key ごとの block ({ head, body }) を返す。
 * 問題があれば unsupported に積む (呼び出し側はそのとき on: / jobs: を読まない)。
 */
function readDocument(source) {
  const unsupported = [];
  const text = source.startsWith('﻿') ? source.slice(1) : source;
  // CRLF の CR だけを落とし、残った CR (単独の CR = YAML では改行) は制御文字として拒否する
  const rawLines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const controlLine = rawLines.findIndex((line) => [...line].some(isControlChar));
  if (controlLine !== -1) {
    const ch = [...rawLines[controlLine]].find(isControlChar);
    const code = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    unsupported.push(`document: control character (U+${code} at line ${controlLine + 1})`);
  }
  // indent はスペースだけ (タブ・NBSP 等が混ざると YAML と indent の数え方がずれる)
  const tabLine = rawLines.findIndex((line) => /^ *[^\S ]/.test(line));
  if (tabLine !== -1) unsupported.push(`document: non-space indentation (line ${tabLine + 1})`);
  const lines = rawLines.map(stripComment);
  const first = lines.findIndex((line) => line.trim() !== '');
  for (const [i, line] of lines.entries()) {
    if (!/^(?:---|\.\.\.)(?:\s|$)/.test(line)) continue;
    if (i === first && line.trimEnd() === '---') lines[i] = '';
    else unsupported.push(`document: document marker (line ${i + 1}: ${line.trim()})`);
  }
  const blocks = new Map();
  if (unsupported.length > 0) return { blocks, unsupported };

  let current = null;
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    if (indentOf(line) > 0) {
      if (current === null) {
        unsupported.push(`top-level: indented line before the first key (line ${i + 1})`);
        current = SKIP;
      } else if (current !== SKIP) {
        current.body.push(line);
      }
      continue;
    }
    const head = splitKey(line);
    const reason = !head
      ? 'unreadable line'
      : head.quote && !(head.quote === '"' && head.key === 'on')
        ? 'quoted key'
        : blocks.has(head.key)
          ? 'duplicate key'
          : null;
    if (reason) {
      unsupported.push(`top-level: ${reason} (${line.trim()})`);
      current = SKIP;
      continue;
    }
    current = { head, body: [] };
    blocks.set(head.key, current);
  }
  return { blocks, unsupported };
}

/** pull_request の設定 (flow map の entries か、block の entries) から filtered / branches を読む。 */
function readPullRequestConfig(entries, unsupported) {
  const cfg = { filtered: null, branches: null, branchesIgnore: null };
  for (const { key, value, sub } of entries) {
    if (!PR_FILTER_KEYS.has(key) && !PR_BRANCH_KEYS.has(key)) {
      unsupported.push(`on.pull_request.${key}: unsupported key`);
      continue;
    }
    // 値は plain scalar の flow 配列 (同じ行) か block 配列 (次行以降・同じ行は空) だけを読む
    // (quote 付き・アンカー等・空の配列は読めない形 = unsupported)
    const list = sub.length === 0 ? flowList(value) : value === '' ? blockList(sub) : null;
    if (list === null || list.length === 0) {
      unsupported.push(`on.pull_request.${key}: unreadable list`);
      continue;
    }
    if (PR_FILTER_KEYS.has(key)) {
      cfg.filtered = cfg.filtered ?? key;
      continue;
    }
    if (list.some((b) => GLOB_RE.test(b))) {
      unsupported.push(`on.pull_request.${key}: glob pattern (${list.join(', ')})`);
      continue;
    }
    if (key === 'branches') cfg.branches = list;
    else cfg.branchesIgnore = list;
  }
  return cfg;
}

/** on: の値を形によらず [{ name, value, sub }] に揃える。形自体が読めなければ unsupported に積んで null。 */
function eventEntries({ head, body }, unsupported) {
  const { value } = head;
  if (value !== '' && body.length > 0) {
    unsupported.push(`on: value with nested lines (${value})`);
    return null;
  }
  if (value === '') {
    if (body.length === 0) {
      unsupported.push('on: empty');
      return null;
    }
    // block 配列 (`- event`)。要素の検査は eventProblem が他の形と同じく行う
    if (body.every((l) => l.trim().startsWith('-'))) {
      const items = blockItems(body);
      if (!items) {
        unsupported.push('on: unreadable list');
        return null;
      }
      return items.map((name) => ({ name, value: '', sub: [] }));
    }
    // block map (`event:` + 同じ行の値 + 次行以降の子)
    const { entries, errors } = mapEntries(body, 'on');
    for (const reason of errors) unsupported.push(reason);
    return entries.map(({ key, value: v, sub }) => ({ name: key, value: v, sub }));
  }
  let events;
  if (value.startsWith('[')) {
    const items = flowItems(value);
    events = items && items.map((name) => ({ name, value: '', sub: [] }));
  } else if (value.startsWith('{')) {
    const map = flowMap(value);
    events = map && map.map(({ key, value: v }) => ({ name: key, value: v, sub: [] }));
  } else {
    // イベント名 1 つ。`null` / `~` は空 (イベント無し) なので名前として読まない
    events = isEmptyValue(value) ? [] : [{ name: value, value: '', sub: [] }];
  }
  if (!events) {
    unsupported.push(`on: unreadable flow value (${value})`);
    return null;
  }
  if (events.length === 0) {
    unsupported.push(`on: empty value (${value})`);
    return null;
  }
  return events;
}

/**
 * on: の 1 entry を検査する。block map / flow map / flow 配列 / block 配列 / イベント名 1 つのどの形から来ても
 * 同じこの関数を通す (形ごとに検査が違うと、片方だけ素通りする穴になる)。問題があれば理由を返す。
 * 値は「空」か「対応する map」だけ: 同じ行の値は空 / null / {} / 対応する flow map、次行以降の子 (block) は
 * 同じ行の値が空のときだけ。非 PR イベントの block の子 (schedule の cron 配列・workflow_dispatch の inputs 等) は
 * indent で囲われていて on: の entry を増やせないので中身を見ない。pull_request の子は readPullRequestConfig が読む。
 * @param {{ name: string, value: string, sub: string[] }} event
 */
function eventProblem({ name, value, sub }) {
  if (!EVENT_NAME_RE.test(name)) return `on: unknown event (${name})`;
  const ok = sub.length > 0 ? value === '' : isEmptyValue(value) || (value.startsWith('{') && supportedFlowValue(value));
  return ok ? null : `on.${name}: unreadable value (${value})`;
}

/** `on:` を読み、PR trigger の有無と pull_request の設定を返す。 */
function readTriggers(block, unsupported) {
  const result = { pullRequest: false, config: null };
  if (!block) {
    unsupported.push('on: missing');
    return result;
  }
  const events = eventEntries(block, unsupported);
  if (!events) return result;
  // 「pull_request が無いので除外」と言えるのは、on: の全 entry が対応文法のときだけ (呼び出し側が unsupported を見る)
  for (const event of events) {
    const problem = eventProblem(event);
    if (problem) unsupported.push(problem);
  }
  const pr = events.find((e) => e.name === 'pull_request');
  if (!pr) return result;
  result.pullRequest = true;
  if (eventProblem(pr)) return result;
  if (pr.sub.length > 0) {
    const sub = mapEntries(pr.sub, 'on.pull_request');
    for (const reason of sub.errors) unsupported.push(reason);
    result.config = readPullRequestConfig(sub.entries, unsupported);
  } else {
    // eventProblem を通った同じ行の値は空か flow map
    result.config = readPullRequestConfig(isEmptyValue(pr.value) ? [] : flowMap(pr.value), unsupported);
  }
  return result;
}

/**
 * job の `name:` の値を check 名として採用できない理由を返す (採用できれば null)。
 * 対応するのは 1 行の plain scalar と、同じ行で閉じる (エスケープを含まない) quote 付き scalar だけ。
 */
function nameProblem(raw, sub) {
  if (!raw || /^[|>]/.test(raw)) return 'block scalar or empty name';
  if (raw.includes('${{')) return 'expression in name';
  if (sub.length > 0) return 'multi-line name'; // 次行に続く plain / quoted scalar (`"added` + `check"` 等)
  if (/^[&*!]/.test(raw)) return 'anchor, alias or tag in name'; // `&check_name test` / `*check_name` / `!!str x`
  if (/^[[{]/.test(raw)) return 'flow value in name';
  const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : null;
  if (quote) {
    if (raw.length < 2 || raw[raw.length - 1] !== quote) return 'multi-line name'; // 同じ行で閉じない quote
    if (quote === '"' && raw.includes('\\')) return 'escape in name';
    if (raw.slice(1, -1).includes(quote)) return 'quote inside name'; // `'it''s'` の二重化等
  }
  return null;
}

/** `jobs:` を読み、job ごとに name / 条件 / needs を返す。読めない形は unsupported に積む。 */
function readJobs(block, unsupported) {
  const jobs = [];
  if (!block) {
    unsupported.push('jobs: missing');
    return jobs;
  }
  // `jobs: {a: {...}}` (flow 形式) は job 名を読めないので unsupported (黙って jobs=[] にしない)
  if (block.head.value) {
    unsupported.push(`jobs: inline value (${block.head.value})`);
    return jobs;
  }
  // job の indent は jobs: 直下の最初の子から検出する (2 でも 4 でも可)。子が読めない・indent が揃わない行は unsupported
  const { entries, errors } = mapEntries(block.body, 'jobs');
  for (const reason of errors) unsupported.push(reason);
  for (const entry of entries) {
    const job = { id: entry.key, name: entry.key, conditional: null, needs: [] };
    jobs.push(job);
    // `test: {name: x, runs-on: y}` (flow 形式の job) は name: 等を読めないので unsupported
    if (entry.value) {
      job.conditional = 'inline value';
      continue;
    }
    if (entry.sub.length === 0) {
      job.conditional = 'empty definition';
      continue;
    }
    const keys = mapEntries(entry.sub, `jobs.${job.id}`);
    for (const reason of keys.errors) unsupported.push(reason);
    for (const field of keys.entries) {
      const label = `jobs.${job.id}.${field.key}`;
      switch (field.key) {
        case 'name': {
          // check 名が静的に決まらない job は、名前を推測せず「解析できない」として扱う。
          // 未対応の YAML (複数行スカラー・アンカー/エイリアス/タグ・quote 内のエスケープ・flow 値) も
          // 文字列として誤採用せず明示的に拒否する。
          const raw = field.value;
          const problem = nameProblem(raw, field.sub);
          if (problem) job.conditional = job.conditional ?? problem;
          else job.name = unquote(raw);
          break;
        }
        case 'if':
          job.conditional = job.conditional ?? 'if:';
          break;
        case 'strategy':
          job.conditional = job.conditional ?? 'strategy:';
          break;
        case 'uses':
          job.conditional = job.conditional ?? 'uses:';
          break;
        case 'needs': {
          let list = flowList(field.value);
          if (list === null && field.value && /^[\w-]+$/.test(unquote(field.value))) list = [unquote(field.value)];
          if (list === null && isEmptyValue(field.value) && field.sub.length > 0) list = blockList(field.sub);
          if (list === null) unsupported.push(`${label}: unreadable list`);
          else job.needs = list;
          break;
        }
        default:
          break;
      }
    }
  }
  return jobs;
}

/**
 * workflow YAML を読む。文書構造かトップレベルに unsupported があれば on: / jobs: は読まない
 * (pullRequest=false・jobs=[] だが、呼び出し側は unsupported を見て除外せず落とす)。
 * @param {string} source
 * @returns {{ pullRequest: boolean, filtered: string | null, branches: string[] | null, branchesIgnore: string[] | null,
 *   jobs: { id: string, name: string, conditional: string | null, needs: string[] }[], unsupported: string[] }}
 */
export function parseWorkflow(source) {
  const { blocks, unsupported } = readDocument(source);
  if (unsupported.length > 0) {
    return { pullRequest: false, filtered: null, branches: null, branchesIgnore: null, jobs: [], unsupported };
  }
  const triggers = readTriggers(blocks.get('on'), unsupported);
  const jobs = readJobs(blocks.get('jobs'), unsupported);
  return {
    pullRequest: triggers.pullRequest,
    filtered: triggers.config?.filtered ?? null,
    branches: triggers.config?.branches ?? null,
    branchesIgnore: triggers.config?.branchesIgnore ?? null,
    jobs,
    unsupported,
  };
}

/**
 * workflows ディレクトリを解析し、main 向け PR で必ず走る check 名 (required) を返す。
 * excluded = 走らないと分かる workflow (理由付き)。unsupported = 解析できない形 (fail-closed で test を落とす)。
 * @param {string} workflowsDir
 */
export function analyzeWorkflows(workflowsDir) {
  const required = [];
  const excluded = [];
  const unsupported = [];
  const owners = new Map();
  const files = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  for (const file of files) {
    const wf = parseWorkflow(readFileSync(join(workflowsDir, file), 'utf8'));
    // 文書構造・トップレベル・on: の問題 (= jobs 以外) は PR で走るか分からないので常に unsupported (job も数えない)。
    // jobs の問題は PR で走る workflow のときだけ数える (cron の workflow は matrix / if を自由に使える)
    const blocking = wf.unsupported.filter((r) => !r.startsWith('jobs'));
    if (blocking.length > 0) {
      for (const reason of blocking) unsupported.push({ workflow: file, reason });
      continue;
    }
    if (!wf.pullRequest) {
      excluded.push({ workflow: file, reason: 'no pull_request trigger' });
      continue;
    }
    if (wf.filtered) {
      excluded.push({ workflow: file, reason: `pull_request filtered by ${wf.filtered}` });
      continue;
    }
    if (wf.branches && !wf.branches.includes(MAIN_BRANCH)) {
      excluded.push({ workflow: file, reason: `pull_request branches exclude ${MAIN_BRANCH}` });
      continue;
    }
    if (wf.branchesIgnore?.includes(MAIN_BRANCH)) {
      excluded.push({ workflow: file, reason: `pull_request branches-ignore has ${MAIN_BRANCH}` });
      continue;
    }
    for (const reason of wf.unsupported) unsupported.push({ workflow: file, reason });
    const byId = new Map(wf.jobs.map((j) => [j.id, j]));
    for (const job of wf.jobs) {
      if (job.conditional) {
        unsupported.push({ workflow: file, job: job.id, reason: `job has ${job.conditional}` });
        continue;
      }
      const badNeed = job.needs.find((n) => !byId.has(n) || byId.get(n).conditional);
      if (badNeed) {
        unsupported.push({ workflow: file, job: job.id, reason: `needs ${badNeed} (unknown or conditional)` });
        continue;
      }
      if (owners.has(job.name)) {
        unsupported.push({ workflow: file, job: job.id, reason: `duplicate check name ${job.name} (also ${owners.get(job.name)})` });
        continue;
      }
      owners.set(job.name, file);
      required.push(job.name);
    }
  }
  return { required, excluded, unsupported };
}

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
