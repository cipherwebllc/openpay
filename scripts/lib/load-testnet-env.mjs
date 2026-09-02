// testnet 実チェーン検証スクリプト用の env ロード。
//
// なぜ: これらのスクリプトは chain 80002 (Amoy) を叩くが、env は無条件に .env.local を
// 読んでいた。.env.local は本番 KV (KV_REST_API_*) を指していることがあり、testnet の
// 検証が本番の meter / idempotency キーに書き込む波及があった。
// .env.local.testnet があればそちらを優先し、どのファイルを読んだか・どの KV を指して
// いるかを実行前に必ず表示する (取り違えを実行者が気づける形にする)。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// KV ホストは全体を出すと共有ログで本番エンドポイントが漏れる。識別できる最初の
// ラベルだけ出す (取り違えの検知にはこれで十分)。
export function maskKvHost(rawUrl) {
  if (!rawUrl) return '(未設定)';
  try {
    const host = new URL(rawUrl).hostname;
    const [first, ...rest] = host.split('.');
    return rest.length > 0 ? `${first}.…` : first;
  } catch {
    return '(不正な URL)';
  }
}

export function loadTestnetEnv(repoRoot) {
  const testnetFile = join(repoRoot, '.env.local.testnet');
  const file = existsSync(testnetFile) ? testnetFile : join(repoRoot, '.env.local');
  process.loadEnvFile(file);
  console.log(`env: ${file}`);
  console.log(`KV : ${maskKvHost(process.env.KV_REST_API_URL)}`);
  if (!existsSync(testnetFile)) {
    console.log(
      '⚠️ .env.local.testnet が無いため .env.local を使用中。上の KV が本番なら中断し、testnet 用 env を用意してください。',
    );
  }
  return file;
}
