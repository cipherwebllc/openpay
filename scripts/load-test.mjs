#!/usr/bin/env node
// OpenPay 負荷テスト (ゼロ依存、Node 18+ の global fetch を使用)。
//
// 想定負荷下のレイテンシ / スループット / エラー率を実測する。外部 dep を足さず
// 本番/preview/ローカル build の任意 URL に対して実行できる成果物。DEPLOY_CHECKLIST
// §11 の「負荷測定」ゲートをこのスクリプトで満たす。
//
// 使い方:
//   node scripts/load-test.mjs --url https://open-pay.jp --concurrency 50 --duration 30
//   npm run load-test -- --url http://localhost:3000 -c 20 -d 15
//
// 計測対象 (重み付き mix で実トラフィックを模す):
//   - LP (/ja)                         : SSR + static、最も多い入口
//   - market rates (/api/market/rates) : 動的 API (CoinGecko + 5分キャッシュ)。
//                                        キャッシュ層と外部依存の負荷耐性を見る
//   - payment page (/ja/pay?...)       : SSR + URL parse、決済導線
//   - x402 discovery (/api/discovery)  : facilitator 公開カタログ (KV ファンアウト + edge キャッシュ)。
//                                        flag ON の preview でのみ実カタログを返す (OFF は 404)
//
// 終了コード: エラー率 > --max-error-rate (既定 1%) or p99 > --max-p99-ms
//   (既定 制限なし) で 1 を返し CI/gate で fail させられる。

const DEFAULTS = {
  url: 'http://localhost:3000',
  concurrency: 20,
  duration: 15, // seconds
  maxErrorRate: 0.01, // 1%
  maxP99Ms: Infinity,
  payTo: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--url' || a === '-u') opts.url = next();
    else if (a === '--concurrency' || a === '-c') opts.concurrency = Number(next());
    else if (a === '--duration' || a === '-d') opts.duration = Number(next());
    else if (a === '--max-error-rate') opts.maxErrorRate = Number(next());
    else if (a === '--max-p99-ms') opts.maxP99Ms = Number(next());
    else if (a === '--pay-to') opts.payTo = next();
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node scripts/load-test.mjs --url <base> [-c concurrency] [-d duration_s] [--max-error-rate 0.01] [--max-p99-ms N]',
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer (got ${opts.concurrency})`);
  }
  if (!Number.isFinite(opts.duration) || opts.duration < 1) {
    throw new Error(`--duration must be a positive number of seconds (got ${opts.duration})`);
  }
  opts.url = opts.url.replace(/\/$/, '');
  return opts;
}

// 実トラフィック比を模した重み (合計は任意、相対比で抽選)。
function buildScenarios(opts) {
  return [
    { name: 'LP', weight: 5, path: '/ja' },
    { name: 'market-rates', weight: 3, path: '/api/market/rates' },
    {
      name: 'payment-page',
      weight: 2,
      path: `/ja/pay?to=${opts.payTo}&token=usdc&amount=10`,
    },
    // x402 公開カタログ (facilitator)。AI エージェントがポーリングする read-only API。
    // flag OFF の環境では 404 (= 計測上の応答)。flag ON の preview で実カタログ負荷 (KV ファンアウト +
    // edge キャッシュ) を測る。
    { name: 'x402-discovery', weight: 2, path: '/api/discovery' },
  ];
}

function pickScenario(scenarios, totalWeight) {
  let r = Math.random() * totalWeight;
  for (const s of scenarios) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return scenarios[scenarios.length - 1];
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor((p / 100) * sortedAsc.length),
  );
  return sortedAsc[idx];
}

async function worker(opts, scenarios, totalWeight, deadline, stats) {
  while (performance.now() < deadline) {
    const sc = pickScenario(scenarios, totalWeight);
    const start = performance.now();
    let ok = false;
    let status = 0;
    try {
      const res = await fetch(`${opts.url}${sc.path}`, {
        method: 'GET',
        headers: { 'accept-language': 'ja' },
        redirect: 'manual',
      });
      status = res.status;
      // body を読み切って TTLB (time-to-last-byte) を計測 (SSR の実コスト反映)
      await res.arrayBuffer();
      // 2xx / 3xx (locale redirect 等) を成功扱い。4xx/5xx はエラー。
      ok = res.status < 400;
    } catch {
      ok = false;
    }
    const elapsed = performance.now() - start;
    const agg = stats.get(sc.name);
    agg.count += 1;
    agg.latencies.push(elapsed);
    if (!ok) {
      agg.errors += 1;
      agg.statusCounts[status] = (agg.statusCounts[status] ?? 0) + 1;
    }
  }
}

function emptyAgg() {
  return { count: 0, errors: 0, latencies: [], statusCounts: {} };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scenarios = buildScenarios(opts);
  const totalWeight = scenarios.reduce((s, x) => s + x.weight, 0);

  // 事前 reachability チェック (誤った URL で 0 件計測の無駄を防ぐ)。
  try {
    const probe = await fetch(`${opts.url}/ja`, { redirect: 'manual' });
    console.log(`probe ${opts.url}/ja → ${probe.status}`);
  } catch (e) {
    console.error(`[load-test] target に到達できません: ${opts.url} (${e.message})`);
    process.exit(2);
  }

  const stats = new Map(scenarios.map((s) => [s.name, emptyAgg()]));
  console.log(
    `[load-test] url=${opts.url} concurrency=${opts.concurrency} duration=${opts.duration}s`,
  );

  const deadline = performance.now() + opts.duration * 1000;
  const wallStart = performance.now();
  await Promise.all(
    Array.from({ length: opts.concurrency }, () =>
      worker(opts, scenarios, totalWeight, deadline, stats),
    ),
  );
  const wallSec = (performance.now() - wallStart) / 1000;

  let totalCount = 0;
  let totalErrors = 0;
  let worstP99 = 0;

  console.log('\n--- per-scenario ---');
  for (const [name, agg] of stats) {
    totalCount += agg.count;
    totalErrors += agg.errors;
    const sorted = agg.latencies.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p90 = percentile(sorted, 90);
    const p99 = percentile(sorted, 99);
    worstP99 = Math.max(worstP99, p99);
    const errRate = agg.count > 0 ? agg.errors / agg.count : 0;
    console.log(
      `${name.padEnd(14)} n=${String(agg.count).padStart(6)} ` +
        `rps=${(agg.count / wallSec).toFixed(1).padStart(7)} ` +
        `p50=${p50.toFixed(0).padStart(5)}ms p90=${p90.toFixed(0).padStart(5)}ms ` +
        `p99=${p99.toFixed(0).padStart(6)}ms err=${(errRate * 100).toFixed(2)}%` +
        (agg.errors > 0 ? ` statuses=${JSON.stringify(agg.statusCounts)}` : ''),
    );
  }

  const overallErrRate = totalCount > 0 ? totalErrors / totalCount : 1;
  const overallRps = totalCount / wallSec;
  console.log('\n--- overall ---');
  console.log(
    `requests=${totalCount} errors=${totalErrors} ` +
      `error_rate=${(overallErrRate * 100).toFixed(2)}% rps=${overallRps.toFixed(1)} ` +
      `worst_p99=${worstP99.toFixed(0)}ms wall=${wallSec.toFixed(1)}s`,
  );

  // gate 判定
  const failures = [];
  if (overallErrRate > opts.maxErrorRate) {
    failures.push(
      `error_rate ${(overallErrRate * 100).toFixed(2)}% > 上限 ${(opts.maxErrorRate * 100).toFixed(2)}%`,
    );
  }
  if (worstP99 > opts.maxP99Ms) {
    failures.push(`worst_p99 ${worstP99.toFixed(0)}ms > 上限 ${opts.maxP99Ms}ms`);
  }
  if (totalCount === 0) {
    failures.push('リクエストが 1 件も成立しなかった (target/設定を確認)');
  }

  if (failures.length > 0) {
    console.error(`\n[load-test] FAIL:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\n[load-test] OK (gate 内)');
}

main().catch((e) => {
  console.error(`[load-test] error: ${e.stack ?? e}`);
  process.exit(2);
});
